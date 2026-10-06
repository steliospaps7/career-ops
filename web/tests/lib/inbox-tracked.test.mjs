// Tests for the rule that a role already in the tracker leaves the inbox.
// Imports inbox-tracked.mjs directly, the one definition pipelineSummary uses.
//
// Run:  node --test tests/lib/inbox-tracked.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseInboxLine } from "../../src/lib/inbox-line.mjs";
import { parseApplications } from "../../src/lib/tracker-table.mjs";
import { markTrackedInbox, postingId } from "../../src/lib/inbox-tracked.mjs";

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
  assert.deepEqual(out[1], { ...before[1], done: true, tracked: { n: "221", status: "Applied", date: "2026-09-14" } });
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

// 6 October 2026: tracker row 338 and the pending line for the same LinkedIn
// advert, copied from the real files. The names differ, the posting id does not.
const BRIDEBOOK_LINE =
  "- [ ] https://uk.linkedin.com/jobs/view/performance-marketing-associate-at-bridebook-the-no-1-wedding-planning-app-4475542689?position=17&pageNum=0&refId=jy4hCWvNW7AHN129HV6xyw%3D%3D&trackingId=Gcr5nZuZjyk3Lvife4Gt3g%3D%3D | Bridebook - The No.1 Wedding Planning App | Performance Marketing Associate | London Area, United Kingdom | jd: local:jds/bridebook-the-no-1-wedding-planning-app-performance-marketing-associate-297ef02ffd.md | route: standard | fit: PASS";
const BRIDEBOOK_TRACKER =
  "| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n| 338 | 2026-10-05 | Bridebook | — | Performance Marketing Associate | 2.4/5 | Evaluated | ❌ | [338](../reports/338-bridebook-2026-10-05.md) | Skip: coached entry-level paid-ads seat |\n";
const BRIDEBOOK_REPORT =
  "# Evaluation: Bridebook — Performance Marketing Associate\n\n**Date:** 2026-10-05\n**URL:** https://uk.linkedin.com/jobs/view/performance-marketing-associate-at-bridebook-the-no-1-wedding-planning-app-4475542689?position=17&pageNum=0&refId=jy4hCWvNW7AHN129HV6xyw%3D%3D&trackingId=Gcr5nZuZjyk3Lvife4Gt3g%3D%3D\n**Score:** 2.4/5\n";

function reports(files) {
  const reads = [];
  const read = (rel) => {
    reads.push(rel);
    return rel in files ? files[rel] : null;
  };
  return { read, reads };
}

test("6 October: a scored row whose company differs but whose posting id matches is hidden", () => {
  const { read } = reports({ "../reports/338-bridebook-2026-10-05.md": BRIDEBOOK_REPORT });
  const [out] = markTrackedInbox([parseInboxLine(BRIDEBOOK_LINE)], parseApplications(BRIDEBOOK_TRACKER, ROOT), read);
  assert.equal(out.done, true);
  assert.deepEqual(out.tracked, { n: "338", status: "Evaluated", date: "2026-10-05" });
});

test("tracking parameters differ but the posting id matches: hidden", () => {
  const { read } = reports({ "../reports/338-bridebook-2026-10-05.md": BRIDEBOOK_REPORT });
  const line = BRIDEBOOK_LINE.replace(/\?position=[^ ]*/, "?position=3&pageNum=1&refId=OTHER&trackingId=OTHER").replace("uk.linkedin.com", "www.linkedin.com");
  const [out] = markTrackedInbox([parseInboxLine(line)], parseApplications(BRIDEBOOK_TRACKER, ROOT), read);
  assert.equal(out.done, true);
  assert.equal(out.tracked.n, "338");
});

test("a different posting id at the same company stays shown", () => {
  const { read } = reports({ "../reports/338-bridebook-2026-10-05.md": BRIDEBOOK_REPORT });
  const line = BRIDEBOOK_LINE.replace("performance-marketing-associate-at-bridebook-the-no-1-wedding-planning-app-4475542689", "crm-executive-at-bridebook-the-no-1-wedding-planning-app-4475542690").replace("| Performance Marketing Associate |", "| CRM Executive |");
  const [out] = markTrackedInbox([parseInboxLine(line)], parseApplications(BRIDEBOOK_TRACKER, ROOT), read);
  assert.equal(out.done, false);
  assert.equal(out.tracked, undefined);
});

test("a report with no URL line, a missing report or a throwing read: no crash, the name match still works", () => {
  const tracker = BRIDEBOOK_TRACKER + "| 339 | 2026-10-05 | Acme | — | Analyst | 3.0/5 | Evaluated | ❌ | [339](../reports/339-acme-2026-10-05.md) | x |\n| 340 | 2026-10-05 | Beta | — | Analyst | 3.0/5 | Evaluated | ❌ | [340](../reports/340-beta-2026-10-05.md) | x |\n";
  const lines = [BRIDEBOOK_LINE, "- [ ] https://x.example/acme | Acme | Analyst | London", "- [ ] https://x.example/beta | Beta | Analyst | London"].map(parseInboxLine);
  const { read } = reports({ "../reports/338-bridebook-2026-10-05.md": "# Evaluation: Bridebook\n\n**Date:** 2026-10-05\n", "../reports/339-acme-2026-10-05.md": BRIDEBOOK_REPORT.replace(/^\*\*URL:.*$/m, "") });
  const throwing = (rel) => {
    if (rel.includes("340")) throw new Error("EACCES");
    return read(rel);
  };
  const out = markTrackedInbox(lines, parseApplications(tracker, ROOT), throwing);
  assert.deepEqual(out.map((j) => j.done), [false, true, true], "Bridebook has no URL to match; Acme and Beta match by name");
});

test("each report is read once per call, not once per row", () => {
  const { read, reads } = reports({ "../reports/338-bridebook-2026-10-05.md": BRIDEBOOK_REPORT });
  const lines = [BRIDEBOOK_LINE, BRIDEBOOK_LINE.replace("position=17", "position=18"), "- [ ] https://x.example/1 | Other | Role"].map(parseInboxLine);
  const out = markTrackedInbox(lines, parseApplications(BRIDEBOOK_TRACKER, ROOT), read);
  assert.deepEqual(out.map((j) => j.done), [true, true, false]);
  assert.deepEqual(reads, ["../reports/338-bridebook-2026-10-05.md"]);
});

test("with no report reader only the name match runs", () => {
  const [out] = markTrackedInbox([parseInboxLine(BRIDEBOOK_LINE)], parseApplications(BRIDEBOOK_TRACKER, ROOT));
  assert.equal(out.done, false);
});

test("postingId reads each board's own id and nothing else", () => {
  assert.equal(postingId("https://uk.linkedin.com/jobs/view/growth-lead-at-zinc-4475590501?position=25"), "linkedin:4475590501");
  assert.equal(postingId("https://www.linkedin.com/jobs/view/4475590501/"), "linkedin:4475590501");
  assert.equal(postingId("https://uk.indeed.com/viewjob?jk=74E4BAD5782F4FC4&from=serp"), "indeed:74e4bad5782f4fc4");
  assert.equal(postingId("https://jobs.ashbyhq.com/rogo/52ea8f7c-c4e7-49bb-a45f-468fe41c2728?src=x"), "ashby:52ea8f7c-c4e7-49bb-a45f-468fe41c2728");
  assert.equal(postingId("https://jobs.lever.co/zopa/5e422360-db37-45f8-af32-02e757d27020/apply"), "lever:5e422360-db37-45f8-af32-02e757d27020");
  assert.equal(postingId("https://job-boards.greenhouse.io/capitalontap/jobs/8604164002"), "greenhouse:8604164002");
  assert.equal(postingId("https://apply.workable.com/starling-bank/j/582C64B37F/"), "workable:582C64B37F");
  assert.equal(postingId("https://www.welcometothejungle.com/en/companies/lendable/jobs/senior-product-manager_arlington_dkw7hk5t"), "wttj:dkw7hk5t");
  for (const u of ["https://octopus.energy/careers/join-us/466ac356/", "local:jds/acme-pm-1a2b.md", "", undefined]) assert.equal(postingId(u), null, String(u));
});
