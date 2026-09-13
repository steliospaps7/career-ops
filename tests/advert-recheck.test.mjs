/**
 * tests/advert-recheck.test.mjs — the recheck, preserving decisions (ticket C, C5).
 *
 * `--read-pipeline --gate` re-gates every pending line on every run under the
 * current rules and rewrites a line only when its segments change. A line moved
 * to Processed keeps every cell and its `triage:` segment, so the earlier
 * verdict stays readable beside the new reason. A second run on the same input
 * changes nothing, and the tracker is read, never written.
 *
 * The spec's `keep:` marker is not built: Stelios said on 13 September that he
 * does not use it and does not want it. There is no case for it here.
 *
 * Also the two small items carried from the review of "B3 into the fork":
 * `insertJdSegment` gains a replace path, which the recheck now uses instead of
 * a raw replace.
 *
 * Nothing here touches the network and nothing touches the real queue.
 *
 * Run: node test-all.mjs --only advert-recheck
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readPipelineAdverts,
  buildAdvertGate,
  collectTrackerDedupIndex,
  buildCompanyCanonicalizer,
  formatRecheckSummary,
  insertJdSegment,
  extractJdSegment,
} from '../scan.mjs';
import { parseTiersTable } from '../providers/_role-route.mjs';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — the recheck preserves decisions (ticket C, C5)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'co-recheck-'));
  dirs.push(d);
  return d;
}

function pipelineFile(pending, processed = []) {
  const p = join(tempDir(), 'pipeline.md');
  writeFileSync(p, ['# Pipeline — Pending URLs', '', '## Pending', '', ...pending, '', '## Processed', '', ...processed, ''].join('\n'));
  return p;
}

function sections(text) {
  const lines = text.split('\n');
  const pendAt = lines.findIndex(l => l.trim() === '## Pending');
  const procAt = lines.findIndex(l => l.trim() === '## Processed');
  return {
    pending: lines.slice(pendAt + 1, procAt).filter(l => l.trim()),
    processed: lines.slice(procAt + 1).filter(l => l.trim()),
  };
}

// Super Payments' own sentences, from the 11 September audit.
const SUPER = 'We\'d love it if you have 3–5+ years of product management experience in a fast-moving company. '
  + 'This does not preclude applications from candidates with more or less experience. '.repeat(2);
const BCG = 'What You\'ll Bring - 5–7 years of relevant experience as a product manager or in a comparable product role. '.repeat(2);
const FOUR = 'You must have at least 4 years of product management experience. '.repeat(2);

const TIERS = parseTiersTable('name\tnotes\ttier\nSuper Payments\t\t3\nBoston Consulting Group\t\t');

const gate = buildAdvertGate({});

function recheck(p, texts, extra = {}) {
  return readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    storedStatus: (rel) => (texts[rel] != null ? 'read' : 'unreadable'),
    storedText: (rel) => texts[rel] || '',
    readEntry: async () => { throw new Error('should not be read'); },
    today: '2026-09-13',
    ...extra,
  });
}

const superLine = '- [ ] https://jobs.ashbyhq.com/super/1 | Super Payments | Product Manager | London | triage: PASS 3.9 | jd: local:jds/super.md | route: standard';
const bcgLine = '- [ ] https://www.linkedin.com/jobs/view/2 | Boston Consulting Group | Global Product Manager | London, England, United Kingdom | triage: PASS 4.0 | jd: local:jds/bcg.md | route: standard | note: from LinkedIn';
const fourLine = '- [ ] https://jobs.example/4 | Four Co | Product Manager | London | jd: local:jds/four.md';
const texts = { 'jds/super.md': SUPER, 'jds/bcg.md': BCG, 'jds/four.md': FOUR };

// ── A triage: PASS row the new rule keeps is left exactly as it was ──
{
  const p = pipelineFile([superLine]);
  const old = new Date('2026-09-01T09:00:00Z');
  utimesSync(p, old, old);
  const counts = await recheck(p, texts);
  const out = sections(readFileSync(p, 'utf-8'));
  eq('Super Payments stays pending', out.pending.length, 1);
  eq('its line is untouched, triage: segment and all', out.pending[0], superLine);
  eq('it is counted unchanged', counts.unchanged, 1);
  eq('and nothing is counted changed', counts.changed, 0);
  eq('a run that changes nothing does not rewrite the file', statSync(p).mtimeMs, old.getTime());
}

// ── A triage: PASS row the new rule drops keeps every cell ──────────
{
  const p = pipelineFile([bcgLine, superLine], ['- [x] https://old.example/1 | Old Co | Analyst | applied 4 Sep 2026']);
  const counts = await recheck(p, texts);
  const out = sections(readFileSync(p, 'utf-8'));
  eq('BCG is dropped on its years sentence', counts.drops.rows[0]?.reason, 'years');
  eq('it leaves Pending', out.pending.length, 1);
  eq('the older Processed line stays first', out.processed[0], '- [x] https://old.example/1 | Old Co | Analyst | applied 4 Sep 2026');
  const moved = out.processed[1] || '';
  ok('the moved line keeps every cell and its triage: verdict, then the reason',
    moved.startsWith(`${bcgLine.replace('- [ ]', '- [x]')} | skipped (years: "`));
  ok('the reason names the sentence and the date', moved.includes('5–7 years of relevant experience') && moved.endsWith(', 2026-09-13)'));
  ok('the earlier verdict is still readable beside it', moved.includes('| triage: PASS 4.0 |'));
  eq('the moved row is counted as moved, not changed', counts.moved, 1);
  eq('the kept row is unchanged', counts.unchanged, 1);
}

// ── A line whose segments change is rewritten; a second run is byte-identical ──
{
  const p = pipelineFile([fourLine, superLine, bcgLine]);
  const first = await recheck(p, texts);
  const afterFirst = readFileSync(p, 'utf-8');
  const out = sections(afterFirst);
  eq('the four-year line gains its label and route', out.pending[0], `${fourLine} | years: 4 | route: standard`);
  eq('one line changed', first.changed, 1);
  eq('one line unchanged', first.unchanged, 1);
  eq('one line moved', first.moved, 1);

  const old = new Date('2026-09-02T09:00:00Z');
  utimesSync(p, old, old);
  const second = await recheck(p, texts);
  eq('a second run changes nothing', readFileSync(p, 'utf-8'), afterFirst);
  eq('and counts every pending line unchanged', second.unchanged, 2);
  eq('nothing changed', second.changed, 0);
  eq('nothing moved', second.moved, 0);
  eq('and the file was not rewritten', statSync(p).mtimeMs, old.getTime());
}

// ── A rule change re-gates a line already labelled ──────────────────
{
  // The same line judged last week on a stub, now read: the stored text wins.
  const line = '- [ ] https://jobs.example/9 | Four Co | Product Manager | London | jd: local:jds/four.md | route: review';
  const p = pipelineFile([line]);
  const counts = await recheck(p, texts);
  eq('a review line whose advert is now read is relabelled', sections(readFileSync(p, 'utf-8')).pending[0],
    '- [ ] https://jobs.example/9 | Four Co | Product Manager | London | jd: local:jds/four.md | years: 4 | route: standard');
  eq('and counted changed', counts.changed, 1);
}

// ── The tracker is read, never written ──────────────────────────────
{
  const root = tempDir();
  mkdirSync(join(root, 'data'), { recursive: true });
  const trackerPath = join(root, 'data', 'applications.md');
  const trackerText = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 51 | 2026-09-10 | Super Payments | Product Manager | 3.9/5 | Applied | ❌ | — | |',
    '',
  ].join('\n');
  writeFileSync(trackerPath, trackerText);
  const canonicalize = buildCompanyCanonicalizer({});
  const trackerIndex = collectTrackerDedupIndex({ applicationsText: trackerText, trackerPath, canonicalize });
  const p = pipelineFile([superLine]);
  const counts = await recheck(p, texts, { trackerIndex, canonicalizeCompany: canonicalize });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('a tracked role is moved as a duplicate', counts.duplicates, 1);
  ok('keeping every cell and its triage: segment', (out.processed[0] || '').startsWith(`${superLine.replace('- [ ]', '- [x]')} | `));
  eq('the tracker is byte-identical', readFileSync(trackerPath, 'utf-8'), trackerText);
}

// ── The summary says Unchanged, not Already labelled ────────────────
{
  const lines = formatRecheckSummary({ unchanged: 70, changed: 2, moved: 19 });
  ok('the summary counts unchanged rows', lines.some(l => /^Unchanged:\s+70 rows$/.test(l)));
  ok('and rewritten rows', lines.some(l => /^Relabelled:\s+2 rows$/.test(l)));
  ok('one row reads as one row', formatRecheckSummary({ unchanged: 1, changed: 0 }).some(l => /^Unchanged:\s+1 row$/.test(l)));
  const source = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  ok('the run no longer prints "Already labelled"', !source.includes('Already labelled:'));
  ok('there is no keep: marker in the recheck', !/keep:/.test(source));
}

// ── insertJdSegment: append by default, replace when asked ──────────
{
  const line = '- [ ] local:jds/bcg-apify.md | BCG | Global Product Manager | London | jd: local:jds/bcg-stub.md | route: standard | note: x';
  eq('a line that carries a segment is returned unchanged by default', insertJdSegment(line, 'jds/other.md'), line);
  const replaced = insertJdSegment(line, 'jds/bcg-apify.md', { replace: true });
  eq('the replace path repoints it in place', replaced, line.replace('jd: local:jds/bcg-stub.md', 'jd: local:jds/bcg-apify.md'));
  eq('and reads back', extractJdSegment(replaced), 'jds/bcg-apify.md');
  eq('replace on a line with no segment adds one, as the append path does',
    insertJdSegment('- [ ] https://a.example/1 | A | B | note: x', 'jds/a.md', { replace: true }),
    '- [ ] https://a.example/1 | A | B | jd: local:jds/a.md | note: x');
  const source = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  ok('the recheck no longer repoints jd: with a raw replace', !/line\.replace\(JD_SEGMENT_RE/.test(source));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
