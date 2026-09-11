/**
 * tests/advert-scan-wiring.test.mjs — how the scan counts and drops what the
 * reader hands it. The build review of B1 found four faults here; this is the
 * file that keeps them fixed.
 *
 * Nothing here touches the network: the reader's transports are injected and
 * the store is a temporary directory.
 *
 * Run: node test-all.mjs --only advert-scan-wiring
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildAdvertReader,
  formatReadSummary,
  advertReadDropsRow,
  readPipelineAdverts,
  createSourceLedger,
  reconcileSourceLedger,
  SOURCE_DROP_REASONS,
} from '../scan.mjs';
import { saveAdvert, advertFilename } from '../providers/_advert-reader.mjs';
import { pass, fail, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — the advert reader wired into the run');

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
  const d = mkdtempSync(join(tmpdir(), 'co-scan-wiring-'));
  dirs.push(d);
  return d;
}

const BODY = 'We are hiring a Programme Manager. '.repeat(20);
const JOB = { url: 'https://careers.example.com/roles/42', company: 'Example Ltd', title: 'Programme Manager', location: 'London' };

/** Transports that always fail, so the ladder ends unreadable without a network. */
const deadTransports = {
  fetchText: async () => { throw new Error('blocked'); },
  fetchJson: async () => { throw new Error('blocked'); },
  browser: async () => { throw new Error('blocked'); },
};

// ── An expired advert never reaches the three filters ───────────────
// The board's own page says the posting is gone. Passing that row on with an
// empty description is the silent pass this whole ticket exists to close.
{
  eq('an expired read drops the row', advertReadDropsRow('expired'), true);
  eq('a read one does not', advertReadDropsRow('read'), false);
  eq('and neither does an unreadable one — it is kept and listed', advertReadDropsRow('unreadable'), false);
  eq('nor an absent status', advertReadDropsRow(undefined), false);
}
{
  const keys = SOURCE_DROP_REASONS.map((r) => r.key);
  ok('the ledger carries a reason for it', keys.includes('advertExpired'));
  ok(
    'in sweep order: after salary, before content',
    keys.indexOf('advertExpired') > keys.indexOf('salary') && keys.indexOf('advertExpired') < keys.indexOf('content'),
  );
}
{
  // The reconciliation is what catches a counter added in one place and
  // forgotten in the other, and it runs on every real scan.
  const ledger = createSourceLedger();
  ledger.register('Acme');
  ledger.found('Acme', 3);
  ledger.keep('Acme');
  ledger.drop('Acme', 'advertExpired');
  ledger.drop('Acme', 'title');
  const clean = reconcileSourceLedger(ledger, { found: 3, kept: 1, advertExpired: 1, title: 1 });
  eq('the sum holds when the run total is passed', clean.length, 0);
  const short = reconcileSourceLedger(ledger, { found: 3, kept: 1, title: 1 });
  ok(
    'and it complains when the new reason is left out of the run totals',
    short.some((m) => m.field === 'advertExpired'),
  );
}

// ── A stored row that could not be read is counted honestly ─────────
// The residue count is the number Stelios decides the paid rung on. A row read
// yesterday and unreadable then would reach the paid rung again today, so a
// second run that forgot it would report a residue of zero and look like a fix.
{
  const jdsDir = join(tempDir(), 'jds');
  saveAdvert({ ...JOB, text: '', rung: null, status: 'unreadable', finalUrl: JOB.url, fetchedAt: '2026-09-10T09:00:00.000Z' }, { jdsDir });
  const reader = buildAdvertReader({ jdsDir, transports: deadTransports });
  const outcome = await reader.read(JOB);

  eq('the stored row is re-used, not re-fetched', outcome.reused, true);
  eq('and it still reads as unreadable', outcome.status, 'unreadable');
  eq('it counts against the Firecrawl residue', reader.tally.firecrawlResidue, 1);
  eq('and it is bucketed under its stored status', reader.tally.byFailure.unreadable, 1);
  eq('not under other', reader.tally.byFailure.other || 0, 0);
  eq('it counts as considered', reader.tally.considered, 1);
  eq('and as unreadable', reader.tally.unreadable, 1);
}
{
  // An expired posting is the exception: the ladder ends at the board's own
  // page, so nothing would have reached the paid rung.
  const jdsDir = join(tempDir(), 'jds');
  saveAdvert({ ...JOB, text: '', rung: 'page', status: 'expired', finalUrl: JOB.url, fetchedAt: '2026-09-10T09:00:00.000Z' }, { jdsDir });
  const reader = buildAdvertReader({ jdsDir, transports: deadTransports });
  await reader.read(JOB);
  eq('an expired row never counts as residue', reader.tally.firecrawlResidue, 0);
  eq('and it is bucketed as expired', reader.tally.byFailure.expired, 1);
}
{
  const jdsDir = join(tempDir(), 'jds');
  saveAdvert({ ...JOB, text: BODY, rung: 'page', status: 'read', finalUrl: JOB.url, fetchedAt: '2026-09-10T09:00:00.000Z' }, { jdsDir });
  const reader = buildAdvertReader({ jdsDir, transports: deadTransports });
  const outcome = await reader.read(JOB);
  eq('a stored read row comes back read', outcome.status, 'read');
  ok('with its text, without a fetch', outcome.text.includes('Programme Manager'));
  eq('counted under the rung that first read it', reader.tally.rungs.page, 1);
  eq('and never as residue', reader.tally.firecrawlResidue, 0);
}
{
  // A file the apify plugin wrote has no read_status and carries a paid advert.
  const jdsDir = join(tempDir(), 'jds');
  mkdirSync(jdsDir, { recursive: true });
  writeFileSync(join(jdsDir, advertFilename(JOB.company, JOB.title, JOB.url)), [
    '---', 'title: "Programme Manager"', 'company: "Example Ltd"',
    `url: "${JOB.url}"`, 'location: "London"', 'scraped: "2026-09-01"',
    'source: misceres-indeed-scraper', '---', '', '# Programme Manager — Example Ltd', '', BODY, '',
  ].join('\n'));
  const reader = buildAdvertReader({ jdsDir, transports: deadTransports });
  const outcome = await reader.read(JOB);
  eq('an apify advert reads as read', outcome.status, 'read');
  ok('and its text is used', outcome.text.includes('Programme Manager'));
  eq('never counted as residue', reader.tally.firecrawlResidue, 0);
}

// ── The summary reads as a sentence ─────────────────────────────────
{
  const tally = {
    considered: 92, read: 71, reused: 0,
    rungs: { page: 40, feed: 18, 'apply-link': 9, browser: 4, stored: 0 },
    unreadable: 21, byFailure: { blocked: 14, shell: 5, expired: 2, unreadable: 0, other: 0 },
    firecrawlResidue: 19, unreadableRows: [],
  };
  const lines = formatReadSummary(tally, { firecrawlEnabled: false });
  eq('three lines', lines.length, 3);
  ok('the first names what was read and how', lines[0].includes('71 of 92') && lines[0].includes('apply link 9'));
  ok('the second names what was not', lines[1].includes('21') && lines[1].includes('blocked 14'));
  ok('the third is the residue count', lines[2].includes('OFF') && lines[2].includes('19'));
  ok('and it says rows, not row(s)', lines[2].includes('19 rows') && !lines.join(' ').includes('row(s)'));
}
{
  const tally = {
    considered: 1, read: 1, reused: 0,
    rungs: { page: 1, feed: 0, 'apply-link': 0, browser: 0, stored: 0 },
    unreadable: 0, byFailure: {}, firecrawlResidue: 1, unreadableRows: [],
  };
  const lines = formatReadSummary(tally, { firecrawlEnabled: false });
  ok('one row reads as a singular', lines[2].includes('1 row would have reached it today'));
}
{
  const tally = {
    considered: 3, read: 0, reused: 0,
    rungs: { page: 0, feed: 0, 'apply-link': 0, browser: 0, stored: 0 },
    unreadable: 3, byFailure: { blocked: 1, unreadable: 2 }, firecrawlResidue: 3, unreadableRows: [],
  };
  const lines = formatReadSummary(tally, { firecrawlEnabled: false });
  ok('a bucket the fixed list never named is still printed', lines[1].includes('unreadable 2'));
  ok('beside the ones that were', lines[1].includes('blocked 1'));
}

// ── --reread re-reads the lines it is for ───────────────────────────
// Every line --reread exists for already carries a jd: segment, so skipping
// those unconditionally made the flag a no-op.
{
  const dir = tempDir();
  const pipelinePath = join(dir, 'pipeline.md');
  const base = [
    '## Pending', '',
    '- [ ] https://careers.example.com/roles/42 | Example Ltd | Programme Manager | jd: local:jds/read-1111111111.md',
    '- [ ] https://careers.example.com/roles/43 | Example Ltd | Delivery Lead | jd: local:jds/blocked-2222222222.md',
    '- [ ] https://careers.example.com/roles/44 | Other Ltd | Analyst',
    '', '## Processed', '',
  ].join('\n');
  const storedStatus = (relPath) => (relPath.includes('read-') ? 'read' : 'unreadable');

  writeFileSync(pipelinePath, base);
  const withoutFlag = [];
  await readPipelineAdverts({
    pipelinePath,
    storedStatus,
    readEntry: async (entry) => { withoutFlag.push(entry.url); return { status: 'read', rung: 'page', jdPath: 'jds/new-3333333333.md', reachedFirecrawl: false }; },
  });
  eq('without --reread, only the unlabelled line is read', withoutFlag.length, 1);
  ok('and it is the one with no jd:', withoutFlag[0].endsWith('/roles/44'));

  writeFileSync(pipelinePath, base);
  const withFlag = [];
  const counts = await readPipelineAdverts({
    pipelinePath,
    reread: true,
    storedStatus,
    readEntry: async (entry) => { withFlag.push(entry.url); return { status: 'read', rung: 'page', jdPath: 'jds/new-3333333333.md', reachedFirecrawl: false }; },
  });
  eq('with --reread, the row nobody could read is read again', withFlag.length, 2);
  ok('the unreadable one', withFlag.some((u) => u.endsWith('/roles/43')));
  ok('and the unlabelled one', withFlag.some((u) => u.endsWith('/roles/44')));
  ok('but never the one already read', withFlag.every((u) => !u.endsWith('/roles/42')));
  eq('the already-read line is still counted as skipped', counts.skipped, 1);

  const after = readFileSync(pipelinePath, 'utf-8');
  ok('a re-read line keeps one jd: segment, not two', after.split('\n').find((l) => l.includes('/roles/43')).match(/\| jd:/g).length === 1);
  ok('and the re-read line still points at its stored advert', after.includes('- [ ] https://careers.example.com/roles/43 | Example Ltd | Delivery Lead | jd: local:jds/blocked-2222222222.md'));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
