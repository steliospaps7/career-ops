/**
 * tests/wttj-office-address.test.mjs — ticket 6: a Welcome to the Jungle row is
 * judged on its office address, and a row whose advert came back empty is
 * dropped and named in the per-source log.
 *
 * The evidence. WTTJ's search index filed New York offices as city "York",
 * country "United Kingdom". PR #13 reads the place out of the job slug, which
 * catches "_new-york_", but on 20 September Fluent's slug itself said "_york_"
 * and the row reached the queue as "York, United Kingdom". The job's own API
 * record said `address: "New York, NY"`. The four rows ticked on 20 September
 * (Duolingo, Viam, US Mobile, Anthropic) are the address fixtures and, with
 * their empty stored adverts, the empty-body fixtures.
 *
 * Nothing here touches the network or personal files: the location filter is
 * an inline copy of the shape portals.yml uses, and transports are injected.
 *
 * Run: node test-all.mjs --only wttj-office-address
 */

import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildLocationFilter,
  buildWttjAdvertCheck,
  buildAdvertReader,
  fillJobAdvert,
  createSourceLedger,
  appendScanSources,
  reconcileSourceLedger,
  formatAdvertDropRow,
  SOURCE_DROP_REASONS,
  ADVERT_DROP_REASONS,
  ADVERT_DROP_LABELS,
} from '../scan.mjs';
import {
  normalizeWttjHit,
  wttjApiUrl,
  wttjAdvertText,
  wttjOfficeAddresses,
  OFFICE_ADDRESS_PREFIX,
} from '../providers/wttj.mjs';
import { resolveReadRoute, readAdvert, saveAdvert } from '../providers/_advert-reader.mjs';
import { pass, fail, rmSync, ROOT } from './helpers.mjs';

console.log('\nWelcome to the Jungle — the office address and the empty advert (ticket 6)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'co-wttj-address-'));
  dirs.push(d);
  return d;
}

// The shape of portals.yml's location_filter, cut to the entries these rows touch.
const LOCATION_FILTER = {
  always_allow: ['London'],
  allow: ['London', 'United Kingdom', 'UK', 'Hybrid'],
  block: ['Manchester', 'Cambridge', 'Reading', 'United States', 'New York', 'San Francisco', 'France', 'Paris', 'Ireland'],
  block_hard: ['United Arab Emirates', 'Brazil', 'Japan'],
};

const BODY_HTML = '<p>' + 'You will run the operating cadence, the reporting and the partner programme. '.repeat(8) + '</p>';

/** A job's own API record, as api.welcometothejungle.com returns it. */
function record(offices, { description = BODY_HTML, profile = '<ul><li>Three years in operations</li></ul>' } = {}) {
  return {
    job: {
      name: 'Role',
      status: 'published',
      description,
      profile,
      office: offices[0] || null,
      offices,
    },
  };
}

// The mislabel exactly as the ticket quotes it.
const NEW_YORK_MISLABELLED = { address: 'New York, NY', city: 'York', country_code: 'GB' };

// ── The four rows ticked on 20 September, and the Fluent `_york_` row ──
const TWENTIETH = [
  { company: 'Duolingo', title: 'Strategy and Business Operations Manager', org: 'duolingo', slug: 'strategy-and-business-operations-manager_new-york_4vxj3xxq' },
  { company: 'Viam', title: 'Chief of Staff', org: 'viam', slug: 'chief-of-staff_new-york_uuusjbz4' },
  { company: 'US Mobile', title: 'Chief of Staff', org: 'us-mobile', slug: 'chief-of-staff_new-york_fqilsriq' },
  { company: 'Anthropic', title: 'Research Engineer (Applied AI)', org: 'anthropic', slug: 'research-engineer-applied-ai_new-york_b6h7xogn' },
];
const FLUENT = { company: 'Fluent', title: 'Business Operations Manager (Partnerships)', org: 'fluent', slug: 'business-operations-manager-partnerships_york_v6teslps' };
const pageUrl = (r) => `https://www.welcometothejungle.com/en/companies/${r.org}/jobs/${r.slug}`;

const check = buildWttjAdvertCheck(LOCATION_FILTER);
const locationFilter = buildLocationFilter(LOCATION_FILTER);

// ── The reader goes to the job's own record ─────────────────────────
for (const r of [...TWENTIETH, FLUENT]) {
  const route = resolveReadRoute(pageUrl(r));
  eq(`${r.company}: the reader asks the job's own record first`, route && { kind: route.kind, host: route.host, url: route.url }, {
    kind: 'feed',
    host: 'wttj',
    url: `https://api.welcometothejungle.com/api/v1/organizations/${r.org}/jobs/${r.slug}`,
  });
}
eq('a WTTJ URL outside /companies/<org>/jobs/<slug> has no record route', wttjApiUrl('https://www.welcometothejungle.com/en/jobs'), null);
eq('nor does a slug with characters outside the safe set', wttjApiUrl('https://www.welcometothejungle.com/en/companies/acme/jobs/a%2F..%2Fb'), null);
eq('nor another host', wttjApiUrl('https://app.welcometothejungle.com/jobs/abc123'), null);
eq('nor plain http', wttjApiUrl('http://www.welcometothejungle.com/en/companies/acme/jobs/ops_london_x'), null);

// ── The address is stored at the top of the advert ─────────────────
{
  const text = wttjAdvertText(record([NEW_YORK_MISLABELLED]));
  ok('the advert opens with the office address', text.startsWith(`${OFFICE_ADDRESS_PREFIX}New York, NY\n\n`));
  ok('and carries the job description after it', text.includes('operating cadence'));
  ok('and the profile sought', text.includes('Three years in operations'));
  eq('the address reads back from the stored text', wttjOfficeAddresses(text), ['New York, NY']);
  eq('the mislabelled city "York" is never used when the address is there', wttjOfficeAddresses(text).some((a) => /^York\b/.test(a)), false);
}
eq('an office with no address falls back to city and country code',
  wttjOfficeAddresses(wttjAdvertText(record([{ address: null, city: 'Paris', country_code: 'FR' }]))), ['Paris, FR']);
eq('a record with no description and no profile gives no text, so the reader moves on to the page',
  wttjAdvertText(record([NEW_YORK_MISLABELLED], { description: '', profile: null })), '');
eq('only the leading block is read: an address line inside the advert is not an office',
  wttjOfficeAddresses(`We hire widely.\n${OFFICE_ADDRESS_PREFIX}Paris, France`), []);

// ── readAdvert end to end, with the record injected ─────────────────
{
  const asked = [];
  const transports = {
    fetchJson: async (url) => { asked.push(url); return { status: 200, json: record([NEW_YORK_MISLABELLED]) }; },
    fetchText: async () => { throw new Error('the page should not be needed'); },
  };
  const out = await readAdvert(pageUrl(TWENTIETH[0]), transports);
  eq('Duolingo: read from the record', { status: out.status, rung: out.rung }, { status: 'read', rung: 'feed' });
  eq('Duolingo: one call, to the record', asked, [`https://api.welcometothejungle.com/api/v1/organizations/duolingo/jobs/${TWENTIETH[0].slug}`]);
  eq('Duolingo: the stored text names New York', wttjOfficeAddresses(out.text), ['New York, NY']);
}

// ── Part 1: the address decides ─────────────────────────────────────
for (const r of TWENTIETH) {
  const hit = {
    name: r.title,
    slug: r.slug,
    organization: { slug: r.org, name: r.company },
    offices: [{ city: 'York', country: 'United Kingdom', country_code: 'GB' }],
  };
  const text = wttjAdvertText(record([NEW_YORK_MISLABELLED]));
  eq(`${r.company}: New York, NY is dropped on its address`, check(text), { drop: true, reason: 'location', phrase: 'New York, NY' });
  // PR #13's slug reading still covers these at the free filter.
  eq(`${r.company}: the slug reading of PR #13 is unchanged`, normalizeWttjHit(hit).location, 'York');
}
{
  const hit = {
    name: FLUENT.title,
    slug: FLUENT.slug,
    organization: { slug: FLUENT.org, name: FLUENT.company },
    offices: [{ city: 'York', country: 'United Kingdom', country_code: 'GB' }],
  };
  const location = normalizeWttjHit(hit).location;
  eq('Fluent `_york_`: the slug agrees with the wrong city, so the index row reads York, United Kingdom', location, 'York, United Kingdom');
  eq('Fluent `_york_`: and the free location filter passes it, which is how it reached the queue', locationFilter(location, pageUrl(FLUENT), FLUENT.title), true);
  const text = wttjAdvertText(record([{ address: 'New York, NY', city: 'York', country_code: 'GB' }]));
  eq('Fluent `_york_`: the office address drops it', check(text), { drop: true, reason: 'location', phrase: 'New York, NY' });
}
eq('"New York, NY" alone is dropped', check(wttjAdvertText(record([{ address: 'New York, NY' }]))), { drop: true, reason: 'location', phrase: 'New York, NY' });
eq('a real York, England office is kept: no block entry names it',
  check(wttjAdvertText(record([{ address: 'York, England', city: 'York', country_code: 'GB' }]))), { drop: false });
eq('a London office with a second office abroad is kept',
  check(wttjAdvertText(record([{ address: 'London, United Kingdom', city: 'London', country_code: 'GB' }, { address: 'Paris, France', city: 'Paris', country_code: 'FR' }]))), { drop: false });
eq('the London-first record is kept whichever office is listed first',
  check(wttjAdvertText(record([{ address: 'Paris, France' }, { address: '1 Finsbury Avenue, London EC2M 2PF' }]))), { drop: false });
eq('two offices, both blocked, are dropped and both named',
  check(wttjAdvertText(record([{ address: 'New York, NY' }, { address: 'Paris, France' }]))), { drop: true, reason: 'location', phrase: 'New York, NY · Paris, France' });
eq('block_hard wins over always_allow, as in the location filter',
  check(`${OFFICE_ADDRESS_PREFIX}London Road, Dubai, United Arab Emirates\n\nAdvert.`), { drop: true, reason: 'location', phrase: 'London Road, Dubai, United Arab Emirates' });
eq('"Newcastle" is not "New York": whole words only', check(`${OFFICE_ADDRESS_PREFIX}Newcastle upon Tyne, England\n\nAdvert.`), { drop: false });
eq('an advert read from the page, with no address lines, is kept', check('Operations Manager. '.repeat(30)), { drop: false });
eq('a filter with no block list drops nothing on the address', buildWttjAdvertCheck(undefined)(wttjAdvertText(record([NEW_YORK_MISLABELLED]))), { drop: false });

// ── Part 2: the empty advert ────────────────────────────────────────
eq('an empty advert is dropped', check(''), { drop: true, reason: 'empty' });
eq('whitespace is empty', check('  \n '), { drop: true, reason: 'empty' });
eq('no description at all is empty', check(undefined), { drop: true, reason: 'empty' });
{
  // The four rows as they sit in jds/ today: a stored stub, read_status
  // unreadable, no text. The sweep reuses the stub and the row is dropped.
  const jdsDir = tempDir();
  const deadTransports = {
    fetchText: async () => { throw new Error('offline'); },
    fetchJson: async () => { throw new Error('offline'); },
  };
  const reader = buildAdvertReader({ jdsDir, transports: deadTransports });
  for (const r of TWENTIETH) {
    const url = pageUrl(r);
    saveAdvert({ url, company: r.company, title: r.title, location: 'York, United Kingdom', text: '', rung: null, status: 'unreadable', finalUrl: url, source: 'scan-reader' }, { jdsDir });
    const job = { url, company: r.company, title: r.title, location: 'York, United Kingdom' };
    const outcome = await fillJobAdvert(job, reader, 'Welcome to the Jungle');
    ok(`${r.company}: the stored stub is reused, not fetched`, outcome && outcome.reused === true);
    eq(`${r.company}: the empty advert drops the row`, check(job.description), { drop: true, reason: 'empty' });
  }
}
{
  // A fresh read that fails everywhere is empty too, and is dropped.
  const jdsDir = tempDir();
  const reader = buildAdvertReader({
    jdsDir,
    transports: {
      fetchText: async () => ({ status: 200, body: '<html><body>Loading</body></html>' }),
      fetchJson: async () => ({ status: 200, json: record([NEW_YORK_MISLABELLED], { description: '', profile: '' }) }),
    },
  });
  const job = { url: pageUrl(TWENTIETH[1]), company: 'Viam', title: 'Chief of Staff', location: 'York, United Kingdom' };
  const outcome = await fillJobAdvert(job, reader, 'Welcome to the Jungle');
  eq('a record and a page with no advert read as unreadable', outcome.status, 'unreadable');
  eq('and the row is dropped as empty', check(job.description), { drop: true, reason: 'empty' });
}

// ── The source log names the drop ───────────────────────────────────
{
  const keys = SOURCE_DROP_REASONS.map((r) => r.key);
  ok('the source log has a reason for an empty advert', keys.includes('advertEmpty'));
  ok('in sweep order: after advert expired, before content',
    keys.indexOf('advertEmpty') === keys.indexOf('advertExpired') + 1 && keys.indexOf('advertEmpty') < keys.indexOf('content'));

  const ledger = createSourceLedger();
  ledger.register('Welcome to the Jungle');
  ledger.found('Welcome to the Jungle', 6);
  ledger.keep('Welcome to the Jungle');
  for (let i = 0; i < 4; i++) ledger.drop('Welcome to the Jungle', 'advertEmpty');
  ledger.drop('Welcome to the Jungle', 'location');
  eq('the run totals reconcile with the new reason', reconcileSourceLedger(ledger, { found: 6, kept: 1, advertEmpty: 4, location: 1 }), []);
  ok('a run total that forgets it is caught',
    reconcileSourceLedger(ledger, { found: 6, kept: 1, location: 1 }).some((m) => m.field === 'advertEmpty'));

  const logDir = tempDir();
  const logPath = join(logDir, 'scan-sources.tsv');
  appendScanSources(ledger.records(), '2026-09-23T00:00:00.000Z', logPath);
  const row = readFileSync(logPath, 'utf-8').trim().split('\n').pop().split('\t');
  eq('the drop_reasons cell says so', row[8], 'location=1 advert empty=4');
}
{
  ok('the DROP line has a reason for it', ADVERT_DROP_REASONS.includes('empty') && ADVERT_DROP_LABELS.empty === 'advert empty');
  eq('and names the stored stub, so it can be opened',
    formatAdvertDropRow({ company: 'Duolingo', title: 'Strategy and Business Operations Manager', reason: 'empty', jdPath: 'jds/duolingo-strategy-and-business-operations-manager-ec3fec245a.md' }),
    'DROP | Duolingo | Strategy and Business Operations Manager | advert empty | jd: local:jds/duolingo-strategy-and-business-operations-manager-ec3fec245a.md');
  eq('an address drop quotes the address',
    formatAdvertDropRow({ company: 'Fluent', title: FLUENT.title, reason: 'location', phrase: 'New York, NY', url: pageUrl(FLUENT) }),
    `DROP | Fluent | ${FLUENT.title} | location: "New York, NY" | ${pageUrl(FLUENT)}`);
}

// ── The sweep applies it to Welcome to the Jungle rows only ─────────
{
  const src = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  const sweep = src.slice(src.indexOf("sourceLedger.drop(company.name, 'advertExpired');"));
  const block = sweep.slice(0, sweep.indexOf('const verdict = advertGate('));
  ok('the sweep checks the row after the read and before the advert gate', block.includes('wttjAdvertCheck(job.description)'));
  ok('only for the wttj provider: other boards keep an unread row, labelled and listed', block.includes("provider.id === 'wttj'"));
  ok('an empty advert counts under advertEmpty', block.includes("sourceLedger.drop(company.name, 'advertEmpty')"));
  ok('an address drop counts under location, with the free filter\'s drops', block.includes("sourceLedger.drop(company.name, 'location')"));
  ok('the run total for the new reason reaches the reconciliation', /advertEmpty: totalFilteredAdvertEmpty/.test(src));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
