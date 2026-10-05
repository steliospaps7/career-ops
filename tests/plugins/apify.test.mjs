// tests/plugins/apify.test.mjs: the apify plugin's Job output against the
// documented contract in providers/_types.js.
//
// No network. The provider's own fetch runs end to end with the global fetch
// stubbed for the three Apify calls runActor makes (start the run, read its
// status, read the dataset), so the mapping under test is the shipped one and
// not a copy. The provider writes its JD cache to `jds/` relative to the
// working directory, so each fetch runs inside a temporary directory and the
// repo's own jds/ is never touched.
import { pass, fail, ROOT, rmSync } from '../helpers.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

console.log('\nPlugin: apify');

const PLUGIN_PATH = join(ROOT, 'plugins', 'apify', 'index.mjs');
const mod = await import(pathToFileURL(PLUGIN_PATH).href);
const provider = mod.default.provider;
const { normalizeItem, parsePostedAt } = mod;

const POSTING_URL = 'https://uk.indeed.com/viewjob?jk=abc123';
const LONG_DESCRIPTION = '<p>We are hiring a Finance Operations Lead.</p><p>You will own month-end close and controls.</p>';

// Stub the three requests runActor makes and hand back `items` as the dataset.
function stubApify(items) {
  return async (url) => {
    const u = String(url);
    let body;
    if (u.endsWith('/runs')) body = { data: { id: 'run1' } };
    else if (u.endsWith('/actor-runs/run1')) body = { data: { status: 'SUCCEEDED' } };
    else if (u.endsWith('/actor-runs/run1/dataset/items')) body = items;
    else return new Response('unexpected request', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

// Run the provider's fetch against fixture items inside a temp directory.
// Returns the jobs and the temp directory (removed by the caller).
async function fetchWith(items, fieldMap, prepare = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'apify-plugin-test-'));
  prepare(dir);
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = stubApify(items);
  process.chdir(dir);
  try {
    const jobs = await provider.fetch(
      { name: 'Fixture', actor: 'fixture/actor', field_map: fieldMap },
      { env: { APIFY_TOKEN: 'test-token' } },
    );
    return { jobs, dir };
  } finally {
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
  }
}

const BASE_MAP = { title: 'title', url: 'url', company: 'company', location: 'location' };
const baseItem = () => ({
  title: 'Finance Operations Lead',
  url: POSTING_URL,
  company: 'Acme',
  location: 'London',
  description: LONG_DESCRIPTION,
});

// ── The URL column stays a URL ───────────────────────────────────────────────

{
  const { jobs, dir } = await fetchWith([baseItem()], { ...BASE_MAP, description: 'description' });
  try {
    const job = jobs[0];
    if (jobs.length === 1 && job.url === POSTING_URL) {
      pass('url keeps the https posting URL when a description is cached');
    } else {
      fail(`url with a description = ${JSON.stringify(job?.url)} (expected ${POSTING_URL})`);
    }

    if (typeof job?.description === 'string' && job.description.includes('month-end close') && !job.description.includes('<p>')) {
      pass('the description reaches the Job as plain text');
    } else {
      fail(`description = ${JSON.stringify(job?.description)}`);
    }

    const ref = /^local:(jds\/[^\s]+\.md)$/.exec(job?.note || '');
    if (ref && existsSync(join(dir, ref[1]))) {
      pass('note carries a local:jds/ reference to the cached file');
    } else {
      fail(`note = ${JSON.stringify(job?.note)}`);
    }
    if (ref) {
      const cached = readFileSync(join(dir, ref[1]), 'utf-8');
      if (cached.includes(`url: "${POSTING_URL}"`) && cached.includes('month-end close')) {
        pass('the cached JD still records the posting URL and the body');
      } else {
        fail('cached JD is missing the posting URL or the body');
      }
    }

    if (job && !('_remote_url' in job)) pass('_remote_url is gone');
    else fail('_remote_url is still set');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // A description under the minimum is not cached and not attached, as before.
  const item = { ...baseItem(), description: 'Short.' };
  const { jobs, dir } = await fetchWith([item], { ...BASE_MAP, description: 'description' });
  try {
    const job = jobs[0];
    if (job?.url === POSTING_URL && !('description' in job) && !('note' in job) && !existsSync(join(dir, 'jds'))) {
      pass('a too-short description leaves the Job as it was and writes no cache file');
    } else {
      fail(`short description job = ${JSON.stringify(job)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The cache cannot be written (a file named jds is in the way): the Job keeps
  // its URL and its description and carries no note.
  const prevWarn = console.warn;
  console.warn = () => {};
  let result;
  try {
    result = await fetchWith([baseItem()], { ...BASE_MAP, description: 'description' }, (dir) => writeFileSync(join(dir, 'jds'), ''));
  } finally {
    console.warn = prevWarn;
  }
  const { jobs, dir } = result;
  try {
    const job = jobs[0];
    if (job?.url === POSTING_URL && job.description?.includes('month-end close') && !('note' in job)) {
      pass('a failed cache write keeps the URL and the description and adds no note');
    } else {
      fail(`cache-failure job = ${JSON.stringify(job)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // No description in the field_map: the output is exactly the four fields.
  const { jobs, dir } = await fetchWith([baseItem()], BASE_MAP);
  try {
    const expected = [{ title: 'Finance Operations Lead', url: POSTING_URL, company: 'Acme', location: 'London' }];
    if (JSON.stringify(jobs) === JSON.stringify(expected)) {
      pass('a field_map with no description produces the four-field Job unchanged');
    } else {
      fail(`no-description jobs = ${JSON.stringify(jobs)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // normalizeItem itself is unchanged by the URL fix.
  const out = normalizeItem(baseItem(), BASE_MAP, {});
  if (JSON.stringify(out) === JSON.stringify({ title: 'Finance Operations Lead', url: POSTING_URL, company: 'Acme', location: 'London' })) {
    pass('normalizeItem maps the four fields');
  } else {
    fail(`normalizeItem = ${JSON.stringify(out)}`);
  }
}

// ── The posting date ─────────────────────────────────────────────────────────

const POSTED_MS = Date.UTC(2025, 2, 10, 8, 0, 0); // 2025-03-10T08:00:00Z
const DATE_MAP = { ...BASE_MAP, posted_at: ['postedAt', 'datePosted'] };

{
  const iso = normalizeItem({ ...baseItem(), postedAt: '2025-03-10T08:00:00.000Z' }, DATE_MAP, {});
  const secs = normalizeItem({ ...baseItem(), postedAt: POSTED_MS / 1000 }, DATE_MAP, {});
  const ms = normalizeItem({ ...baseItem(), datePosted: POSTED_MS }, DATE_MAP, {});
  if (iso.postedAt === POSTED_MS && secs.postedAt === POSTED_MS && ms.postedAt === POSTED_MS) {
    pass('posted_at in ISO, epoch seconds and epoch milliseconds lands as the same epoch-ms postedAt');
  } else {
    fail(`postedAt iso=${iso.postedAt} secs=${secs.postedAt} ms=${ms.postedAt} (expected ${POSTED_MS})`);
  }

  const rfc = normalizeItem({ ...baseItem(), postedAt: 'Mon, 10 Mar 2025 08:00:00 GMT' }, DATE_MAP, {});
  if (rfc.postedAt === POSTED_MS) pass('an RFC 2822 date string is read');
  else fail(`rfc postedAt = ${rfc.postedAt}`);
}

{
  // parsePostedAt, the guard itself, with a fixed clock: anything that is not a
  // sane absolute date is null, never guessed.
  const NOW = Date.UTC(2026, 8, 13, 12, 0, 0);
  const DAY = 86_400_000;
  const cases = [
    ['relative English', '3 days ago'],
    ['junk text Date.parse would still read as 2001', 'not a date 5'],
    ['a bare year', '2024'],
    ['an empty string', ''],
    ['1970 as epoch 0', 0],
    ['1970 as an ISO string', '1970-01-01T00:00:00Z'],
    ['1999', '1999-12-31T00:00:00Z'],
    ['more than a day ahead, in ms', NOW + DAY + 1],
    ['more than a day ahead, in seconds', Math.floor((NOW + 3 * DAY) / 1000)],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
    ['an object', { date: '2025-03-10' }],
    ['a boolean', true],
  ];
  const leaked = cases
    .map(([label, value]) => [label, parsePostedAt(value, NOW)])
    .filter(([, out]) => out !== null)
    .map(([label, out]) => `${label} -> ${out}`);
  if (leaked.length === 0) pass('parsePostedAt returns null for junk, relative, bare-year, 1970, pre-2000, future and non-finite values');
  else fail(`parsePostedAt accepted: ${leaked.join('; ')}`);

  if (parsePostedAt(NOW + 3_600_000, NOW) === NOW + 3_600_000 && parsePostedAt(NOW + DAY, NOW) === NOW + DAY) {
    pass('parsePostedAt keeps a date up to one day ahead (a timezone skew)');
  } else {
    fail('parsePostedAt dropped a date within the one-day skew');
  }

  if (parsePostedAt('2025-03-10', NOW) === Date.UTC(2025, 2, 10) && parsePostedAt('Posted 12/03/2024', NOW) !== null) {
    pass('parsePostedAt reads a date-only string and a date inside text that carries a full date');
  } else {
    fail(`parsePostedAt date-only = ${parsePostedAt('2025-03-10', NOW)}`);
  }

  // normalizeItem leaves the key off, rather than setting it to null.
  const omitted = normalizeItem({ ...baseItem(), postedAt: '3 days ago' }, DATE_MAP, {});
  if (!('postedAt' in omitted)) pass('normalizeItem omits postedAt when the guard returns null');
  else fail(`normalizeItem set postedAt = ${omitted.postedAt}`);
}

{
  // No posted_at in the field_map: normalizeItem is byte-identical to before,
  // even when the item carries a date field.
  const item = { ...baseItem(), postedAt: '2025-03-10T08:00:00.000Z' };
  const out = normalizeItem(item, BASE_MAP, { location: 'Remote' });
  if (JSON.stringify(out) === JSON.stringify({ title: 'Finance Operations Lead', url: POSTING_URL, company: 'Acme', location: 'London' })) {
    pass('a field_map with no posted_at leaves normalizeItem output unchanged');
  } else {
    fail(`normalizeItem without posted_at = ${JSON.stringify(out)}`);
  }

  // A default can never supply the date: defaults stay limited to the four fields.
  const viaDefault = normalizeItem(baseItem(), BASE_MAP, { postedAt: POSTED_MS, posted_at: '2025-03-10' });
  if (!('postedAt' in viaDefault)) pass('defaults cannot set postedAt');
  else fail(`defaults set postedAt = ${viaDefault.postedAt}`);
}

{
  // Through the provider: the date reaches the Job beside the description and note.
  const item = { ...baseItem(), postedAt: '2025-03-10T08:00:00.000Z' };
  const { jobs, dir } = await fetchWith([item], { ...DATE_MAP, description: 'description' });
  try {
    const job = jobs[0];
    if (job?.postedAt === POSTED_MS && job.url === POSTING_URL && /^local:jds\//.test(job.note || '')) {
      pass('the provider emits postedAt with the URL and note intact');
    } else {
      fail(`provider job with posted_at = ${JSON.stringify(job)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // Without posted_at the provider output is exactly the plugin's output before
  // this field existed, for an item that carries a date.
  const item = { ...baseItem(), postedAt: '2025-03-10T08:00:00.000Z' };
  const { jobs, dir } = await fetchWith([item], BASE_MAP);
  try {
    const expected = [{ title: 'Finance Operations Lead', url: POSTING_URL, company: 'Acme', location: 'London' }];
    if (JSON.stringify(jobs) === JSON.stringify(expected)) {
      pass('a field_map with no posted_at produces the same provider output as before');
    } else {
      fail(`provider jobs without posted_at = ${JSON.stringify(jobs)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // The same with description mapped: without posted_at the provider gives the
  // four fields plus description and note, as after the URL fix, and no date.
  const item = { ...baseItem(), postedAt: '2025-03-10T08:00:00.000Z' };
  const { jobs, dir } = await fetchWith([item], { ...BASE_MAP, description: 'description' });
  try {
    const hash = createHash('sha1').update(POSTING_URL).digest('hex').slice(0, 10);
    const expected = [{
      title: 'Finance Operations Lead',
      url: POSTING_URL,
      company: 'Acme',
      location: 'London',
      description: 'We are hiring a Finance Operations Lead.\n\nYou will own month-end close and controls.',
      note: `local:jds/acme-finance-operations-lead-${hash}.md`,
    }];
    if (JSON.stringify(jobs) === JSON.stringify(expected)) {
      pass('with description and no posted_at, the provider output is the four fields plus description and note');
    } else {
      fail(`provider jobs with description, without posted_at = ${JSON.stringify(jobs)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // A malformed posted_at is rejected at config-load time, before any request.
  let requests = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; return new Response('{}', { status: 500 }); };
  let error = null;
  try {
    await provider.fetch(
      { name: 'Fixture', actor: 'fixture/actor', field_map: { ...BASE_MAP, posted_at: 42 } },
      { env: { APIFY_TOKEN: 'test-token' } },
    );
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = prevFetch;
  }
  if (error && /invalid field_map/.test(error.message) && /posted_at/.test(error.message) && requests === 0) {
    pass('an invalid posted_at spec fails with the field_map error and makes no request');
  } else {
    fail(`invalid posted_at: error=${error?.message} requests=${requests}`);
  }
}

// ── A run that finishes while the wait clock runs out ───────────────────────
//
// The wait deadline is wall-clock time, so it can pass while the Mac sleeps
// with the run already finished on Apify's side. runActor reads the status once
// more after the deadline: a finished run is kept, one still going is reported
// with its status.

const { runActor } = await import(pathToFileURL(join(ROOT, 'plugins', 'apify', '_apify.mjs')).href);
const WAIT_MS = 400;

// `lastRead(res)` answers every status read made after the deadline; every read
// before it says RUNNING. `lateReads` counts the status reads made after it.
async function runPastDeadline(lastRead) {
  const prevFetch = globalThis.fetch;
  const calls = [];
  let lateReads = 0;
  // Set before runActor sets its own, so every read runActor makes after its
  // deadline is also past this one.
  const deadline = Date.now() + WAIT_MS;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/runs')) return json({ data: { id: 'run1' } });
    if (u.endsWith('/actor-runs/run1')) {
      if (Date.now() < deadline) return json({ data: { status: 'RUNNING' } });
      lateReads++;
      return lastRead(json);
    }
    if (u.endsWith('/actor-runs/run1/dataset/items')) return json([{ title: 'Late item' }]);
    return new Response('', { status: 200 });
  };
  try {
    return { items: await runActor('fixture/actor', {}, { timeoutMs: WAIT_MS, token: 'test-token' }), calls, lateReads };
  } catch (error) {
    return { error, calls, lateReads };
  } finally {
    await sleep(20); // let the fire-and-forget abort land before the stub goes
    globalThis.fetch = prevFetch;
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

{
  // The Mac sleeps through the last status read: the clock jumps two minutes
  // before it answers SUCCEEDED. A dataset window counted from the old
  // deadline (deadline + 60 s) is already over; one counted from now is not.
  const realNow = Date.now;
  let slept = 0;
  Date.now = () => realNow() + slept;
  let result;
  try {
    result = await runPastDeadline((json) => {
      slept = 120_000;
      return json({ data: { status: 'SUCCEEDED' } });
    });
  } finally {
    Date.now = realNow;
  }
  const { items, error, calls } = result;
  const aborted = calls.some(u => u.endsWith('/abort'));
  if (!error && JSON.stringify(items) === JSON.stringify([{ title: 'Late item' }]) && !aborted) {
    pass('a run RUNNING until the deadline and SUCCEEDED on a last read two minutes late returns its items');
  } else {
    fail(`late SUCCEEDED run: error=${error?.message} items=${JSON.stringify(items)} aborted=${aborted}`);
  }
}

{
  const { error, calls } = await runPastDeadline((json) => json({ data: { status: 'RUNNING' } }));
  const aborts = calls.filter(u => u.endsWith('/actor-runs/run1/abort')).length;
  if (/^Apify run run1 did not finish within 0s \(status RUNNING\)$/.test(error?.message || '') && aborts === 1) {
    pass('a run still RUNNING on the last read throws with its status and is aborted once');
  } else {
    fail(`still-running run: error=${error?.message} aborts=${aborts} (expected 1)`);
  }
}

{
  const { error } = await runPastDeadline(() => new Response('run not found', { status: 404 }));
  if (error?.status === 404 && /^HTTP 404: run not found$/.test(error.message)) {
    pass('a 4xx on the last read throws the HTTP error, as a 4xx on any poll does');
  } else {
    fail(`4xx on last read: error=${error?.message}`);
  }
}

{
  // The last read itself fails without a status: the line says so.
  // It is read once, never retried, so a dead API cannot stall the scan.
  const { error, lateReads } = await runPastDeadline(() => new Response('upstream down', { status: 503 }));
  if (/^Apify run run1 did not finish within 0s \(status RUNNING, last error: HTTP 503: upstream down\)$/.test(error?.message || '') && lateReads === 1) {
    pass('a failed last read is made once, keeps the last status seen and names the error');
  } else {
    fail(`failed last read: error=${error?.message} reads after the deadline=${lateReads} (expected 1)`);
  }
}

{
  // SUCCEEDED arrives with under a second left and the dataset takes longer
  // than that to answer: the read still gets its own time and the items come back.
  const prevFetch = globalThis.fetch;
  const DATASET_DELAY_MS = 600;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/runs')) return json({ data: { id: 'run1' } });
    if (u.endsWith('/actor-runs/run1')) return json({ data: { status: 'SUCCEEDED' } });
    if (u.endsWith('/actor-runs/run1/dataset/items')) {
      // Honour the abort signal, as a real fetch does.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, DATASET_DELAY_MS);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('This operation was aborted')); });
      });
      return json([{ title: 'Near-deadline item' }]);
    }
    return new Response('', { status: 200 });
  };
  let items, error;
  try {
    items = await runActor('fixture/actor', {}, { timeoutMs: WAIT_MS, token: 'test-token' });
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = prevFetch;
  }
  if (!error && JSON.stringify(items) === JSON.stringify([{ title: 'Near-deadline item' }])) {
    pass('a run SUCCEEDED with under a second left still gets time to read its dataset');
  } else {
    fail(`near-deadline SUCCEEDED run: error=${error?.message} items=${JSON.stringify(items)}`);
  }
}

// ── A run given up on is read at the next scan ───────────────────────────────
//
// A run the plugin gives up on (the wait clock ran out while the Mac slept) or
// whose dataset read failed is recorded in data/apify-unread-runs.tsv. The
// next successful fetch of the same entry reads it and returns its items with
// its own. Each case runs in its own temp folder, the plugin's working folder.

const UNREAD = join('data', 'apify-unread-runs.tsv');
const DAY_MS = 86_400_000;
const LINKEDIN = { name: 'LinkedIn — London', actor: 'fixture/actor', field_map: BASE_MAP };
const INDEED = { name: 'Indeed — London', actor: 'fixture/indeed', field_map: BASE_MAP };
const job = (n) => ({ title: `Role ${n}`, url: `https://example.com/jobs/${n}`, company: 'Acme', location: 'London' });
const unreadLine = (entry, runId, recordedAt, actor = entry.actor) => `${entry.name}\t${actor}\t${runId}\t${recordedAt}`;
const writeUnread = (dir, lines) => {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, UNREAD), lines.map(l => `${l}\n`).join(''));
};
const readUnread = (dir) => (existsSync(join(dir, UNREAD)) ? readFileSync(join(dir, UNREAD), 'utf-8') : null);
const unreadIds = (dir) => (readUnread(dir) || '').split('\n').filter(Boolean).map(l => l.split('\t')[2]);

// `runs` maps a run id to { status, items }: a string or a function returning a
// Response (or throwing, as a dropped network does). A run not in the map
// answers 404. `starts` maps an actor's URL form to the run id a start returns.
function stubRuns(runs, starts = { 'fixture~actor': 'own1', 'fixture~indeed': 'own2' }) {
  return async (url) => {
    const u = String(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/abort')) return json({});
    let m = /\/acts\/([^/]+)\/runs$/.exec(u);
    if (m) return json({ data: { id: starts[m[1]] } });
    m = /\/actor-runs\/([^/]+)\/dataset\/items$/.exec(u);
    if (m) {
      const run = runs[m[1]];
      if (!run) return new Response('run not found', { status: 404 });
      return typeof run.items === 'function' ? run.items() : json(run.items || []);
    }
    m = /\/actor-runs\/([^/]+)$/.exec(u);
    if (m) {
      const run = runs[m[1]];
      if (!run) return new Response('run not found', { status: 404 });
      return typeof run.status === 'function' ? run.status() : json({ data: { status: run.status } });
    }
    return new Response('unexpected request', { status: 404 });
  };
}

// The provider's fetch for one entry, inside `dir`, with the log lines kept.
async function fetchEntry(dir, entry, runs, { dryRun = false } = {}) {
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const prevWarn = console.warn;
  const logs = [];
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  globalThis.fetch = stubRuns(runs);
  process.chdir(dir);
  try {
    return { jobs: await provider.fetch(entry, { env: { APIFY_TOKEN: 'test-token' }, dryRun }), logs };
  } catch (error) {
    return { error, logs };
  } finally {
    await sleep(20); // let the fire-and-forget abort land before the stub goes
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
    console.log = prevLog;
    console.warn = prevWarn;
  }
}

function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'apify-unread-test-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const GIVE_UP_MS = 300;
const givingUp = { ...LINKEDIN, timeout_ms: GIVE_UP_MS };
const urls = (jobs) => (jobs || []).map(j => j.url).sort().join(' ');
const networkDown = () => { throw new TypeError('fetch failed'); };
const http = (status, text) => () => new Response(text, { status });

await inTempDir(async (dir) => {
  const before = Date.now();
  const { error } = await fetchEntry(dir, givingUp, { own1: { status: 'RUNNING' } });
  const lines = (readUnread(dir) || '').split('\n').filter(Boolean);
  const fields = (lines[0] || '').split('\t');
  const at = Date.parse(fields[3]);
  if (
    error?.message === 'Apify run own1 did not finish within 0s (status RUNNING)' && error.runId === 'own1' &&
    lines.length === 1 && fields.length === 4 &&
    fields[0] === LINKEDIN.name && fields[1] === 'fixture/actor' && fields[2] === 'own1' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(fields[3]) && at >= before - 1000 && at <= Date.now()
  ) {
    pass('a run given up on is thrown with the same message, carries runId, and is recorded as one four-field line');
  } else {
    fail(`given-up run: error=${error?.message} runId=${error?.runId} file=${JSON.stringify(readUnread(dir))}`);
  }
});

await inTempDir(async (dir) => {
  const { error } = await fetchEntry(dir, LINKEDIN, { own1: { status: 'SUCCEEDED', items: http(500, 'dataset down') } });
  if (error?.message === 'HTTP 500: dataset down' && error.runId === 'own1' && JSON.stringify(unreadIds(dir)) === '["own1"]') {
    pass('a dataset read that fails after SUCCEEDED is thrown as before and its run is recorded');
  } else {
    fail(`dataset failure: error=${error?.message} runId=${error?.runId} ids=${JSON.stringify(unreadIds(dir))}`);
  }
});

await inTempDir(async (dir) => {
  writeFileSync(join(dir, 'data'), ''); // a file where data/ should be: the record cannot be written
  const { error, logs } = await fetchEntry(dir, givingUp, { own1: { status: 'RUNNING' } });
  const recordLogs = logs.filter(l => /could not record run own1/.test(l));
  if (error?.message === 'Apify run own1 did not finish within 0s (status RUNNING)' && error.runId === 'own1' && recordLogs.length === 1) {
    pass('a record that cannot be written logs one line and the original error is still thrown');
  } else {
    fail(`failed record: error=${error?.message} logs=${JSON.stringify(logs)}`);
  }
});

await inTempDir(async (dir) => {
  const recorded = new Date(Date.now() - DAY_MS).toISOString();
  const otherLine = unreadLine(INDEED, 'idx1', recorded);
  writeUnread(dir, [unreadLine(LINKEDIN, 'early1', recorded), otherLine]);
  const { jobs, error, logs } = await fetchEntry(dir, LINKEDIN, {
    own1: { status: 'SUCCEEDED', items: [job(1)] },
    early1: { status: 'SUCCEEDED', items: [job(2), job(3)] },
    idx1: { status: 'SUCCEEDED', items: [job(9)] },
  });
  const readLog = logs.filter(l => l === `apify: ${LINKEDIN.name}: read 2 items from earlier run early1 (recorded ${recorded})`);
  if (!error && urls(jobs) === urls([job(1), job(2), job(3)]) && readUnread(dir) === `${otherLine}\n` && readLog.length === 1) {
    pass('the next fetch returns the earlier run\'s items with its own, logs one line, removes its line and leaves another entry\'s line');
  } else {
    fail(`earlier run read: error=${error?.message} jobs=${urls(jobs)} file=${JSON.stringify(readUnread(dir))} logs=${JSON.stringify(logs)}`);
  }
});

for (const [label, run] of [
  ['RUNNING', { status: 'RUNNING' }],
  ['a network error', { status: networkDown }],
  ['a failed dataset read', { status: 'SUCCEEDED', items: http(503, 'busy') }],
]) {
  await inTempDir(async (dir) => {
    writeUnread(dir, [unreadLine(LINKEDIN, 'early1', new Date().toISOString())]);
    const before = readUnread(dir);
    const { jobs, error } = await fetchEntry(dir, LINKEDIN, { own1: { status: 'SUCCEEDED', items: [job(1)] }, early1: run });
    if (!error && urls(jobs) === urls([job(1)]) && readUnread(dir) === before) {
      pass(`an earlier run with ${label} keeps its line and this run still returns its own items`);
    } else {
      fail(`earlier run with ${label}: error=${error?.message} jobs=${urls(jobs)} file=${JSON.stringify(readUnread(dir))}`);
    }
  });
}

await inTempDir(async (dir) => {
  const now = new Date().toISOString();
  const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS).toISOString();
  writeUnread(dir, [
    unreadLine(LINKEDIN, 'failed1', now),
    unreadLine(LINKEDIN, 'aborted1', now),
    unreadLine(LINKEDIN, 'timedout1', now),
    unreadLine(LINKEDIN, 'gone1', now),
    unreadLine(LINKEDIN, 'otheractor1', now, 'fixture/other'),
    unreadLine(LINKEDIN, 'old1', eightDaysAgo),
  ]);
  const { jobs, error } = await fetchEntry(dir, LINKEDIN, {
    own1: { status: 'SUCCEEDED', items: [job(1)] },
    failed1: { status: 'FAILED' },
    aborted1: { status: 'ABORTED' },
    timedout1: { status: 'TIMED-OUT' },
    // gone1 is not in the map: 404
    otheractor1: { status: 'SUCCEEDED', items: [job(7)] },
    old1: { status: 'SUCCEEDED', items: [job(8)] },
  });
  if (!error && urls(jobs) === urls([job(1)]) && readUnread(dir) === '') {
    pass('FAILED, ABORTED, TIMED-OUT, a 404, a different actor and an 8-day-old line are dropped, and none is read');
  } else {
    fail(`dropped lines: error=${error?.message} jobs=${urls(jobs)} file=${JSON.stringify(readUnread(dir))}`);
  }
});

await inTempDir(async (dir) => {
  const staleOther = unreadLine(INDEED, 'idxold', new Date(Date.now() - 8 * DAY_MS).toISOString());
  const freshOther = unreadLine(INDEED, 'idxnew', new Date().toISOString());
  writeUnread(dir, [staleOther, freshOther]);
  const { error } = await fetchEntry(dir, givingUp, { own1: { status: 'RUNNING' } });
  const ids = unreadIds(dir);
  if (error?.runId === 'own1' && JSON.stringify(ids) === '["idxnew","own1"]') {
    pass('an 8-day-old line of another entry is dropped on any write; a fresh one stays');
  } else {
    fail(`stale other-entry line: error=${error?.message} ids=${JSON.stringify(ids)}`);
  }
});

await inTempDir(async (dir) => {
  writeUnread(dir, [unreadLine(LINKEDIN, 'early1', new Date().toISOString())]);
  const before = readUnread(dir);
  let reads = 0;
  const { error } = await fetchEntry(dir, LINKEDIN, {
    own1: { status: 'FAILED' },
    early1: { status: () => { reads++; return new Response(JSON.stringify({ data: { status: 'SUCCEEDED' } }), { status: 200 }); }, items: [job(2)] },
  });
  if (/^Apify actor fixture\/actor finished with status FAILED$/.test(error?.message || '') && readUnread(dir) === before && reads === 0) {
    pass('when this run\'s own actor fails, earlier lines are left as they are and not read');
  } else {
    fail(`own actor failed: error=${error?.message} reads=${reads} file=${JSON.stringify(readUnread(dir))}`);
  }
});

await inTempDir(async (dir) => {
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const prevWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  globalThis.fetch = stubRuns({ own1: { status: 'RUNNING' }, own2: { status: 'RUNNING' } });
  process.chdir(dir);
  let results;
  try {
    const ctx = { env: { APIFY_TOKEN: 'test-token' } };
    results = await Promise.allSettled([
      provider.fetch({ ...LINKEDIN, timeout_ms: GIVE_UP_MS }, ctx),
      provider.fetch({ ...INDEED, timeout_ms: GIVE_UP_MS }, ctx),
    ]);
  } finally {
    await sleep(20);
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
    console.log = prevLog;
    console.warn = prevWarn;
  }
  const ids = unreadIds(dir).sort();
  if (results.every(r => r.status === 'rejected') && JSON.stringify(ids) === '["own1","own2"]') {
    pass('two entries given up on at the same time leave both lines');
  } else {
    fail(`two at once: results=${results.map(r => r.status)} ids=${JSON.stringify(ids)}`);
  }
});

await inTempDir(async (dir) => {
  writeUnread(dir, [
    unreadLine(LINKEDIN, 'early1', new Date().toISOString()),
    unreadLine(LINKEDIN, 'failed1', new Date().toISOString()),
    unreadLine(INDEED, 'idxold', new Date(Date.now() - 8 * DAY_MS).toISOString()),
  ]);
  const before = readUnread(dir);
  const { jobs, error } = await fetchEntry(dir, LINKEDIN, {
    own1: { status: 'SUCCEEDED', items: [job(1)] },
    early1: { status: 'SUCCEEDED', items: [job(2)] },
    failed1: { status: 'FAILED' },
  }, { dryRun: true });
  const recovered = !error && urls(jobs) === urls([job(1), job(2)]);
  const { error: gaveUp } = await fetchEntry(dir, givingUp, { own1: { status: 'RUNNING' } }, { dryRun: true });
  if (recovered && gaveUp?.runId === 'own1' && readUnread(dir) === before) {
    pass('a dry run reads earlier runs but leaves the file byte-identical, and records no run it gives up on');
  } else {
    fail(`dry run: recovered=${recovered} jobs=${urls(jobs)} gaveUp=${gaveUp?.message} file changed=${readUnread(dir) !== before}`);
  }
});
