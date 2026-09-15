// Tests for the rule that a role already in the tracker leaves the inbox.
// Imports inbox-tracked.mjs directly, the one definition pipelineSummary uses.
//
// Run:  node --test tests/lib/inbox-tracked.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseInboxLine } from "../../src/lib/inbox-line.mjs";
import { parseApplications } from "../../src/lib/tracker-table.mjs";
import { markTrackedInbox } from "../../src/lib/inbox-tracked.mjs";

// The fork root, where the tracker parser finds tracker-aliases.json.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// The three lines and tracker rows of 14 September 2026, copied from the real
// files: two ordinary board URLs and one `local:jds/` URL cell, each carrying the
// jd:, route:, fit:, triage: and note: labels the scanner writes.
const PIPELINE = [
  "- [ ] local:jds/mother-root-business-operations-manager-b2a687678d.md | MOTHER ROOT ✸ | Business Operations Manager | London, England, United Kingdom | triage: PASS 4.1 | jd: local:jds/mother-root-business-operations-manager-b2a687678d.md | route: standard",
  "- [ ] https://uk.indeed.com/viewjob?jk=0da9285c18d2000d | Thanks Ben | Chief of Staff | London | jd: local:jds/thanks-ben-chief-of-staff-e42d6c3317.md | route: standard | fit: PASS | note: local:jds/thanks-ben-chief-of-staff-e42d6c3317.md",
  "- [ ] https://uk.indeed.com/viewjob?jk=de724ce043428eb7 | American Express | Campus - Full Time - Product Manager - 2027 (UK - London) | London | jd: local:jds/american-express-campus-full-time-product-manager-2027-uk-london-db4a5cf471.md | route: standard | fit: PASS | note: local:jds/american-express-campus-full-time-product-manager-2027-uk-london-db4a5cf471.md",
  "- [ ] https://jobs.example.com/mother-root-head-of-growth | MOTHER ROOT ✸ | Head of Growth | London | route: standard | fit: PASS",
];

const TRACKER = `# Applications Tracker

| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|-------|--------|-----|--------|-------|
| 221 | 2026-09-14 | Thanks Ben | — | Chief of Staff | 3.8/5 | Applied | ❌ | [221](../reports/221-thanks-ben-2026-09-14.md) | Founder-to-CoS fit at Series B; posted: 2026-09-14 |
| 222 | 2026-09-14 | MOTHER ROOT ✸ | — | Business Operations Manager | 3.8/5 | Applied | ❌ | [222](../reports/222-mother-root-2026-09-14.md) | Strong AI-build fit; posted: 2026-09-12 |
| 225 | 2026-09-14 | American Express | — | Campus - Full Time - Product Manager - 2027 (UK - London) | 2.7/5 | Applied | ❌ | [225](../reports/225-american-express-2026-09-14.md) | Skip: 2027 graduate cohort; posted: 2026-09-14 |
`;

function inbox() {
  return PIPELINE.map((l) => parseInboxLine(l));
}

test("14 September: the three scored and applied rows leave the inbox", () => {
  const out = markTrackedInbox(inbox(), parseApplications(TRACKER, ROOT));
  const pending = out.filter((j) => !j.done).map((j) => `${j.company} | ${j.role}`);
  assert.deepEqual(pending, ["MOTHER ROOT ✸ | Head of Growth"]);
});

test("the row keeps every field it was read with", () => {
  const before = inbox();
  const out = markTrackedInbox(before, parseApplications(TRACKER, ROOT));
  assert.deepEqual(out[1], { ...before[1], done: true });
  assert.equal(before[1].done, false, "the input is not changed");
});

test("company and role match whatever the case, spacing and punctuation", () => {
  const job = parseInboxLine("- [ ] https://x.example/1 | mother root | Business  Operations Manager | London");
  const [out] = markTrackedInbox([job], parseApplications(TRACKER, ROOT));
  assert.equal(out.done, true);
});

test("a location tag keeps the line pending: looser than the scanner, by choice", () => {
  // The scanner strips "(Berlin)" and calls this a duplicate; this key does not
  // strip tags, so the row stays in the inbox until the recheck ticks it.
  const tracker = "| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n| 300 | 2026-09-15 | Acme | — | Product Manager | 3.5/5 | Evaluated | ❌ | - | x |\n";
  const job = parseInboxLine("- [ ] https://x.example/3 | Acme | Product Manager (Berlin) | Berlin");
  assert.equal(markTrackedInbox([job], parseApplications(tracker, ROOT)).at(0).done, false);
});

test("a tracker row with company ? hides nothing (row 93's shape)", () => {
  const tracker = "| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n| 93 | 2026-09-10 | ? | Jack and Jill | Founder's Associate | 3.0/5 | SKIP | ❌ | - | MARGINAL |\n";
  const apps = parseApplications(tracker, ROOT);
  assert.equal(apps.length, 1, "the row is parsed, so the guard is what stops it");
  for (const company of ["?", "✸", "—"]) {
    const job = parseInboxLine(`- [ ] https://x.example/4 | ${company} | Founder's Associate | London`);
    assert.equal(markTrackedInbox([job], apps).at(0).done, false, `company ${company}`);
  }
});

test("a ticked line stays done and an empty tracker hides nothing", () => {
  const ticked = parseInboxLine("- [x] https://x.example/2 | Acme | Analyst");
  assert.equal(markTrackedInbox([ticked], []).at(0).done, true);
  assert.deepEqual(markTrackedInbox(inbox(), []).map((j) => j.done), [false, false, false, false]);
});
