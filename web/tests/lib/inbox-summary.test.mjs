// Tests for the one Inbox composition the page, the Explore add and the root
// command `node inbox-summary.mjs` share. Each test builds a career-ops data
// folder in a temporary directory from real lines and reads it through
// inbox-summary.mjs, the module pipelineSummary calls.
//
// Run:  node --test tests/lib/inbox-summary.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readInboxSummary, countInbox, inboxFate, parseScanDates } from "../../src/lib/inbox-summary.mjs";

// The fork root, where the tracker parser finds tracker-aliases.json and where
// the root command lives.
const FORK = fileURLToPath(new URL("../../..", import.meta.url));

// The three lines and tracker rows of 14 September 2026, copied from the real
// files, and one MOTHER ROOT line for a role the tracker does not hold.
const THANKS_BEN = "https://uk.indeed.com/viewjob?jk=0da9285c18d2000d";
const AMEX = "https://uk.indeed.com/viewjob?jk=de724ce043428eb7";
const HEAD_OF_GROWTH = "https://jobs.example.com/mother-root-head-of-growth";
const PIPELINE = `# Pipeline

## Pending

- [ ] local:jds/mother-root-business-operations-manager-b2a687678d.md | MOTHER ROOT ✸ | Business Operations Manager | London, England, United Kingdom | triage: PASS 4.1 | jd: local:jds/mother-root-business-operations-manager-b2a687678d.md | route: standard
- [ ] ${THANKS_BEN} | Thanks Ben | Chief of Staff | London | jd: local:jds/thanks-ben-chief-of-staff-e42d6c3317.md | route: standard | fit: PASS | note: local:jds/thanks-ben-chief-of-staff-e42d6c3317.md
- [ ] ${AMEX} | American Express | Campus - Full Time - Product Manager - 2027 (UK - London) | London | jd: local:jds/american-express-campus-full-time-product-manager-2027-uk-london-db4a5cf471.md | route: standard | fit: PASS | note: local:jds/american-express-campus-full-time-product-manager-2027-uk-london-db4a5cf471.md
- [ ] ${HEAD_OF_GROWTH} | MOTHER ROOT ✸ | Head of Growth | London | route: standard | fit: PASS

## Processed

- [x] https://jobs.example.com/ticked | Acme | Operations Lead | London | skipped (duplicate)
`;

const TRACKER = `# Applications Tracker

| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|-------|--------|-----|--------|-------|
| 221 | 2026-09-14 | Thanks Ben | — | Chief of Staff | 3.8/5 | Applied | ❌ | [221](../reports/221-thanks-ben-2026-09-14.md) | Founder-to-CoS fit at Series B; posted: 2026-09-14 |
| 222 | 2026-09-14 | MOTHER ROOT ✸ | — | Business Operations Manager | 3.8/5 | Applied | ❌ | [222](../reports/222-mother-root-2026-09-14.md) | Strong AI-build fit; posted: 2026-09-12 |
| 225 | 2026-09-14 | American Express | — | Campus - Full Time - Product Manager - 2027 (UK - London) | 2.7/5 | SKIP | ❌ | [225](../reports/225-american-express-2026-09-14.md) | Skip: 2027 graduate cohort; posted: 2026-09-14 |
`;

const HISTORY = `url\tfirst_seen\tportal\ttitle\tcompany\tstatus
${THANKS_BEN}\t2026-09-14\tindeed\tChief of Staff\tThanks Ben\tadded
${AMEX}\t2026-09-14\tindeed\tCampus - Full Time - Product Manager - 2027 (UK - London)\tAmerican Express\tadded
${HEAD_OF_GROWTH}\t2026-09-15\tashby\tHead of Growth\tMOTHER ROOT ✸\tadded
`;

function dataFolder({ pipeline = PIPELINE, tracker = TRACKER, history = HISTORY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-summary-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.copyFileSync(path.join(FORK, "tracker-aliases.json"), path.join(root, "tracker-aliases.json"));
  fs.writeFileSync(path.join(root, "data/pipeline.md"), pipeline);
  if (tracker != null) fs.writeFileSync(path.join(root, "data/applications.md"), tracker);
  if (history != null) fs.writeFileSync(path.join(root, "data/scan-history.tsv"), history);
  return root;
}

test("the file counts 4 pending lines; the Inbox shows 1 and says why the other 3 are hidden", () => {
  const { jobs, inbox } = readInboxSummary(dataFolder());
  const { pendingLines, hidden, shown } = countInbox(jobs, inbox);
  assert.equal(pendingLines, 4);
  assert.deepEqual(shown.map((j) => `${j.company} | ${j.role}`), ["MOTHER ROOT ✸ | Head of Growth"]);
  assert.deepEqual(
    hidden.map((j) => [j.company, j.tracked]),
    [
      // newest scan first, and within 14 September the later line first
      ["American Express", { n: "225", status: "SKIP", date: "2026-09-14" }],
      ["Thanks Ben", { n: "221", status: "Applied", date: "2026-09-14" }],
      ["MOTHER ROOT ✸", { n: "222", status: "Applied", date: "2026-09-14" }],
    ],
  );
});

test("a tracked row is hidden whatever its tracker status, SKIP included", () => {
  const { inbox } = readInboxSummary(dataFolder());
  const amex = inbox.find((j) => j.url === AMEX);
  assert.equal(amex.done, true);
  assert.equal(amex.tracked.status, "SKIP");
});

test("the composition carries the scan date and the newest-scan order", () => {
  const { inbox } = readInboxSummary(dataFolder());
  assert.equal(inbox[0].url, HEAD_OF_GROWTH, "the 15 September row opens the list");
  assert.equal(inbox[0].scannedAt, "2026-09-15");
  assert.equal(inbox[0].postedAt, "2026-09-15", "no posted: label, so the scan date stands in");
  assert.equal(inbox.find((j) => j.url === THANKS_BEN).scannedAt, "2026-09-14");
  assert.equal(inbox.at(-1).company, "MOTHER ROOT ✸", "the local:jds line has no scan date and goes last");
});

test("a ticked line is done but carries no tracker row, and is not counted as hidden", () => {
  const { jobs, inbox } = readInboxSummary(dataFolder());
  const ticked = inbox.find((j) => j.company === "Acme");
  assert.equal(ticked.done, true);
  assert.equal(ticked.tracked, undefined);
  assert.equal(countInbox(jobs, inbox).hidden.length, 3);
});

test("the Explore add's answer: shown, or hidden with the tracker row that holds the seat", () => {
  // Explore wrote a new URL for a seat the tracker already holds, as its add does
  const added = "https://www.linkedin.com/jobs/view/thanks-ben-chief-of-staff-1234567890";
  const pipeline = PIPELINE.replace("\n## Processed", `- [ ] ${added} | Thanks Ben | Chief of Staff | London\n\n## Processed`);
  const { inbox } = readInboxSummary(dataFolder({ pipeline }));
  assert.deepEqual(inboxFate(inbox, added), {
    url: added,
    shown: false,
    tracked: { n: "221", status: "Applied", date: "2026-09-14" },
    reason: "already in the tracker as row 221 (Applied)",
  });
  assert.deepEqual(inboxFate(inbox, HEAD_OF_GROWTH), { url: HEAD_OF_GROWTH, shown: true });
  assert.equal(inboxFate(inbox, "https://jobs.example.com/ticked").reason, "its pipeline.md line is ticked");
  assert.equal(inboxFate(inbox, "https://nowhere.example/1").reason, "not in pipeline.md");
});

test("no tracker and no scan history: every pending line shows, nothing is hidden", () => {
  const { jobs, inbox } = readInboxSummary(dataFolder({ tracker: null, history: null }));
  const { pendingLines, hidden, shown } = countInbox(jobs, inbox);
  assert.equal(pendingLines, 4);
  assert.equal(hidden.length, 0);
  assert.equal(shown.length, 4);
});

test("scan history: earliest first_seen per URL, header and bad rows skipped", () => {
  const dates = parseScanDates(`url\tfirst_seen\n${AMEX}\t2026-09-14\n${AMEX}\t2026-09-20\nbroken-row\n${THANKS_BEN}\tnot-a-date\n`);
  assert.deepEqual([...dates], [[AMEX, "2026-09-14"]]);
});

test("node inbox-summary.mjs prints the three counts and each hidden row's tracker row", () => {
  const root = dataFolder({ pipeline: PIPELINE.replace("\n## Processed", `- [ ] ${HEAD_OF_GROWTH} | MOTHER ROOT ✸ | Head of Growth | London\n\n## Processed`) });
  const out = execFileSync(process.execPath, [path.join(FORK, "inbox-summary.mjs")], {
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: "utf8",
  });
  assert.match(out, /^Pending lines in data\/pipeline\.md: 5$/m);
  assert.match(out, /^Hidden, already in the tracker: 3$/m);
  assert.match(out, /^ {2}- Thanks Ben \| Chief of Staff — tracker row 221, Applied, 2026-09-14$/m);
  assert.match(out, /^ {2}- American Express \| .* — tracker row 225, SKIP, 2026-09-14$/m);
  assert.match(out, /^Repeat lines of a URL already listed: 1$/m);
  assert.match(out, /^Shown in the Inbox: 1$/m);
});
