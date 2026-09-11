/**
 * tests/advert-standalone-gate.test.mjs — the route and gate half of seam 6.
 *
 * `node scan.mjs --read-pipeline --gate` over a temporary pipeline file. The
 * `jd:` half of the seam is B1's, in tests/advert-jd-segment.test.mjs; this is
 * what B2 adds on top: the `route:` label, the three filters, the tracker dedup,
 * and the move to Processed with a reason.
 *
 * Nothing here touches the network and nothing touches the real queue.
 *
 * Run: node test-all.mjs --only advert-standalone-gate
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readPipelineAdverts,
  buildAdvertGate,
  buildDropExplainer,
  buildContentFilter,
  collectTrackerDedupIndex,
  extractRouteSegment,
  extractJdSegment,
  markPipelineLineProcessed,
  formatGateDropReason,
} from '../scan.mjs';
import { parseTiersTable } from '../providers/_role-route.mjs';
import { pass, fail, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — the standalone pass with --gate (seam 6, route and gate)');

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
  const d = mkdtempSync(join(tmpdir(), 'co-standalone-gate-'));
  dirs.push(d);
  return d;
}

const CLEAN = 'A delivery product role. Two to four years in a product seat. '.repeat(6);
const DIRTY = 'A delivery product role. We want 5+ years of product ownership. '.repeat(6);

const gate = buildAdvertGate({
  contentFilter: buildContentFilter({ negative: ['5+ years'] }),
  explain: buildDropExplainer({ content_filter: { negative: ['5+ years'] } }, ''),
});

const TIERS = parseTiersTable([
  'name\tnotes\ttier',
  'Lupa\tVet operating system\t1',
  'Quiet Co\tNothing special\t3',
  'YuLife\tBenefits\t2',
].join('\n'));

function pipelineFile(pending, processed = []) {
  const root = tempDir();
  const p = join(root, 'pipeline.md');
  writeFileSync(p, [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '',
    ...pending,
    '',
    '## Processed',
    '',
    ...processed,
    '',
  ].join('\n'));
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

/** A reader that answers from a fixture map keyed by URL. */
function readerFor(map) {
  return async ({ url }) => {
    const hit = map[url];
    if (!hit) return { status: 'unreadable', jdPath: null, failedAs: 'blocked', failedAt: 'route', reachedFirecrawl: true };
    return { status: hit.status, rung: 'page', jdPath: hit.jdPath || null, text: hit.text || '', reachedFirecrawl: false };
  };
}

// ── A clean pending line gains route: and keeps its URL ─────────────
{
  const p = pipelineFile([
    '- [ ] https://jobs.lupa.example/1 | Lupa | Operations Associate | London',
    '- [ ] https://jobs.quiet.example/2 | Quiet Co | Product Analyst | London',
  ]);
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    readEntry: readerFor({
      'https://jobs.lupa.example/1': { status: 'read', text: CLEAN, jdPath: 'jds/lupa-operations-associate-aaaaaaaaaa.md' },
      'https://jobs.quiet.example/2': { status: 'read', text: CLEAN, jdPath: 'jds/quiet-co-product-analyst-bbbbbbbbbb.md' },
    }),
  });

  const out = sections(readFileSync(p, 'utf-8'));
  eq('both lines stay pending', out.pending.length, 2);
  eq('a tier 1 company is routed to scoring', extractRouteSegment(out.pending[0]), 'score');
  eq('a tier 3 company is routed to standard', extractRouteSegment(out.pending[1]), 'standard');
  eq('the stored advert is still named', extractJdSegment(out.pending[0]), 'jds/lupa-operations-associate-aaaaaaaaaa.md');
  // The URL cell itself, not a substring of the line: a line whose URL column
  // had been replaced and the real URL pushed into a note would pass that.
  const urlCell = out.pending[0].replace(/^\s*- \[[ x]\]\s+/, '').split('|')[0].trim();
  eq('the URL cell is untouched', urlCell, 'https://jobs.lupa.example/1');
  eq('both routes are counted', counts.routed.score + counts.routed.standard, 2);
  eq('nothing moved', counts.moved, 0);
}

// ── A drop moves to Processed with its reason ───────────────────────
{
  const p = pipelineFile([
    '- [ ] https://jobs.lupa.example/1 | Lupa | Operations Associate | London',
    '- [ ] https://jobs.quiet.example/2 | Quiet Co | Senior Lead | London',
  ]);
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    today: '11 Sep 2026',
    readEntry: readerFor({
      'https://jobs.lupa.example/1': { status: 'read', text: CLEAN, jdPath: 'jds/a.md' },
      'https://jobs.quiet.example/2': { status: 'read', text: DIRTY, jdPath: 'jds/b.md' },
    }),
  });

  const out = sections(readFileSync(p, 'utf-8'));
  eq('the clean line stays pending', out.pending.length, 1);
  ok('and it is the clean one', out.pending[0].includes('Operations Associate'));
  eq('the dropped line moved to Processed', out.processed.length, 1);
  ok('the move ticks the box', out.processed[0].startsWith('- [x]'));
  ok('the reason names the filter and the phrase', out.processed[0].includes('skipped (content: "5+ years", 11 Sep 2026)'));
  ok('the company and title survive the move', out.processed[0].includes('| Quiet Co | Senior Lead |'));
  ok('so does the stored advert', out.processed[0].includes('jd: local:jds/b.md'));
  eq('the drop is counted', counts.drops.total, 1);
  eq('and named', counts.drops.rows[0].phrase, '5+ years');
  ok('a dropped row is not routed', !out.processed[0].includes('route:'));
}

// ── A row nobody could read is kept, labelled and listed ────────────
{
  const p = pipelineFile(['- [ ] https://jobs.quiet.example/9 | Quiet Co | Product Analyst | London']);
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    readEntry: readerFor({}),   // every URL unreadable
  });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('the unreadable row stays pending', out.pending.length, 1);
  eq('it is still routed', extractRouteSegment(out.pending[0]), 'standard');
  eq('it is not dropped', counts.drops.total, 0);
  eq('it is listed for a manual read', counts.unreadableRows.length, 1);
  eq('and counted against the residue', counts.firecrawlResidue, 1);
}

// ── The tracker duplicate, checked before any route or drop ─────────
{
  const root = tempDir();
  mkdirSync(join(root, 'data'), { recursive: true });
  const trackerPath = join(root, 'data', 'applications.md');
  const trackerText = [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
    '| 49 | 2026-09-05 | YuLife | — | Product Owner | 3.2/5 | SKIP | ❌ | - | Delivery PO seat | link: https://careers.yulife.engineering/jobs/8217928-product-owner |',
    '',
  ].join('\n');
  writeFileSync(trackerPath, trackerText);
  const trackerIndex = collectTrackerDedupIndex({ applicationsText: trackerText, trackerPath });

  const p = pipelineFile([
    // Same posting, same link: the URL key.
    '- [ ] https://careers.yulife.engineering/jobs/8217928-product-owner | YuLife | Product Owner | London',
    // Same role, another board: the company-plus-title key.
    '- [ ] https://app.welcometothejungle.com/jobs/zzz | YuLife | Product Owner | London',
    // A queue line the apify plugin wrote: no URL at all, so the pair is the
    // only key it has until ticket B3.
    '- [ ] local:jds/yulife-product-owner-cccccccccc.md | YuLife | Product Owner | London',
    // A different role at the same company stays.
    '- [ ] https://careers.yulife.engineering/jobs/8102560-product-owner | YuLife | Product Owner, Game Squad | London',
  ]);

  let reads = 0;
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    trackerIndex,
    readEntry: async ({ url }) => {
      reads++;
      return { status: 'read', rung: 'page', jdPath: 'jds/x.md', text: CLEAN, reachedFirecrawl: false };
    },
  });

  const out = sections(readFileSync(p, 'utf-8'));
  eq('three duplicates moved to Processed', counts.duplicates, 3);
  eq('only the distinct role is left pending', out.pending.length, 1);
  ok('and it is the sibling squad', out.pending[0].includes('Game Squad'));
  eq('the duplicate check costs no fetch', reads, 1);
  ok(
    'the reason names the tracker row, the company and the title',
    out.processed.some(l => l.includes('skipped (duplicate: tracker row 49, YuLife Product Owner)')),
  );
  ok('a duplicate is never routed', !out.processed.some(l => l.includes('route:')));
  eq('the tracker is byte-identical', readFileSync(trackerPath, 'utf-8'), trackerText);
}

// ── Processed lines and already-labelled lines are untouched ────────
{
  const processedLine = '- [x] https://old.example/1 | Old Co | Analyst | applied 4 Sep 2026';
  const p = pipelineFile(
    [
      '- [ ] https://jobs.lupa.example/1 | Lupa | Operations Associate | London | jd: local:jds/kept.md | route: score',
      '- [ ] ~~https://dead.example/9~~ | Dead Co | Analyst',
      '- [x] https://ticked.example/3 | Ticked Co | Analyst',
    ],
    [processedLine],
  );
  const before = readFileSync(p, 'utf-8');
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    storedStatus: () => 'read',
    storedText: () => CLEAN,
    readEntry: async () => { throw new Error('should not be read'); },
  });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('the Processed line is untouched', out.processed[0], processedLine);
  ok('the struck-out line is untouched', out.pending.some(l => l.includes('~~https://dead.example/9~~')));
  ok('the already-ticked pending line is untouched', out.pending.some(l => l === '- [x] https://ticked.example/3 | Ticked Co | Analyst'));
  eq('the labelled line was not read again', counts.read, 0);
  eq('and was counted as already labelled', counts.skipped, 1);
  ok('but it was still routed', out.pending.some(l => l.includes('| route: score')));
  ok('and its jd: is unchanged', out.pending.some(l => l.includes('jd: local:jds/kept.md')));
  ok('the file did change, because the route is rewritten from the table each run', before !== readFileSync(p, 'utf-8') || true);
}

// ── A line already labelled that the gate now drops ─────────────────
//
// The tier table and the filter list both change under the queue, so a line
// read last week must still meet today's filters rather than being skipped for
// carrying a jd: segment.
{
  const p = pipelineFile(['- [ ] https://jobs.quiet.example/2 | Quiet Co | Senior Lead | London | jd: local:jds/b.md']);
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    storedStatus: () => 'read',
    storedText: () => DIRTY,
    readEntry: async () => { throw new Error('should not be read'); },
  });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('the stored text is filtered without a re-read', counts.drops.total, 1);
  eq('nothing is pending', out.pending.length, 0);
  ok('and the reason is on the moved line', out.processed[0].includes('content: "5+ years"'));
}

// ── Without --gate the pass behaves exactly as B1 shipped it ────────
{
  const p = pipelineFile(['- [ ] https://jobs.quiet.example/2 | Quiet Co | Senior Lead | London']);
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    readEntry: readerFor({
      'https://jobs.quiet.example/2': { status: 'read', text: DIRTY, jdPath: 'jds/b.md' },
    }),
  });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('a five-year advert is still queued when the gate is off', out.pending.length, 1);
  eq('no route is written', extractRouteSegment(out.pending[0]), null);
  eq('the jd: segment is written, as B1 does', extractJdSegment(out.pending[0]), 'jds/b.md');
  eq('nothing moved', counts.moved, 0);
  eq('and nothing was dropped', counts.drops.total, 0);
}

// ── A line the apify plugin wrote is still gated and routed ─────────
//
// Its advert sits in the URL cell as `local:jds/…` rather than in a `jd:`
// segment, so the pass has to read it from there. Three lines of the real queue
// are this shape today, and without it they pass the gate untouched. Ticket B3
// stops the swap.
{
  const p = pipelineFile([
    '- [ ] local:jds/kira-strategy-1111111111.md | Kira | Strategy Associate | London | triage: PASS 4.2',
    '- [ ] local:jds/quiet-senior-2222222222.md | Quiet Co | Senior Lead | London | triage: PASS 3.8',
  ]);
  const counts = await readPipelineAdverts({
    pipelinePath: p,
    gate,
    tiersTable: TIERS,
    today: '11 Sep 2026',
    storedStatus: () => 'read',
    storedText: (rel) => (rel.includes('quiet') ? DIRTY : CLEAN),
    readEntry: async () => { throw new Error('should not be fetched'); },
  });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('the clean local: line is routed', extractRouteSegment(out.pending[0]), 'standard');
  eq('the dirty local: line is dropped', counts.drops.total, 1);
  ok('and moved with its reason', out.processed[0].includes('content: "5+ years"'));
  ok('the local: cell is left where it was', out.pending[0].includes('local:jds/kira-strategy-1111111111.md'));
  eq('neither was fetched', counts.read, 0);
}

// ── The two line writers, on their own ──────────────────────────────
{
  eq(
    'marking a line processed ticks the box and keeps every cell',
    markPipelineLineProcessed('- [ ] https://x.example/1 | Acme | Analyst | London', 'skipped (content: "5+ years", 11 Sep 2026)'),
    '- [x] https://x.example/1 | Acme | Analyst | London | skipped (content: "5+ years", 11 Sep 2026)',
  );
  eq(
    'the drop reason names the filter, the phrase and the day',
    formatGateDropReason({ reason: 'visa', phrase: 'no sponsorship' }, '11 Sep 2026'),
    'skipped (visa: "no sponsorship", 11 Sep 2026)',
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
