// tests/empty-paid-feed-warning.test.mjs — a paid feed empty two runs running is named.
//
// Indeed returned nothing from 19 to 21 September 2026 while its reader
// reported success, and nothing in the run summary said so. The scan now reads
// the previous run's rows in the per-source log and prints one warning line
// for each paid feed that found nothing on both runs.
//
// The fixture's last two rows are copied from the 21 September 09:00 run;
// an older run sits before them, and later cases add a free-only run after.
import { pass, fail, ROOT } from './helpers.mjs';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nscan.mjs — empty paid feed warning');

const {
  createSourceLedger,
  readLastRunSources,
  emptyPaidFeedWarnings,
  SCAN_SOURCES_HEADER,
} = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const INDEED = 'Indeed UK (London, last day)';
const LINKEDIN = 'LinkedIn Jobs (London, last 24 hours)';

const dir = mkdtempSync(join(tmpdir(), 'career-ops-empty-feed-'));
try {
  const logPath = join(dir, 'scan-sources.tsv');
  writeFileSync(logPath, SCAN_SOURCES_HEADER
    + `2026-09-18T16:00:00.000Z\t${INDEED}\tcompany\tpaid\tok\t84\t0\t84\ttitle=84\t\n`
    + `2026-09-18T16:00:00.000Z\t${LINKEDIN}\tcompany\tpaid\tok\t175\t0\t175\ttitle=175\t\n`
    + `2026-09-21T08:03:42.560Z\t${INDEED}\tcompany\tpaid\tempty\t0\t0\t0\t\t\n`
    + `2026-09-21T08:03:42.560Z\t${LINKEDIN}\tcompany\tpaid\tok\t175\t3\t172\ttitle=150\t\n`);

  const previous = readLastRunSources(logPath);
  if (previous.get(INDEED)?.found === 0 && previous.get(LINKEDIN)?.found === 175
    && previous.get(INDEED)?.paid === true) {
    pass('readLastRunSources reads the newest row per source, not an older run (Indeed 0, not 84)');
  } else {
    fail(`readLastRunSources = ${JSON.stringify([...previous])}`);
  }

  // This run: both paid feeds empty. Only Indeed was also empty last time.
  const ledger = createSourceLedger();
  ledger.register(INDEED, { paid: true });
  ledger.register(LINKEDIN, { paid: true });
  ledger.register('Monzo');
  const warnings = emptyPaidFeedWarnings(ledger.records(), previous);
  if (warnings.length === 1 && warnings[0] === `WARNING: ${INDEED} empty two runs running`) {
    pass('a paid feed empty on this run and the last prints one warning line');
  } else {
    fail(`warnings = ${JSON.stringify(warnings)}`);
  }

  // This run: Indeed back with postings. No warning.
  const recovered = createSourceLedger();
  recovered.register(INDEED, { paid: true });
  recovered.found(INDEED, 77);
  if (emptyPaidFeedWarnings(recovered.records(), previous).length === 0) {
    pass('a paid feed with postings on this run prints no warning');
  } else {
    fail('a feed with 77 postings was warned about');
  }

  // A one-board hand run in between writes only a free source's row. The
  // paid feeds' last rows are still the 21 September ones, so Indeed warns.
  appendFileSync(logPath, '2026-09-21T10:00:00.000Z\tMonzo\tcompany\tfree\tok\t71\t0\t71\ttitle=71\t\n');
  const afterHandRun = readLastRunSources(logPath);
  const handRunWarnings = emptyPaidFeedWarnings(ledger.records(), afterHandRun);
  if (afterHandRun.get(INDEED)?.found === 0
    && handRunWarnings.length === 1 && handRunWarnings[0] === `WARNING: ${INDEED} empty two runs running`) {
    pass('a run with only a free source between two empty Indeed runs does not reset the count');
  } else {
    fail(`after the hand run, warnings = ${JSON.stringify(handRunWarnings)}`);
  }

  // A feed that errored found nothing too; the line names each run's status.
  const errored = createSourceLedger();
  errored.register(INDEED, { paid: true });
  errored.error(INDEED, 'Apify run did not finish within 180s');
  const errorWarnings = emptyPaidFeedWarnings(errored.records(), afterHandRun);
  if (errorWarnings.length === 1
    && errorWarnings[0] === `WARNING: ${INDEED} empty two runs running (last run empty, this run error)`) {
    pass('a feed that errored warns with the status of each run');
  } else {
    fail(`error warnings = ${JSON.stringify(errorWarnings)}`);
  }

  // No log yet (first run ever): nothing to compare with, no warning.
  const none = readLastRunSources(join(dir, 'missing.tsv'));
  if (none.size === 0 && emptyPaidFeedWarnings(ledger.records(), none).length === 0) {
    pass('with no previous run in the log, no warning is printed');
  } else {
    fail('a missing log produced a warning or rows');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
