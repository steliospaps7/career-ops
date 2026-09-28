// tests/empty-paid-feed-warning.test.mjs — a paid feed under 5 two runs running is named.
//
// Indeed returned nothing from 19 to 21 September 2026 while its reader
// reported success, and nothing in the run summary said so. The scan now reads
// the previous run's rows in the per-source log and prints one warning line
// for each paid feed under 5 on both runs, in the old "empty" wording when
// both are 0.
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
  NEAR_EMPTY_PAID_FEED,
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

  // Near empty: under NEAR_EMPTY_PAID_FEED (5) on both runs. Indeed found 1, 1
  // and 9 on 27 and 28 September 2026 and the empty line said nothing.
  function nearEmpty(lastFound, thisFound, withHandRun = false, lastStatus = lastFound === 0 ? 'empty' : 'ok') {
    const p = join(dir, `near-${lastFound}-${thisFound}-${withHandRun}-${lastStatus}.tsv`);
    writeFileSync(p, SCAN_SOURCES_HEADER
      + `2026-09-27T16:03:00.000Z\t${INDEED}\tcompany\tpaid\t${lastStatus}\t${lastFound}\t0\t${lastFound}\t\t\n`
      + (withHandRun ? '2026-09-27T18:00:00.000Z\tMonzo\tcompany\tfree\tok\t71\t0\t71\ttitle=71\t\n' : ''));
    const run = createSourceLedger();
    run.register(INDEED, { paid: true });
    if (thisFound > 0) run.found(INDEED, thisFound);
    return emptyPaidFeedWarnings(run.records(), readLastRunSources(p));
  }

  const oneOne = nearEmpty(1, 1);
  const oneOneLine = `WARNING: ${INDEED} under 5 two runs running (last run ok 1, this run ok 1)`;
  if (NEAR_EMPTY_PAID_FEED === 5 && oneOne.length === 1 && oneOne[0] === oneOneLine) {
    pass('1 then 1 prints the under-5 line with each run\'s status and count');
  } else {
    fail(`1 then 1 = ${JSON.stringify(oneOne)}`);
  }

  const zeroZero = nearEmpty(0, 0);
  if (zeroZero.length === 1 && zeroZero[0] === `WARNING: ${INDEED} empty two runs running`) {
    pass('0 then 0 keeps the empty line, unchanged');
  } else {
    fail(`0 then 0 = ${JSON.stringify(zeroZero)}`);
  }

  const fourFive = nearEmpty(4, 5);
  if (fourFive.length === 0) {
    pass('4 then 5 prints nothing (5 is not under 5)');
  } else {
    fail(`4 then 5 = ${JSON.stringify(fourFive)}`);
  }

  const nineOne = nearEmpty(9, 1);
  if (nineOne.length === 0) {
    pass('9 then 1 prints nothing (one low run is not two)');
  } else {
    fail(`9 then 1 = ${JSON.stringify(nineOne)}`);
  }

  const mixed = [
    [0, 3, 'ok', `WARNING: ${INDEED} under 5 two runs running (last run empty 0, this run ok 3)`],
    [3, 0, 'ok', `WARNING: ${INDEED} under 5 two runs running (last run ok 3, this run empty 0)`],
  ];
  for (const [a, b, , want] of mixed) {
    const got = nearEmpty(a, b);
    if (got.length === 1 && got[0] === want) {
      pass(`${a} then ${b} prints the under-5 line, not the empty one`);
    } else {
      fail(`${a} then ${b} = ${JSON.stringify(got)}`);
    }
  }
  const errorThenTwo = nearEmpty(0, 2, false, 'error');
  if (errorThenTwo.length === 1
    && errorThenTwo[0] === `WARNING: ${INDEED} under 5 two runs running (last run error 0, this run ok 2)`) {
    pass('an errored last run at 0, then 2, names the error status in the under-5 line');
  } else {
    fail(`error 0 then 2 = ${JSON.stringify(errorThenTwo)}`);
  }

  // A last row with a blank count column is not a count: no warning.
  const blankPath = join(dir, 'near-blank.tsv');
  writeFileSync(blankPath, SCAN_SOURCES_HEADER
    + `2026-09-27T16:03:00.000Z\t${INDEED}\tcompany\tpaid\tok\t\t0\t0\t\t\n`);
  const blankRun = createSourceLedger();
  blankRun.register(INDEED, { paid: true });
  blankRun.found(INDEED, 1);
  const blank = emptyPaidFeedWarnings(blankRun.records(), readLastRunSources(blankPath));
  if (blank.length === 0) {
    pass('a last row with a blank count, then 1, prints no line');
  } else {
    fail(`blank then 1 = ${JSON.stringify(blank)}`);
  }

  const walked = nearEmpty(1, 1, true);
  if (walked.length === 1 && walked[0] === oneOneLine) {
    pass('a one-board hand run between two runs of 1 is walked past, and the under-5 line prints');
  } else {
    fail(`1, hand run, 1 = ${JSON.stringify(walked)}`);
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
