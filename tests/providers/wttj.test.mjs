// tests/providers/wttj.test.mjs — Welcome to the Jungle provider (public
// Algolia search index behind welcometothejungle.com; credentials fetched
// fresh from /api/env). Follows the discovered-test layout from #1440.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — wttj (Welcome to the Jungle Algolia index)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/wttj.mjs')).href);
  const wttj = mod.default;
  const { parseEnvPayload, normalizeWttjHit } = mod;

  if (wttj.id === 'wttj') pass('wttj.id is "wttj"');
  else fail(`wttj.id is ${JSON.stringify(wttj.id)}`);

  const hit = wttj.detect({ name: 'Welcome to the Jungle', provider: 'wttj' });
  if (hit && hit.url === 'https://www.welcometothejungle.com') {
    pass('wttj.detect() claims entries with provider: wttj');
  } else {
    fail(`wttj.detect() returned ${JSON.stringify(hit)}`);
  }

  if (wttj.detect({ name: 'X', provider: 'greenhouse' }) === null) {
    pass('wttj.detect() returns null for other providers');
  } else {
    fail('wttj.detect() should return null for other providers');
  }

  if (wttj.detect({ name: 'X', careers_url: 'https://www.welcometothejungle.com/en/jobs' }) === null) {
    pass('wttj.detect() does not URL-autodetect (explicit provider: wttj only — the board is global)');
  } else {
    fail('wttj.detect() should not claim entries by careers_url');
  }

  // parseEnvPayload — the /api/env `window.env = {...}` payload
  const HEX_KEY = '0123456789abcdef0123456789abcdef';
  const envText = (appId, apiKey) =>
    `window.env = ${JSON.stringify({ PUBLIC_ALGOLIA_APPLICATION_ID: appId, PUBLIC_ALGOLIA_API_KEY_CLIENT: apiKey, OTHER: 'noise' })};`;

  const creds = parseEnvPayload(envText(' AB12CD34 ', HEX_KEY));
  if (creds.appId === 'AB12CD34' && creds.apiKey === HEX_KEY) {
    pass('parseEnvPayload() extracts and trims the Algolia app id + client key');
  } else {
    fail(`parseEnvPayload() returned ${JSON.stringify(creds)}`);
  }

  // The client key is only ever sent as a header, so its format is not
  // over-constrained — a rotated long/base64 (secured) key must still parse.
  const securedKey = 'QWxnb2xpYSBzZWN1cmVkIGtleQ==' + 'x'.repeat(100);
  const secured = parseEnvPayload(envText('AB12CD34', securedKey));
  if (secured.apiKey === securedKey) {
    pass('parseEnvPayload() accepts a long non-hex (secured/base64) client key — length bounds only');
  } else {
    fail(`parseEnvPayload() secured key → ${JSON.stringify(secured.apiKey)}`);
  }

  const throws = (fn) => { try { fn(); return false; } catch { return true; } };

  if (throws(() => parseEnvPayload(envText('AB12CD34', 'short')))) {
    pass('parseEnvPayload() rejects an implausibly short api key');
  } else {
    fail('parseEnvPayload() should reject an implausibly short api key');
  }

  if (throws(() => parseEnvPayload(envText('bad app id!', HEX_KEY)))) {
    pass('parseEnvPayload() rejects a non-alphanumeric app id (it becomes a hostname)');
  } else {
    fail('parseEnvPayload() should reject a non-alphanumeric app id');
  }

  if (throws(() => parseEnvPayload('window.env = undefined;'))) {
    pass('parseEnvPayload() rejects a payload with no JSON object');
  } else {
    fail('parseEnvPayload() should reject a payload with no JSON object');
  }

  if (throws(() => parseEnvPayload('window.env = {not json};'))) {
    pass('parseEnvPayload() rejects invalid JSON');
  } else {
    fail('parseEnvPayload() should reject invalid JSON');
  }

  // normalizeWttjHit — Algolia hit → normalized Job
  const fullHit = {
    name: '  Senior Data Engineer  ',
    slug: 'senior-data-engineer_abc123',
    organization: { name: 'Example SAS', slug: 'example-sas' },
    offices: [{ city: 'Paris', country: 'France' }, { city: 'Lyon', country: 'France' }],
    remote: 'fulltime',
    published_at_timestamp: 1751500800,
    salary_yearly_minimum: 60000,
    salary_maximum: 80000,
    salary_period: 'yearly',
    salary_currency: 'eur',
  };
  const j1 = normalizeWttjHit(fullHit);
  if (
    j1 &&
    j1.title === 'Senior Data Engineer' &&
    j1.url === 'https://www.welcometothejungle.com/en/companies/example-sas/jobs/senior-data-engineer_abc123' &&
    j1.company === 'Example SAS'
  ) {
    pass('normalizeWttjHit() maps name/slug/organization to title/url/company');
  } else {
    fail(`normalizeWttjHit() job = ${JSON.stringify(j1)}`);
  }

  if (j1 && j1.location === 'Paris, France, Remote') {
    pass('normalizeWttjHit() joins first-office city+country and appends Remote for fulltime-remote posts');
  } else {
    fail(`normalizeWttjHit() location = ${JSON.stringify(j1 && j1.location)}`);
  }

  if (j1 && j1.postedAt === 1751500800000) {
    pass('normalizeWttjHit() converts published_at_timestamp epoch-seconds to ms');
  } else {
    fail(`normalizeWttjHit() postedAt = ${j1 && j1.postedAt}`);
  }

  if (j1 && j1.salary && j1.salary.min === 60000 && j1.salary.max === 80000 && j1.salary.currency === 'EUR') {
    pass('normalizeWttjHit() attaches a yearly salary range with uppercased currency');
  } else {
    fail(`normalizeWttjHit() salary = ${JSON.stringify(j1 && j1.salary)}`);
  }

  const monthly = normalizeWttjHit({
    ...fullHit,
    salary_yearly_minimum: 50000,
    salary_maximum: 5000,
    salary_period: 'monthly',
  });
  if (monthly && monthly.salary && monthly.salary.min === 50000 && monthly.salary.max === 50000) {
    pass('normalizeWttjHit() ignores a non-yearly salary_maximum (keeps only the annualized minimum)');
  } else {
    fail(`normalizeWttjHit() monthly-period salary = ${JSON.stringify(monthly && monthly.salary)}`);
  }

  const bare = normalizeWttjHit({ name: 'Job', slug: 'job-1', organization: { slug: 'acme' } });
  if (bare && bare.company === 'Welcome to the Jungle' && bare.location === '' && bare.salary === undefined && bare.postedAt === undefined) {
    pass('normalizeWttjHit() falls back to the board name and omits absent salary/postedAt');
  } else {
    fail(`normalizeWttjHit() bare hit = ${JSON.stringify(bare)}`);
  }

  if (normalizeWttjHit({ name: 'Job', slug: 'job-1', organization: {} }) === null) {
    pass('normalizeWttjHit() returns null when the organization slug is missing');
  } else {
    fail('normalizeWttjHit() should return null without an organization slug');
  }

  if (normalizeWttjHit({ name: 'Job', slug: '../evil', organization: { slug: 'acme' } }) === null) {
    pass('normalizeWttjHit() rejects path-unsafe slugs (they feed straight into a URL path)');
  } else {
    fail('normalizeWttjHit() should reject path-unsafe slugs');
  }

  if (normalizeWttjHit(null) === null && normalizeWttjHit('nope') === null) {
    pass('normalizeWttjHit() returns null for non-object hits');
  } else {
    fail('normalizeWttjHit() should return null for non-object hits');
  }

  // fetch() — env bootstrap, per-query Algolia calls, headers, dedup (mocked ctx)
  const ENV_OK = envText('AB12CD34', HEX_KEY);
  const mkHit = (slug, title) => ({
    name: title,
    slug,
    organization: { name: 'Acme', slug: 'acme' },
    offices: [{ city: 'Paris', country: 'France' }],
  });
  const mkCtx = (env, hitsFor) => {
    const textCalls = [];
    const jsonCalls = [];
    return {
      textCalls,
      jsonCalls,
      ctx: {
        fetchText: async (url, opts) => { textCalls.push({ url, opts }); return env; },
        fetchJson: async (url, opts) => {
          const params = new URLSearchParams(JSON.parse(opts.body).params);
          const call = { url, opts, query: params.get('query'), hitsPerPage: params.get('hitsPerPage') };
          jsonCalls.push(call);
          return hitsFor(call);
        },
      },
    };
  };

  const happy = mkCtx(ENV_OK, ({ query }) => ({
    hits: query === 'finops'
      ? [mkHit('job-a', 'FinOps Lead'), mkHit('job-b', 'FinOps Analyst')]
      : [mkHit('job-b', 'FinOps Analyst'), mkHit('job-c', 'Snowflake Engineer')],
  }));
  const happyJobs = await wttj.fetch(
    { name: 'WTTJ', provider: 'wttj', wttj: { queries: ['finops', 'snowflake'] } },
    happy.ctx,
  );
  if (happyJobs.length === 3 && happy.jsonCalls.length === 2) {
    pass('wttj.fetch() runs one Algolia query per configured search and dedupes across queries');
  } else {
    fail(`wttj.fetch(): ${happyJobs.length} jobs from ${happy.jsonCalls.length} queries`);
  }

  if (
    happy.textCalls.length === 1 &&
    happy.textCalls[0].url === 'https://www.welcometothejungle.com/api/env' &&
    happy.textCalls[0].opts.redirect === 'error'
  ) {
    pass('wttj.fetch() bootstraps credentials from /api/env with redirect: error');
  } else {
    fail(`wttj.fetch() env calls = ${JSON.stringify(happy.textCalls.map((c) => c.url))}`);
  }

  const q1 = happy.jsonCalls[0];
  if (q1.url === 'https://AB12CD34-dsn.algolia.net/1/indexes/wttj_jobs_production_en/query') {
    pass('wttj.fetch() derives the Algolia host from the fetched app id');
  } else {
    fail(`wttj.fetch() Algolia URL = ${q1.url}`);
  }

  if (
    q1.opts.headers['x-algolia-application-id'] === 'AB12CD34' &&
    q1.opts.headers['x-algolia-api-key'] === HEX_KEY &&
    q1.opts.headers.referer === 'https://www.welcometothejungle.com/' &&
    q1.opts.redirect === 'error'
  ) {
    pass('wttj.fetch() sends the app id, api key, and the referer the key is locked to');
  } else {
    fail(`wttj.fetch() Algolia headers = ${JSON.stringify(q1.opts.headers)}`);
  }

  if (q1.hitsPerPage === '100' && happy.jsonCalls.map((c) => c.query).join(',') === 'finops,snowflake') {
    pass('wttj.fetch() defaults to 100 hits per query and passes each search term through');
  } else {
    fail(`wttj.fetch() hitsPerPage=${q1.hitsPerPage}, queries=${happy.jsonCalls.map((c) => c.query).join(',')}`);
  }

  const capped = mkCtx(ENV_OK, () => ({ hits: [] }));
  await wttj.fetch({ name: 'WTTJ', provider: 'wttj', wttj: { queries: ['x'], max_hits: 500 } }, capped.ctx);
  if (capped.jsonCalls[0].hitsPerPage === '200') {
    pass('wttj.fetch() caps max_hits at 200 per query');
  } else {
    fail(`wttj.fetch() max_hits=500 → hitsPerPage=${capped.jsonCalls[0].hitsPerPage}`);
  }

  let noQueriesErr = '';
  try {
    await wttj.fetch({ name: 'WTTJ', provider: 'wttj' }, mkCtx(ENV_OK, () => ({ hits: [] })).ctx);
  } catch (err) { noQueriesErr = err.message; }
  // Assert the message, not just that something threw — an unrelated crash must not pass.
  if (noQueriesErr.includes('wttj: the WTTJ board is global')) {
    pass('wttj.fetch() throws without an explicit wttj.queries config (never scans the whole board)');
  } else {
    fail(`wttj.fetch() missing-queries error = ${JSON.stringify(noQueriesErr) || 'did not throw'}`);
  }

  let badShapeErr = '';
  try {
    await wttj.fetch(
      { name: 'WTTJ', provider: 'wttj', wttj: { queries: ['x'] } },
      mkCtx(ENV_OK, () => ({ error: 'nope' })).ctx,
    );
  } catch (err) { badShapeErr = err.message; }
  if (badShapeErr.includes('wttj: unexpected Algolia response') && badShapeErr.includes('expected { hits: [...] }')) {
    pass('wttj.fetch() throws on an Algolia response without a hits array');
  } else {
    fail(`wttj.fetch() malformed-response error = ${JSON.stringify(badShapeErr) || 'did not throw'}`);
  }
} catch (e) {
  fail(`wttj provider tests crashed: ${e.message}`);
}

// ── A New York job is not read as York, United Kingdom ───────────────
// On 15 September 2026 eight WTTJ rows reached the queue as "York, United
// Kingdom". Every one is a US job. WTTJ's own index returned the office as
// city "York", country "United Kingdom", country code "GB", and the provider
// copied it. The job slug still names the real place ("_new-york_",
// "_houston_"), so when no office names that place the country is left out.
// The office records below are the eight real ones as WTTJ returned them.
console.log('\nProvider — wttj: a New York job is not read as York, United Kingdom');
{
const { normalizeWttjHit, slugPlace } = await import(pathToFileURL(join(ROOT, 'providers/wttj.mjs')).href);
const { buildLocationFilter, judgeAttendance } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// The whole location_filter in Stelios's portals.yml on 15 September 2026.
const LOCATION_FILTER = {
  always_allow: ['London'],
  allow: ['London', 'United Kingdom', 'UK', 'Hybrid'],
  block: [
    'Belfast', 'Manchester', 'Birmingham', 'Edinburgh', 'Glasgow', 'Bristol', 'Leeds',
    'Cardiff', 'Cambridge', 'Oxford', 'Reading', 'Brighton', 'United States', 'New York',
    'San Francisco', 'Germany', 'Berlin', 'France', 'Paris', 'Spain', 'Netherlands',
    'Amsterdam', 'Ireland', 'Dublin', 'India', 'Singapore', 'Australia', 'Canada',
  ],
  block_hard: ['United Arab Emirates', 'Brazil', 'Japan'],
};
const passesFilter = buildLocationFilter(LOCATION_FILTER);

const BARE_YORK = { state: null, city: 'York', country: 'United Kingdom', country_code: 'GB', district: null, local_district: null, local_city: null, local_state: null };
const FULL_YORK = { state: 'England', city: 'York', country: 'United Kingdom', country_code: 'GB', district: 'North Yorkshire', local_district: 'North Yorkshire', local_city: 'York', local_state: 'England' };

const hit = (orgSlug, slug, office, extra = {}) => ({
  name: 'Role',
  slug,
  organization: { name: orgSlug, slug: orgSlug },
  offices: [office],
  ...extra,
});

// The eight rows of 15 September, as WTTJ returned them.
const FIFTEEN_SEPTEMBER = [
  ['Wolters Kluwer', hit('wolters-kluwer-1', 'customer-service-operations-associate-filing-manager_houston_wjxb6chm', BARE_YORK, { remote: 'fulltime' }), 'York, Remote'],
  ['Ekimetrics', hit('ekimetrics', 'marketing-operations-associate_new-york', FULL_YORK), 'York'],
  ['Fluent', hit('fluent', 'partnerships-operations-manager_new-york_spfcylcv', BARE_YORK), 'York'],
  ['Vise', hit('vise', 'business-operations-lead_new-york_z472ozxc', BARE_YORK), 'York'],
  ['Duolingo', hit('duolingo', 'strategy-and-business-operations-manager_new-york_4vxj3xxq', BARE_YORK), 'York'],
  ['Viam', hit('viam', 'chief-of-staff_new-york_uuusjbz4', BARE_YORK), 'York'],
  ['US Mobile', hit('us-mobile', 'chief-of-staff_new-york_fqilsriq', BARE_YORK), 'York'],
  ['Anthropic', hit('anthropic', 'research-engineer-applied-ai_new-york_b6h7xogn', BARE_YORK), 'York'],
];

for (const [company, h, expected] of FIFTEEN_SEPTEMBER) {
  const job = normalizeWttjHit(h);
  eq(`${company}: the slug names another place, so "United Kingdom" is dropped`, job.location, expected);
  eq(`${company}: the UK location filter now drops it`, passesFilter(job.location, job.url, 'Role'), false);
}

// Real York, England: the slug agrees with the office, so nothing changes. It
// is still a UK town outside London, which the attendance rule drops.
const realYork = normalizeWttjHit(hit('acme', 'operations-manager_york_ab12cd34', FULL_YORK));
eq('York, England: office and slug agree, location unchanged', realYork.location, 'York, United Kingdom');
eq('York, England: still passes the UK location filter', passesFilter(realYork.location, realYork.url, 'Role'), true);
eq('York, England: read as a UK town outside London', judgeAttendance(realYork.location, 'On site in York.').town, 'York');
eq('York, England as written: read as a UK town outside London', judgeAttendance('York, England', 'On site in York.').town, 'York');

// New York, NY, filed correctly: unchanged, and blocked as before.
const realNewYork = normalizeWttjHit(hit('acme', 'chief-of-staff_new-york_ab12cd34', { city: 'New York', country: 'United States', country_code: 'US' }));
eq('New York filed as New York: location unchanged', realNewYork.location, 'New York, United States');
eq('New York filed as New York: blocked', passesFilter(realNewYork.location, realNewYork.url, 'Role'), false);
eq('New York, NY as written: blocked', passesFilter('New York, NY', '', 'Role'), false);
eq('New York, NY as written: not read as a UK town', judgeAttendance('New York, NY', '').drop, false);

// Yorkshire is not York, and whole words only: no "Castle" inside "Newcastle".
eq('Yorkshire: not read as York by a York block', buildLocationFilter({ block: ['York'] })('Yorkshire, United Kingdom', '', 'Role'), true);
eq('Newcastle: not read as Castle by a Castle block', buildLocationFilter({ block: ['Castle'] })('Newcastle upon Tyne, United Kingdom', '', 'Role'), true);
eq('Yorkshire office with a "york" slug: the two are not the same place',
  normalizeWttjHit(hit('acme', 'role_york_ab12cd34', { city: 'Yorkshire', country: 'United Kingdom' })).location, 'Yorkshire');
eq('Newcastle slug with a Newcastle upon Tyne office: the same place',
  normalizeWttjHit(hit('acme', 'role_newcastle_ab12cd34', { city: 'Newcastle upon Tyne', country: 'United Kingdom' })).location, 'Newcastle upon Tyne, United Kingdom');

// A London office whose slug names another city still passes on "London",
// and a London slug does not let a Berlin office through.
const ghent = normalizeWttjHit(hit('deliverect', 'chief-of-staff_ghent_wsujg4xk', { city: 'London', country: 'United Kingdom' }));
eq('London office with a Ghent slug: the office city is kept', ghent.location, 'London');
eq('London office with a Ghent slug: still passes', passesFilter(ghent.location, ghent.url, 'Role'), true);
const berlin = normalizeWttjHit(hit('acme', 'talent-acquisition-partner-business-operations_london_3vfq32kw', { city: 'Berlin', country: 'Germany' }));
eq('Berlin office with a London slug: the office city is kept', berlin.location, 'Berlin');
eq('Berlin office with a London slug: still blocked', passesFilter(berlin.location, berlin.url, 'Role'), false);

// The office may carry extra words at the end, never the slug: "New" is not
// New York, and a Cambridge, Massachusetts slug does not vouch for Cambridge, UK.
eq('"New" office with a "new-york" slug: country dropped',
  normalizeWttjHit(hit('acme', 'role_new-york_ab12cd34', { city: 'New', country: 'United Kingdom' })).location, 'New');
eq('"New" office with a "new-york" slug: dropped by the filter',
  passesFilter('New', '', 'Role'), false);
eq('Cambridge office with a "cambridge-ma" slug: country dropped',
  normalizeWttjHit(hit('acme', 'role_cambridge-ma_ab12cd34', { city: 'Cambridge', country: 'United Kingdom' })).location, 'Cambridge');

// Any office may name the slug's place; the first office is still what is shown.
eq('Offices [Slough, London] with a london slug: country kept',
  normalizeWttjHit({ ...hit('acme', 'role_london_ab12cd34', { city: 'Slough', country: 'United Kingdom' }), offices: [{ city: 'Slough', country: 'United Kingdom' }, { city: 'London', country: 'United Kingdom' }] }).location,
  'Slough, United Kingdom');

// Letters outside a-z fold to their ASCII base, as the slug spells them.
eq('Accents: Zürich office with a zurich slug is the same place',
  normalizeWttjHit(hit('acme', 'role_zurich_ab12cd34', { city: 'Zürich', country: 'Switzerland' })).location, 'Zürich, Switzerland');
eq('Stroke letters: Ørestad office with an orestad slug is the same place',
  normalizeWttjHit(hit('acme', 'role_orestad_ab12cd34', { city: 'Ørestad', country: 'Denmark' })).location, 'Ørestad, Denmark');
eq('Punctuation: Villeneuve-d\'Ascq office with its slug is the same place',
  normalizeWttjHit(hit('acme', 'role_villeneuve-d-ascq_ab12cd34', { city: "Villeneuve-d'Ascq", country: 'France' })).location, "Villeneuve-d'Ascq, France");

// What dropping the country costs. With no allow list, a US record whose slug
// names another place is no longer caught by a "United States" block; and the
// attendance rule needs a UK word after the town, so it leaves "York" alone.
eq('Block-only filter: "York, United States" was blocked', buildLocationFilter({ block: ['United States'] })('York, United States', '', 'Role'), false);
eq('Block-only filter: "York" now passes', buildLocationFilter({ block: ['United States'] })('York', '', 'Role'), true);
eq('Attendance rule: "York" is not read as a UK town', judgeAttendance('York', 'On site.').drop, false);

// What slugPlace reads, and what it leaves alone. Shapes from 2,437 live slugs.
eq('slugPlace: title_place_id', slugPlace('chief-of-staff_new-york_uuusjbz4'), 'new-york');
eq('slugPlace: title_place_id with a letter-only id', slugPlace('chief-of-staff_new-york_fqilsriq'), 'new-york');
eq('slugPlace: title_place', slugPlace('marketing-operations-associate_new-york'), 'new-york');
eq('slugPlace: title_place with an eight-letter place', slugPlace('chief-of-staff-to-cto-f-m_bordeaux'), 'bordeaux');
eq('slugPlace: title_place_CODE_id', slugPlace('sales-associate-john-lobb_london_HERMS_VAAxlY9'), 'london');
eq('slugPlace: title_CODE_id has no place', slugPlace('data-engineer-f-h_BSI_ZGLYqL6'), '');
eq('slugPlace: "_" inside the title', slugPlace('manager-partnership-_-hrtech-h-f_boulogne-billancourt'), 'boulogne-billancourt');
eq('slugPlace: "_" inside the title, with an id', slugPlace('data_analyst_london_ab12cd34'), 'london');
eq('slugPlace: a country code is not a place', slugPlace('treasury-operations-manager_gb_7ykrq326'), '');
eq('slugPlace: a district with digits is not a place', slugPlace('business-analyst-f-h_paris-9e'), '');
eq('slugPlace: an id with a digit is not a place', slugPlace('senior-data-engineer_abc123'), '');
eq('slugPlace: a UUID slug has no place', slugPlace('89dd362d-3bd6-4d29-8df3-4fb96638f761'), '');
eq('slugPlace: no underscore, no place', slugPlace('job-1'), '');
// Known limit: "title_fqilsriq" cannot be told from "title_bordeaux". None of
// the 2,437 live slugs has a two-part letter-only id; 49 end in an eight-letter place.
eq('slugPlace: a two-part letter-only id reads as a place (known limit)', slugPlace('chief-of-staff_fqilsriq'), 'fqilsriq');
}
