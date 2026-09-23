// tests/scan-source-ledger.test.mjs — the scan reports what each source did.
//
// The run summary is one row per RUN, so "twenty-one sources are configured"
// and "twenty-one sources were read" look identical from the outside. This
// suite covers the per-source breakdown that tells them apart: the terminal
// lines, the per-source log, and the reconciliation that keeps the breakdown
// honest as new drop reasons are added to the run totals.
//
// It asserts what the scan REPORTS, never how it counted: the record fields
// and the log rows, not the column padding, which is presentation and will
// change.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

console.log('\nscan.mjs — per-source ledger, log and reconciliation');

const {
  createSourceLedger,
  reconcileSourceLedger,
  formatSourceLine,
  appendScanSources,
  SCAN_SOURCES_HEADER,
  SOURCE_DROP_REASONS,
} = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

// ── 1. The reconciliation, which is the assertion the ledger exists for ──────
//
// Every drop reason the sweep counts must also be attributed to a source. A
// reason added to the run totals and forgotten here is the exact silent
// divergence this catches, so it is checked first and on its own.
{
  const ledger = createSourceLedger();
  ledger.register('A', { kind: 'board' });
  ledger.register('B', { kind: 'company', paid: true });
  ledger.found('A', 3);
  ledger.found('B', 2);
  ledger.keep('A');
  ledger.drop('A', 'title');
  ledger.drop('A', 'location');
  ledger.keep('B');
  ledger.drop('B', 'age');

  const agreeing = {
    found: 5, kept: 2, title: 1, location: 1, age: 1,
  };
  if (reconcileSourceLedger(ledger, agreeing).length === 0) {
    pass('reconcileSourceLedger reports no mismatch when the per-source totals sum to the run totals');
  } else {
    fail(`reconcileSourceLedger flagged an agreeing run: ${JSON.stringify(reconcileSourceLedger(ledger, agreeing))}`);
  }

  // A reason counted in the run totals and missed per source — the regression.
  const drifted = { ...agreeing, salary: 4 };
  const mismatches = reconcileSourceLedger(ledger, drifted);
  const salary = mismatches.find((m) => m.field === 'salary');
  if (mismatches.length === 1 && salary && salary.ledger === 0 && salary.run === 4) {
    pass('reconcileSourceLedger names a drop reason the run counted and the breakdown missed');
  } else {
    fail(`reconcileSourceLedger returned ${JSON.stringify(mismatches)}`);
  }

  // Every reason the sweep can count has a key here, in sweep order.
  const keys = SOURCE_DROP_REASONS.map((r) => r.key);
  const expected = [
    'blacklist', 'title', 'tier', 'location', 'age', 'postedDate',
    'salary',
    // The advert reader runs here, between the free filters and the three that
    // read the advert, and drops a posting whose own board page says it is gone.
    'advertExpired',
    // Ticket 6: a Welcome to the Jungle row whose advert came back empty.
    'advertEmpty',
    'content', 'countryEligibility', 'visa', 'duplicate', 'cooldown',
    // The fit judgement (ticket D2b) runs last in the sweep.
    'fit',
    // --verify runs after the whole sweep, so its drops come last.
    'expired',
  ];
  if (JSON.stringify(keys) === JSON.stringify(expected)) {
    pass('SOURCE_DROP_REASONS carries every sweep filter, in sweep order');
  } else {
    fail(`SOURCE_DROP_REASONS = ${JSON.stringify(keys)}`);
  }

  // An unknown reason is a programming error, not a silently-dropped count.
  let rejected = false;
  try { ledger.drop('A', 'invented'); } catch { rejected = true; }
  if (rejected) pass('ledger.drop rejects a reason key it does not know');
  else fail('ledger.drop accepted an unknown reason key');
}

// ── 2. Status resolution: silence is never the same as absence ───────────────
{
  const ledger = createSourceLedger();
  ledger.register('Quiet board', { kind: 'board' });
  ledger.register('Broken board', { kind: 'board' });
  ledger.register('Unmatched', { kind: 'company' });
  ledger.register('Busy board', { kind: 'board' });
  ledger.found('Busy board', 1);
  ledger.keep('Busy board');
  ledger.error('Broken board', 'board returned 503');
  ledger.skipped('Unmatched', 'no provider matched');

  const byName = Object.fromEntries(ledger.records().map((r) => [r.name, r]));
  if (byName['Quiet board'].status === 'empty' && byName['Quiet board'].found === 0) {
    pass('a source that returned nothing records zero found, not absence');
  } else {
    fail(`quiet board = ${JSON.stringify(byName['Quiet board'])}`);
  }
  if (byName['Broken board'].status === 'error' && /503/.test(byName['Broken board'].detail)) {
    pass('a source that errored records the error with its message');
  } else {
    fail(`broken board = ${JSON.stringify(byName['Broken board'])}`);
  }
  if (byName['Unmatched'].status === 'skipped') pass('a source no provider matched records as skipped');
  else fail(`unmatched = ${JSON.stringify(byName['Unmatched'])}`);
  if (byName['Busy board'].status === 'ok') pass('a source that returned postings records as ok');
  else fail(`busy board = ${JSON.stringify(byName['Busy board'])}`);

  // The terminal line carries the fields; the padding is not asserted.
  const busy = formatSourceLine(byName['Busy board']);
  if (busy.includes('Busy board') && /found 1/.test(busy) && /kept 1/.test(busy)) {
    pass('the terminal line names the source and carries found and kept');
  } else {
    fail(`terminal line = ${JSON.stringify(busy)}`);
  }
  const brokenLine = formatSourceLine(byName['Broken board']);
  if (brokenLine.includes('ERROR') && brokenLine.includes('board returned 503')) {
    pass('the terminal line for a broken source says ERROR and gives the reason');
  } else {
    fail(`broken line = ${JSON.stringify(brokenLine)}`);
  }
  const quietLine = formatSourceLine(byName['Quiet board']);
  if (/found 0/.test(quietLine) && /no postings returned/.test(quietLine)) {
    pass('the terminal line for a quiet source says so explicitly');
  } else {
    fail(`quiet line = ${JSON.stringify(quietLine)}`);
  }
}

// ── 2b. A degraded source, and a keep the verify pass takes back ────────────
{
  const ledger = createSourceLedger();
  ledger.register('Fallback board', { kind: 'company' });
  ledger.found('Fallback board', 2);
  ledger.keep('Fallback board');
  ledger.keep('Fallback board');
  ledger.degraded('Fallback board', 'local parser failed, used greenhouse API fallback: boom');

  const record = ledger.record('Fallback board');
  if (record.status === 'degraded' && record.found === 2 && record.kept === 2) {
    pass('a source rescued by the API fallback keeps its real counts and is not reported as ok');
  } else {
    fail(`degraded record = ${JSON.stringify(record)}`);
  }
  const line = formatSourceLine(record);
  if (/DEGRADED/.test(line) && /local parser failed/.test(line) && /found 2/.test(line)) {
    pass('the terminal line for a degraded source shows the counts and names the fault');
  } else {
    fail(`degraded line = ${JSON.stringify(line)}`);
  }

  // The verify pass drops a posting the sweep had already counted as kept.
  ledger.unkeep('Fallback board');
  ledger.drop('Fallback board', 'expired');
  const after = ledger.record('Fallback board');
  if (after.kept === 1 && after.dropped === 1 && after.reasons.expired === 1) {
    pass('a verify drop moves a posting out of kept and into the expired reason');
  } else {
    fail(`after unkeep = ${JSON.stringify(after)}`);
  }
  // The row must still balance: kept + dropped can never exceed what was found.
  if (after.kept + after.dropped === after.found) {
    pass('the row still balances after a verify drop');
  } else {
    fail(`kept ${after.kept} + dropped ${after.dropped} != found ${after.found}`);
  }
  // unkeep never runs a source negative, even if called more often than kept.
  ledger.unkeep('Fallback board');
  ledger.unkeep('Fallback board');
  if (ledger.record('Fallback board').kept === 0) pass('unkeep floors at zero');
  else fail(`kept went negative: ${ledger.record('Fallback board').kept}`);
}

// ── 3. The per-source log: one row per source per run, header written once ───
{
  const dir = mkdtempSync(join(tmpdir(), 'scan-sourcelog-'));
  try {
    const logPath = join(dir, 'logs', 'scan-sources.tsv');
    const ledger = createSourceLedger();
    ledger.register('Lupa', { kind: 'company' });
    ledger.register('Indeed UK', { kind: 'company', paid: true });
    ledger.found('Lupa', 2);
    ledger.keep('Lupa');
    ledger.drop('Lupa', 'title');
    ledger.found('Indeed UK', 1);
    ledger.drop('Indeed UK', 'location');

    appendScanSources(ledger.records(), '2026-09-08T09:00:00.000Z', logPath);
    appendScanSources(ledger.records(), '2026-09-09T09:00:00.000Z', logPath);

    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    if (lines[0] + '\n' === SCAN_SOURCES_HEADER) pass('the per-source log writes its header once, on creation');
    else fail(`log header = ${JSON.stringify(lines[0])}`);
    if (lines.length === 5) pass('a second run appends two more rows without a second header');
    else fail(`log has ${lines.length} lines, expected 5`);

    const first = lines[1].split('\t');
    const header = SCAN_SOURCES_HEADER.trim().split('\t');
    const row = Object.fromEntries(header.map((h, i) => [h, first[i]]));
    if (row.timestamp === '2026-09-08T09:00:00.000Z' && row.source === 'Lupa'
      && row.found === '2' && row.kept === '1' && row.dropped === '1'
      && row.drop_reasons === 'title=1' && row.paid === 'free' && row.status === 'ok') {
      pass('a per-source row carries the timestamp, source, counts and the drop reasons');
    } else {
      fail(`row = ${JSON.stringify(row)}`);
    }
    const paidRow = lines[2].split('\t');
    if (paidRow[3] === 'paid') pass('a source read through a paid reader is marked paid in the log');
    else fail(`paid column = ${JSON.stringify(paidRow[3])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. End to end: a real scan over fixture boards ───────────────────────────
//
// The unit checks above prove the arithmetic; this proves the wiring. A scan
// that printed its lines but wrote no rows to the log has not passed.
{
  const PORTALS = `title_filter:
  positive:
    - "Operations Associate"
location_filter:
  allow:
    - "London"
tracked_companies:
  - name: Mixed Board
    careers_url: https://boards.example.com/mixed
    parser:
      command: node
      script: tests/fixtures/mixed-filter-board.mjs
  - name: Quiet Board
    careers_url: https://boards.example.com/silent
    parser:
      command: node
      script: tests/fixtures/silent-board.mjs
  - name: Broken Board
    careers_url: https://boards.example.com/broken
    parser:
      command: node
      script: tests/fixtures/broken-board.mjs
`;

  const SCANNER_PATH_VARS = [
    'CAREER_OPS_PORTALS', 'CAREER_OPS_PROFILE', 'CAREER_OPS_PIPELINE',
    'CAREER_OPS_SCAN_HISTORY', 'CAREER_OPS_SCAN_SOURCES',
    'CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR',
  ];

  const dir = mkdtempSync(join(tmpdir(), 'scan-ledger-e2e-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'),
      '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, PORTALS);
    const logPath = join(dir, 'logs', 'scan-sources.tsv');

    const childEnv = { ...process.env };
    for (const name of SCANNER_PATH_VARS) delete childEnv[name];
    const stdout = execFileSync(NODE, [join(ROOT, 'scan.mjs'), '--source-log', logPath], {
      cwd: dir,
      env: { ...childEnv, CAREER_OPS_ROOT: dir, CAREER_OPS_PORTALS: portals },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const line = (name) => stdout.split('\n').find((l) => l.startsWith(name)) || '';
    // One posting survives; one fails the title filter, one the location
    // filter, and one repeats a URL already seen in the same sweep.
    const mixed = line('Mixed Board');
    if (/found 4/.test(mixed) && /kept 1/.test(mixed) && /dropped 3/.test(mixed)
      && /title 1/.test(mixed) && /location 1/.test(mixed) && /duplicate 1/.test(mixed)) {
      pass('a real scan attributes every posting to one source and one reason');
    } else {
      fail(`Mixed Board line = ${JSON.stringify(mixed)}`);
    }
    if (/found 0/.test(line('Quiet Board')) && /no postings returned/.test(line('Quiet Board'))) {
      pass('a real scan says a live-but-empty board returned nothing');
    } else {
      fail(`Quiet Board line = ${JSON.stringify(line('Quiet Board'))}`);
    }
    if (/ERROR/.test(line('Broken Board'))) {
      pass('a real scan names a broken board as an error and keeps going');
    } else {
      fail(`Broken Board line = ${JSON.stringify(line('Broken Board'))}`);
    }
    if (!/do not sum to the run totals/.test(stdout)) {
      pass('a real scan reconciles: the per-source totals sum to the run totals');
    } else {
      fail('a real scan reported a reconciliation mismatch');
    }

    // The proof is the last step, not the first: lines printed but no rows
    // written is a failure.
    if (!existsSync(logPath)) {
      fail('the per-source log was never written');
    } else {
      const rows = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).slice(1);
      const names = rows.map((r) => r.split('\t')[1]);
      if (rows.length === 3 && names.includes('Mixed Board') && names.includes('Quiet Board') && names.includes('Broken Board')) {
        pass('--source-log writes one row per enabled source, at the path it was given');
      } else {
        fail(`log rows = ${JSON.stringify(rows)}`);
      }
      const mixedRow = rows.find((r) => r.split('\t')[1] === 'Mixed Board').split('\t');
      const runs = readFileSync(join(dir, 'data', 'scan-runs.tsv'), 'utf-8').split('\n').filter(Boolean);
      const runTimestamp = runs[runs.length - 1].split('\t')[0];
      if (mixedRow[0] === runTimestamp) {
        pass('a per-source row joins its run-summary row on an identical timestamp');
      } else {
        fail(`per-source timestamp ${mixedRow[0]} does not match run-summary timestamp ${runTimestamp}`);
      }
      // The run-summary file keeps its own shape; widening it would break a
      // contract other modules read.
      const runsHeader = runs[0].split('\t');
      if (!runsHeader.includes('source') && runsHeader[0] === 'timestamp') {
        pass('the run-summary file is left alone — no per-source columns added to it');
      } else {
        fail(`scan-runs.tsv header changed: ${runs[0]}`);
      }
    }
  } catch (err) {
    fail(`end-to-end ledger scan failed: ${err.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5. A failed run still writes its per-source rows ─────────────────────────
//
// A run that dies mid-sweep wrote a scan-runs row and no per-source rows, so
// the one run where the breakdown matters most — which sources had been read
// before it died, and which never got their turn — had no breakdown at all.
{
  const { registerRunFailureSnapshot, writeRunFailureRow } = await import(
    pathToFileURL(join(ROOT, 'scan.mjs')).href
  );
  const dir = mkdtempSync(join(tmpdir(), 'scan-failrows-'));
  try {
    const runsPath = join(dir, 'scan-runs.tsv');
    const logPath = join(dir, 'logs', 'scan-sources.tsv');

    const ledger = createSourceLedger();
    ledger.register('Read before the crash', { kind: 'board' });
    ledger.register('Never reached', { kind: 'board' });
    ledger.found('Read before the crash', 3);
    ledger.keep('Read before the crash');
    ledger.drop('Read before the crash', 'title');

    registerRunFailureSnapshot(
      () => ({
        timestamp: new Date().toISOString(),
        companies: 2, boards: 0, found: 3,
        filteredTitle: 1, filteredTier: 0, filteredLocation: 0, filteredPostingAge: 0,
        filteredSalary: 0, filteredContent: 0, filteredCooldown: 0,
        dupes: 0, newAdded: 0, errors: 0,
      }),
      (timestamp) => appendScanSources(ledger.records(), timestamp, logPath),
    );

    const wrote = writeRunFailureRow('failed', runsPath);
    if (wrote) pass('writeRunFailureRow still reports the run-summary row it wrote');
    else fail('writeRunFailureRow returned false');

    if (!existsSync(logPath)) {
      fail('a failed run wrote no per-source rows');
    } else {
      const rows = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).slice(1);
      const names = rows.map((r) => r.split('\t')[1]);
      if (rows.length === 2 && names.includes('Read before the crash') && names.includes('Never reached')) {
        pass('a failed run writes one row per source, including the ones it never reached');
      } else {
        fail(`failed-run rows = ${JSON.stringify(rows)}`);
      }
      const runRow = readFileSync(runsPath, 'utf-8').split('\n').filter(Boolean).slice(-1)[0].split('\t');
      if (rows[0].split('\t')[0] === runRow[0]) {
        pass('the failed run joins its per-source rows on an identical timestamp');
      } else {
        fail(`failed-run timestamps differ: ${rows[0].split('\t')[0]} vs ${runRow[0]}`);
      }
      if (runRow[1] === 'failed') pass('the failed run is recorded as failed, not completed');
      else fail(`failed-run status = ${JSON.stringify(runRow[1])}`);
    }

    // The snapshot is consumed on first use, so a second signal (fatal catch
    // after SIGINT) can never double-write either file.
    const secondRows = existsSync(logPath) ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length : 0;
    writeRunFailureRow('failed', runsPath);
    const afterRows = existsSync(logPath) ? readFileSync(logPath, 'utf-8').split('\n').filter(Boolean).length : 0;
    if (secondRows === afterRows) pass('a second failure signal writes nothing twice');
    else fail(`second signal added rows: ${secondRows} → ${afterRows}`);
  } finally {
    registerRunFailureSnapshot(null);
    rmSync(dir, { recursive: true, force: true });
  }
}
