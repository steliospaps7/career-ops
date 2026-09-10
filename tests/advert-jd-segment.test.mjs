/**
 * tests/advert-jd-segment.test.mjs — the `jd:` half of seam 6, ticket B1.
 *
 * The queue line keeps the real URL. The stored advert rides as a labelled
 * segment, `jd: local:jds/<file>`, like `posted:` and `note:` — never in the URL
 * column, because the apify plugin's `local:` swap is what breaks dedup and the
 * liveness gates, both of which match `http(s)://` only.
 *
 * The `route:` half of this seam belongs to B2.
 *
 * Run: node test-all.mjs --only advert-jd-segment
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  formatPipelineOffer,
  insertJdSegment,
  extractJdSegment,
  readPipelineAdverts,
  collectSeenUrls,
  formatUnreadableRow,
} from '../scan.mjs';
import { pass, fail, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — the jd: segment on the queue line (seam 6, B1 half)');

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
  const d = mkdtempSync(join(tmpdir(), 'co-jd-segment-'));
  dirs.push(d);
  return d;
}

// ── formatPipelineOffer emits the segment and keeps the URL ─────────
{
  const line = formatPipelineOffer({
    url: 'https://careers.example.com/roles/42',
    company: 'Example Ltd',
    title: 'Programme Manager',
    location: 'London',
    jdPath: 'jds/example-ltd-programme-manager-0123456789.md',
  });
  ok('the line carries the jd: segment', line.includes('| jd: local:jds/example-ltd-programme-manager-0123456789.md'));
  ok('the URL column is still the posting URL', line.startsWith('- [ ] https://careers.example.com/roles/42 |'));
  ok('the URL column is not a local path', !line.includes('- [ ] local:'));
}
{
  const line = formatPipelineOffer({
    url: 'https://careers.example.com/roles/42',
    company: 'Example Ltd',
    title: 'Programme Manager',
    jdPath: 'jds/x-0123456789.md',
    note: 'flagged by hand',
  });
  const jdAt = line.indexOf('| jd:');
  const noteAt = line.indexOf('| note:');
  ok('jd: comes before note:, like posted: and trust:', jdAt > -1 && noteAt > -1 && jdAt < noteAt);
}
{
  // An offer with no stored advert produces a byte-identical line to before.
  const offer = { url: 'https://careers.example.com/roles/42', company: 'Example Ltd', title: 'Programme Manager' };
  eq(
    'no stored advert means no segment',
    formatPipelineOffer(offer),
    '- [ ] https://careers.example.com/roles/42 | Example Ltd | Programme Manager',
  );
}

// ── Dedup still reads the URL, with the segment present ─────────────
{
  const pipelineText = '## Pending\n- [ ] https://careers.example.com/roles/42 | Example Ltd | Programme Manager | jd: local:jds/x-0123456789.md\n';
  const { seen } = collectSeenUrls({ pipelineText });
  ok('the posting URL is still the dedup key', seen.size > 0);
}

// ── insertJdSegment / extractJdSegment ──────────────────────────────
{
  const bare = '- [ ] https://careers.example.com/roles/42 | Example Ltd | Programme Manager';
  const withJd = insertJdSegment(bare, 'jds/x-0123456789.md');
  ok('a bare line gains the segment', withJd.endsWith('| jd: local:jds/x-0123456789.md'));
  eq('the URL survives', withJd.split('|')[0].trim(), '- [ ] https://careers.example.com/roles/42');
  eq('reading it back gives the path', extractJdSegment(withJd), 'jds/x-0123456789.md');
  eq('a second insert changes nothing', insertJdSegment(withJd, 'jds/other-9999999999.md'), withJd);
  eq('a line without one reads as null', extractJdSegment(bare), null);

  const withNote = `${bare} | note: flagged`;
  const inserted = insertJdSegment(withNote, 'jds/x-0123456789.md');
  ok('the segment goes before note:', inserted.indexOf('| jd:') < inserted.indexOf('| note:'));
  ok('the note survives intact', inserted.endsWith('| note: flagged'));
}

// ── The standalone pass: node scan.mjs --read-pipeline ──────────────
{
  const dir = tempDir();
  const pipelinePath = join(dir, 'pipeline.md');
  writeFileSync(pipelinePath, [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '',
    '- [ ] https://careers.example.com/roles/42 | Example Ltd | Programme Manager',
    '- [ ] https://careers.example.com/roles/43 | Example Ltd | Delivery Lead | jd: local:jds/already-1111111111.md',
    '- [ ] https://careers.example.com/roles/44 | Other Ltd | Analyst',
    '',
    '## Processed',
    '',
    '- [x] https://careers.example.com/roles/9 | Old Ltd | Gone Role',
    '',
  ].join('\n'));

  let lockHeld = false;
  const asked = [];
  const result = await readPipelineAdverts({
    pipelinePath,
    readEntry: async (entry) => {
      lockHeld = lockHeld || existsSync(`${pipelinePath}.lock`);
      asked.push(entry.url);
      if (entry.url.endsWith('/44')) {
        return { status: 'unreadable', rung: null, jdPath: 'jds/other-ltd-analyst-4444444444.md', failedAs: 'blocked', failedAt: 'browser', reachedFirecrawl: true };
      }
      return { status: 'read', rung: 'page', jdPath: 'jds/example-ltd-programme-manager-4242424242.md', reachedFirecrawl: false };
    },
  });

  const after = readFileSync(pipelinePath, 'utf-8');
  const lines = after.split('\n');

  ok('the lock was held while the pass ran', lockHeld);
  eq('only the two pending lines without a jd: were read', asked.length, 2);
  ok('the Processed line was never read', asked.every(u => !u.endsWith('/roles/9')));
  ok('the line already carrying a jd: was never read', asked.every(u => !u.endsWith('/roles/43')));

  const line42 = lines.find(l => l.includes('/roles/42'));
  ok('the read line gained its jd: segment', line42.includes('| jd: local:jds/example-ltd-programme-manager-4242424242.md'));
  ok('and kept its URL', line42.includes('https://careers.example.com/roles/42'));

  const line43 = lines.find(l => l.includes('/roles/43'));
  eq('the line that already had one is byte-identical', line43, '- [ ] https://careers.example.com/roles/43 | Example Ltd | Delivery Lead | jd: local:jds/already-1111111111.md');

  const line44 = lines.find(l => l.includes('/roles/44'));
  ok('an unreadable row is kept and labelled, never dropped', line44.includes('| jd: local:jds/other-ltd-analyst-4444444444.md'));

  const line9 = lines.find(l => l.includes('/roles/9'));
  eq('the Processed line is untouched', line9, '- [x] https://careers.example.com/roles/9 | Old Ltd | Gone Role');

  ok('the Processed section is still there', after.includes('## Processed'));
  eq('the pass reports what it read', result.read, 1);
  eq('and what it could not', result.unreadable, 1);
  eq('and the residue that would have reached the paid rung', result.firecrawlResidue, 1);
  eq('and what it skipped', result.skipped, 1);
}

// ── B1 has no --gate, so nothing moves to Processed ─────────────────
{
  const dir = tempDir();
  const pipelinePath = join(dir, 'pipeline.md');
  const before = [
    '## Pending',
    '',
    '- [ ] https://careers.example.com/roles/42 | Example Ltd | Programme Manager',
    '',
    '## Processed',
    '',
  ].join('\n');
  writeFileSync(pipelinePath, before);
  await readPipelineAdverts({
    pipelinePath,
    readEntry: async () => ({ status: 'read', rung: 'page', jdPath: 'jds/x-4242424242.md', reachedFirecrawl: false }),
  });
  const after = readFileSync(pipelinePath, 'utf-8');
  ok('the row stayed in Pending', after.indexOf('/roles/42') < after.indexOf('## Processed'));
  eq('one Pending section, one Processed section', after.split('## ').length, before.split('## ').length);
}

// ── The line Stelios reads for a row nobody could read ─────────────
{
  eq(
    'a fresh failure names the rung it died on',
    formatUnreadableRow({ company: 'Acme', title: 'Analyst', failedAs: 'blocked', failedAt: 'browser', url: 'https://x.example/1' }),
    'READ | Acme | Analyst | unreadable: blocked at browser | https://x.example/1',
  );
  eq(
    'a stored failure says so instead of repeating the word',
    formatUnreadableRow({ company: 'Acme', title: 'Analyst', failedAs: 'unreadable', failedAt: 'stored', url: 'https://x.example/1' }),
    'READ | Acme | Analyst | unreadable: read as unreadable on an earlier run, not re-read | https://x.example/1',
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
