/**
 * tests/wttj-new-york-location.test.mjs — a New York job is not read as York,
 * United Kingdom.
 *
 * On 15 September 2026 eight Welcome to the Jungle rows reached the queue as
 * "York, United Kingdom". Every one is a US job. The scanner did not turn "New
 * York" into "York": WTTJ's own index returned the office as city "York",
 * country "United Kingdom", country code "GB", and providers/wttj.mjs copied
 * it. The job slug still names the real place ("_new-york_", "_houston_").
 * The provider now leaves the country out when the office city and the slug
 * place disagree.
 *
 * The hits below are the eight real ones, their office records as WTTJ
 * returned them on 15 September. The location filter is a copy of the
 * `location_filter` in Stelios's portals.yml on that day, not a read of it.
 *
 * Nothing here touches the network.
 *
 * Run: node test-all.mjs --only wttj-new-york-location
 */

import { normalizeWttjHit, slugPlace } from '../providers/wttj.mjs';
import { buildLocationFilter, judgeAttendance } from '../scan.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nproviders/wttj.mjs — a New York job is not read as York, United Kingdom');

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const LOCATION_FILTER = {
  always_allow: ['London'],
  allow: ['London', 'United Kingdom', 'UK', 'Hybrid'],
  block: [
    'Belfast', 'Manchester', 'Birmingham', 'Edinburgh', 'Glasgow', 'Bristol', 'Leeds',
    'Cardiff', 'Cambridge', 'Oxford', 'Reading', 'Brighton', 'United States', 'New York',
    'San Francisco', 'Germany', 'Berlin', 'France', 'Paris', 'Spain', 'Netherlands',
    'Amsterdam', 'Ireland', 'Dublin',
  ],
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

// What slugPlace reads, and what it leaves alone.
eq('slugPlace: title_place_id', slugPlace('chief-of-staff_new-york_fqilsriq'), 'new-york');
eq('slugPlace: title_place', slugPlace('marketing-operations-associate_new-york'), 'new-york');
eq('slugPlace: a country code is not a place', slugPlace('treasury-operations-manager_gb_7ykrq326'), '');
eq('slugPlace: an id with a digit is not a place', slugPlace('senior-data-engineer_abc123'), '');
eq('slugPlace: no underscore, no place', slugPlace('job-1'), '');
eq('Accents: Zürich office with a zurich slug is the same place',
  normalizeWttjHit(hit('acme', 'role_zurich_ab12cd34', { city: 'Zürich', country: 'Switzerland' })).location, 'Zürich, Switzerland');
