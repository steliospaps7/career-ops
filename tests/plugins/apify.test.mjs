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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

console.log('\nPlugin: apify');

const PLUGIN_PATH = join(ROOT, 'plugins', 'apify', 'index.mjs');
const mod = await import(pathToFileURL(PLUGIN_PATH).href);
const provider = mod.default.provider;
const { normalizeItem } = mod;

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
  // Anything that is not a sane absolute date is omitted, never guessed.
  const cases = [
    ['relative English', '3 days ago'],
    ['junk text Date.parse would still read as 2001', 'not a date 5'],
    ['a bare year', '2024'],
    ['an empty string', ''],
    ['1970 as epoch 0', 0],
    ['1970 as an ISO string', '1970-01-01T00:00:00Z'],
    ['1999', '1999-12-31T00:00:00Z'],
    ['more than a day in the future', Date.now() + 3 * 86_400_000],
    ['NaN', Number.NaN],
    ['an object', { date: '2025-03-10' }],
    ['a boolean', true],
  ];
  const leaked = cases
    .map(([label, value]) => [label, normalizeItem({ ...baseItem(), postedAt: value }, DATE_MAP, {})])
    .filter(([, out]) => 'postedAt' in out)
    .map(([label, out]) => `${label} -> ${out.postedAt}`);
  if (leaked.length === 0) pass('junk, relative, 1970, pre-2000 and future dates are omitted');
  else fail(`postedAt set for: ${leaked.join('; ')}`);

  const soon = normalizeItem({ ...baseItem(), postedAt: Date.now() + 3_600_000 }, DATE_MAP, {});
  if (typeof soon.postedAt === 'number') pass('a date within a day ahead (a timezone skew) is kept');
  else fail('a date one hour ahead was dropped');
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
