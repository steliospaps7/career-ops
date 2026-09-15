// tests/company-aliases-row-validity.test.mjs — one company under two names.
//
// The 15 September 2026 17:00 scheduled run queued six rows. Two were the same
// company under a second name: "Heidi" (Ashby org name) for a Partnerships
// Associate role the tracker already holds as "Heidi Health", and "Scope"
// (Ashby getscope) next to "Scope AI" (Indeed) for one Chief of Staff role.
// The company+role dedup key lowercases the company and nothing more, so both
// passed. `company_aliases` in portals.yml is the seam: these tests hold the
// alias lines added for those two companies and show that, with them, the
// tracker check drops the Heidi row and the within-run collapse drops the
// second Scope row, while the other four rows stay.
//
// The fixture rows are the real queue lines and tracker rows, with the fit
// reasons and tracker notes cut to keep personal notes out of the repo.
import { pass, fail } from './helpers.mjs';
import {
  buildCompanyCanonicalizer,
  collectSeenCompanyRoles,
  companyRoleDedupKey,
  normalizeUrlForDedup,
} from '../scan.mjs';

console.log('\nscan.mjs — company aliases: the 15 September 17:00 rows');

// The lines added to portals.yml on 15 September 2026.
const ALIASES = {
  'Heidi Health': ['Heidi'],
  'Scope AI': ['Scope'],
};

// Tracker rows 72 and 77, header as in the live tracker (it has a Via column).
const APPLICATIONS = `# Applications Tracker

| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|-------|--------|-----|--------|-------|
| 72 | 2026-09-06 | Heidi Health | — | Partnerships Associate | 3.8/5 | SKIP | ❌ | [072](../reports/072-heidi-health-2026-09-06.md) | posted: 2026-09-02 |
| 77 | 2026-09-06 | Heidi | — | Automation & Lifecycle Specialist | 4.0/5 | Applied | ❌ | [077](../reports/077-heidi-2026-09-06.md) | posted: 2026-09-02 |
`;

// The six rows of the 17:00 run, in the order the queue holds them.
const RUN = [
  { url: 'https://jobs.ashbyhq.com/heidihealth.com.au/fb77fa71-8fe1-452f-928a-221d515dea3f', company: 'Heidi', title: 'Partnerships Associate' },
  { url: 'https://uk.indeed.com/viewjob?jk=a0a4ebf4fdcff566', company: 'Scope AI', title: 'Chief of Staff' },
  { url: 'https://jobs.ashbyhq.com/getscope/95f57c60-feb7-49e7-8390-0989b4418f21', company: 'Scope', title: 'Chief of Staff' },
  { url: 'https://uk.indeed.com/viewjob?jk=2e10e68d3f7ff114', company: 'GetGround', title: 'Founders Associate' },
  { url: 'https://jobs.deel.com/klarna/job-details/7d04c8ad-fa8f-4248-b55a-bd5ff5d6aa4a/overview', company: 'Klarna', title: 'Business Development Associate — Media Sales & Partnerships' },
  { url: 'https://uk.indeed.com/viewjob?jk=f31f31a98150b38f', company: 'Investec', title: 'Technical Product Owner (Corporate Transactional Banking)' },
];

// The two dedup checks scan.mjs runs on each provider row, in its order: the
// URL, then company+role against the set seeded from the tracker, then the key
// is added so a later row in the same run collapses onto it.
function runDedup(rows, canonicalize) {
  const seenUrls = new Set();
  const seenCompanyRoles = collectSeenCompanyRoles({ applicationsText: APPLICATIONS }, {}, canonicalize);
  const kept = [];
  const dropped = [];
  for (const row of rows) {
    const url = normalizeUrlForDedup(row.url);
    const key = companyRoleDedupKey(row.company, row.title, canonicalize);
    if (seenUrls.has(url) || seenCompanyRoles.has(key)) {
      dropped.push(row.company);
      continue;
    }
    seenUrls.add(url);
    seenCompanyRoles.add(key);
    kept.push(row.company);
  }
  return { kept, dropped };
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── 1. The cause: without aliases all six rows pass ─────────────────────────
{
  const { kept } = runDedup(RUN, buildCompanyCanonicalizer(undefined));
  if (kept.length === 6) {
    pass('without company_aliases all six 17:00 rows pass dedup (the fault Stelios saw)');
  } else {
    fail(`without aliases expected six rows kept, got ${kept.length}: [${kept.join(', ')}]`);
  }
}

// ── 2. With the alias lines: Heidi and the second Scope drop, four stay ─────
{
  const { kept, dropped } = runDedup(RUN, buildCompanyCanonicalizer(ALIASES));
  if (same(dropped, ['Heidi', 'Scope']) && same(kept, ['Scope AI', 'GetGround', 'Klarna', 'Investec'])) {
    pass('with the alias lines the Heidi row and the second Scope row drop; Scope AI, GetGround, Klarna and Investec stay');
  } else {
    fail(`aliased run wrong: kept=[${kept.join(', ')}] dropped=[${dropped.join(', ')}]`);
  }
}

// ── 3. Heidi drops on the tracker, not on the within-run collapse ───────────
{
  const canonicalize = buildCompanyCanonicalizer(ALIASES);
  const seen = collectSeenCompanyRoles({ applicationsText: APPLICATIONS }, {}, canonicalize);
  const heidiKey = companyRoleDedupKey('Heidi', 'Partnerships Associate', canonicalize);
  if (
    seen.has(heidiKey) &&
    seen.has(companyRoleDedupKey('Heidi Health', 'Automation & Lifecycle Specialist', canonicalize))
  ) {
    pass('tracker rows 72 ("Heidi Health") and 77 ("Heidi") both seed keys under one company, so the scan-side "Heidi" matches row 72');
  } else {
    fail(`tracker seed wrong: keys=[${[...seen].join(', ')}], scan key=${heidiKey}`);
  }
}

// ── 4. Scope collapses whichever of the two arrives first ───────────────────
// Sources finish in parallel, so the order in the queue is not fixed.
{
  const scopeFirst = [RUN[2], RUN[1]];
  const { kept, dropped } = runDedup(scopeFirst, buildCompanyCanonicalizer(ALIASES));
  if (same(kept, ['Scope']) && same(dropped, ['Scope AI'])) {
    pass('with Scope (Ashby) first, Scope AI (Indeed) is the one that collapses');
  } else {
    fail(`reverse order wrong: kept=[${kept.join(', ')}] dropped=[${dropped.join(', ')}]`);
  }
}

// ── 5. Aliases do not reach other roles or other companies ──────────────────
{
  const canonicalize = buildCompanyCanonicalizer(ALIASES);
  const other = [
    { url: 'https://jobs.ashbyhq.com/getscope/other', company: 'Scope', title: 'Founding Account Executive' },
    { url: 'https://jobs.example.com/heidi-other', company: 'Heidi', title: 'Customer Success Manager' },
    { url: 'https://jobs.example.com/scope-x', company: 'Scopely', title: 'Chief of Staff' },
    { url: 'https://jobs.example.com/heidi-x', company: 'Heidi Labs', title: 'Partnerships Associate' },
  ];
  const { kept } = runDedup(other, canonicalize);
  if (kept.length === 4) {
    pass('a different role at an aliased company, and a company that only starts with the same word, still pass');
  } else {
    fail(`aliases reached too far: kept=[${kept.join(', ')}]`);
  }
}

// ── 6. No automatic rule: Bolt and Scale stay apart from their longer names ─
{
  const canonicalize = buildCompanyCanonicalizer(ALIASES);
  if (
    canonicalize('Bolt') !== canonicalize('Bolt Financial') &&
    canonicalize('Scale') !== canonicalize('Scale AI')
  ) {
    pass('names outside the alias map are not merged by first word or suffix (Bolt / Bolt Financial, Scale / Scale AI)');
  } else {
    fail('an alias-free pair was merged: the canonicalizer is doing more than the alias map');
  }
}

// ── 7. The guard stays: an alias claimed by two companies merges nothing ────
{
  const canonicalize = buildCompanyCanonicalizer({ ...ALIASES, 'Scope Charity': ['Scope'] });
  if (canonicalize('Scope') === 'scope' && canonicalize('Scope AI') === 'scope ai') {
    pass('an alias claimed by two canonical names fails open as its own name');
  } else {
    fail(`ambiguous alias merged: Scope -> ${canonicalize('Scope')}`);
  }
}
