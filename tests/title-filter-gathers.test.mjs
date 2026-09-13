/**
 * tests/title-filter-gathers.test.mjs — C3 of ticket C. Titles gather, they do
 * not certify.
 *
 * The audit's first six tests (`General Career Ops Search Audit and Repair Plan
 * v1.md`, finding F02, acceptance A05 to A07) ran the real title lists and found
 * both errors at once: a bare `Engineer` negative was blocking "Prompt
 * Engineer", and the spelled-out senior grades were bypassed by an intervening
 * word, so "Senior Legal Operations Manager" walked through. C3 is a
 * configuration change with no code behind it, so this file is the only place
 * the change is asserted.
 *
 * It runs twice. Against a fixture object carrying the changed lines, and
 * against a `portals.yml` written to a temp directory and parsed as YAML, the
 * way the scan reads it. It never reads the live `portals.yml`: that file is
 * user layer and gitignored, so an assertion on it proved nothing anywhere but
 * this machine, and a hand edit to it could fail the suite (Ca build review,
 * fix 5).
 *
 * Nothing here touches the network.
 *
 * Run: node test-all.mjs --only title-filter-gathers
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { buildTitleFilter } from '../scan.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nportals.yml — titles gather plausible roles, they do not certify a fit (C3)');

// The audit's T01 to T06, with the behaviour its acceptance column asks for
// rather than the behaviour it observed. `true` means the title reaches the
// advert; reaching the advert is not a fit and never was.
const AUDIT = [
  ['T01', 'Senior Operations Manager', false, 'the specific phrase that already worked'],
  ['T02', 'Senior Legal Operations Manager', false, 'an intervening word no longer bypasses the grade'],
  ['T03', 'Senior Sensors Product Manager', false, 'nor on the product side'],
  ['T04', 'Prompt Engineer', true, 'unconventional AI work is no longer cut before the advert'],
  ['T05', 'Growth Marketing Manager', true, 'the positive list now carries this function wording'],
  ['T06', 'Deployment Specialist', true, 'and a relevant title stays discoverable'],
];

// What C3 must NOT have broken. Every engineering title the bare word used to
// carry, and the quota seats, and the grades above his level.
const STILL_CUT = [
  'Applied AI Engineer',
  'Solutions Engineer',
  'Solution Engineer',
  'Forward Deployed Engineer',
  'Software Engineer',
  'Backend Engineer',
  'Machine Learning Engineer',
  'Data Engineer',
  'Platform Engineer',
  // Fix 5: the specialist engineering titles the bare word used to stop, with
  // nothing in content_filter to stop them by the advert.
  'Staff QA Automation Engineer',
  'Test Engineer',
  'Staff Engineer',
  'SRE',
  'DevOps Engineer',
  'Site Reliability Engineer',
  'Account Executive',
  'Customer Success Manager',
  'Head of Product',
  'Director of Operations',
  'VP Product',
  'Principal Product Manager',
  'Senior Product Manager',
];

// A suite that only proves rejections proves nothing. These are the roles the
// search exists to find.
const STILL_KEPT = [
  'Chief of Staff',
  'Business Operations Manager',
  'Product Manager',
  'Product Owner',
  'Strategy & Operations Manager',
  'Growth Associate',
  'Applied AI Lead',
  'AI Operations Manager',
  'Forward Deployed Strategist',
  'Founders Associate',
  'Operations Associate',
  'Partnerships Manager',
];

function check(label, titleFilter) {
  let wrong = 0;
  for (const [id, title, expected, why] of AUDIT) {
    const got = titleFilter(title);
    if (got === expected) pass(`${label} ${id} "${title}" → ${expected ? 'reaches the advert' : 'cut'} — ${why}`);
    else { wrong++; fail(`${label} ${id} "${title}" → ${got}, expected ${expected}`); }
  }

  const leaked = STILL_CUT.filter(t => titleFilter(t));
  if (leaked.length === 0) pass(`${label} all ${STILL_CUT.length} engineering, quota and senior-grade titles are still cut`);
  else { wrong++; fail(`${label} these should still be cut: ${leaked.join(', ')}`); }

  const lost = STILL_KEPT.filter(t => !titleFilter(t));
  if (lost.length === 0) pass(`${label} all ${STILL_KEPT.length} target titles still reach the advert`);
  else { wrong++; fail(`${label} these should still reach the advert: ${lost.join(', ')}`); }

  return wrong;
}

// ── 1. The fixture: the changed lines, and nothing else ──────────────
// Trimmed to what C3 touches plus the entries those changes could collide
// with, so the assertions read as the rule rather than as a copy of the file.

const fixture = {
  positive: [
    'Operations Associate', 'Business Operations', 'Growth Associate', 'Growth Manager',
    'Growth Marketing Manager', 'Prompt Engineer',
    'Chief of Staff', "Founder's Associate", 'Founders Associate',
    'Strategy & Operations', 'Operations Manager',
    'AI Operations', 'AI Product', 'Applied AI', 'Forward Deployed', 'Deployment Specialist',
    'Product Manager', 'Product Owner', 'Partnerships Manager',
  ],
  negative: [
    'Applied AI Engineer', 'Solution Engineer', 'Solutions Engineer', 'Forward Deployed Engineer',
    'Developer', 'Architect', 'Scientist', 'Software Engineer', 'Backend', 'Machine Learning Engineer',
    'Data Engineer', 'Platform Engineer',
    'DevOps', 'Site Reliability', 'Automation Engineer', 'Test Engineer', 'Staff Engineer', 'SRE',
    'Account Executive', 'Account Manager', 'Customer Success Manager',
    'Senior Product', 'Senior Operations Manager', 'Senior',
    'Sr', 'Principal', 'Director', 'Head of', 'VP',
  ],
};
check('fixture:', buildTitleFilter(fixture));

// ── 2. The same lines as a portals.yml, read the way the scan reads it ─
// Written to a temp directory, never the live file, as
// portals-search-queries-removed.test.mjs does.

const PORTALS_YML = `title_filter:
  positive:
${fixture.positive.map(e => `    - ${JSON.stringify(e)}`).join('\n')}
  negative:
${fixture.negative.map(e => `    - ${JSON.stringify(e)}`).join('\n')}
content_filter:
  negative: []
`;

{
  const dir = mkdtempSync(join(tmpdir(), 'portals-title-gathers-'));
  try {
    const portals = join(dir, 'portals.yml');
    writeFileSync(portals, PORTALS_YML);
    const config = yaml.load(readFileSync(portals, 'utf-8'));
    const titleFilter = buildTitleFilter(config?.title_filter);
    check('portals.yml:', titleFilter);

    // The four lines C3 changed, asserted as lines rather than as behaviour,
    // so a later edit that reverts one is named rather than merely observed.
    const positive = (config?.title_filter?.positive || []).map(String);
    const negative = (config?.title_filter?.negative || []).map(String);
    const has = (list, entry) => list.some(e => e.toLowerCase() === entry.toLowerCase());

    if (!has(negative, 'Engineer')) pass('the bare Engineer negative is gone');
    else fail('portals.yml still carries a bare "Engineer" negative');

    const forms = ['Applied AI Engineer', 'Solution Engineer', 'Solutions Engineer', 'Forward Deployed Engineer'];
    const missing = forms.filter(f => !has(negative, f));
    if (missing.length === 0) pass('and the four specific forms it was added for are there instead');
    else fail(`missing engineering negatives: ${missing.join(', ')}`);

    if (has(positive, 'Growth Marketing Manager') && has(positive, 'Prompt Engineer')) {
      pass('"Growth Marketing Manager" and "Prompt Engineer" are on the positive list');
    } else {
      fail('the two new positive entries are not both present');
    }

    if (has(negative, 'Senior')) pass('"Senior" is a bare negative, which is his 9 September cut');
    else fail('the bare "Senior" negative is absent');

    // C1's other half: the years phrases left content_filter in the same change.
    const content = (config?.content_filter?.negative || []).map(String);
    const years = content.filter(e => /\d|one|two|three|four|five|six|seven|eight|nine|ten/i.test(e) && /year|yr/i.test(e));
    if (years.length === 0) pass('and content_filter carries no years phrases — the reader has them now');
    else fail(`content_filter still carries ${years.length} years phrases: ${years.slice(0, 3).join(', ')}…`);

    // Fix 5: the specialist engineering backstop is on the title list, and
    // content_filter stays empty.
    const specialist = ['Automation Engineer', 'Test Engineer', 'Staff Engineer', 'DevOps', 'SRE', 'Site Reliability'];
    const absent = specialist.filter(f => !has(negative, f));
    if (absent.length === 0) pass('the six specialist engineering forms are title negatives');
    else fail(`missing specialist engineering negatives: ${absent.join(', ')}`);
    if (content.length === 0) pass('and nothing was put into content_filter.negative');
    else fail(`content_filter.negative is not empty: ${content.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
