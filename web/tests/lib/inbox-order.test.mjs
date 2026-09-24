// Tests for the rule that the inbox opens on the latest scan's rows, and that
// the inbox count leaves out the rows hidden with X.
// Imports inbox-order.mjs directly, the one definition pipelineSummary and the
// inbox view use.
//
// Run:  node --test tests/lib/inbox-order.test.mjs
// With CAREER_OPS_ROOT set to a folder holding data/pipeline.md, the last test
// also reads the real files (read only); without it that test is skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseInboxLine } from "../../src/lib/inbox-line.mjs";
import { markTrackedInbox } from "../../src/lib/inbox-tracked.mjs";
import { orderInboxByScan, compareScannedAt, countNotHidden, parseHiddenList, restoreCount } from "../../src/lib/inbox-order.mjs";
import { readInboxSummary, readScanDates, countInbox } from "../../src/lib/inbox-summary.mjs";

// Lines from data/pipeline.md on 15 September 2026, in file order; the long fit
// reasons are cut short. Darktrace came from the 14 September run, Wolters Kluwer
// and Light from the 09:00 run, the last six from the 17:00 run. The Kira line's
// URL cell is a local:jds path the scan history never held.
const PIPELINE = [
  "- [ ] local:jds/kira-strategy-operations-associate-9117d1704e.md | Kira | Strategy & Operations Associate | London Area, United Kingdom | triage: PASS 4.2 | route: standard",
  "- [ ] https://uk.linkedin.com/jobs/view/product-manager-ndr-at-darktrace-4431116191?position=7&pageNum=0&refId=ZwBDiPZCHZRcQjbqbHI7HQ%3D%3D&trackingId=%2Fjiz9vOpG0xszeOp716X7g%3D%3D | Darktrace | Product Manager - NDR | London, England, United Kingdom | jd: local:jds/darktrace-product-manager-ndr-89ed1d2ceb.md | route: review | fit: SKIP (specialist cybersecurity work)",
  "- [ ] https://www.welcometothejungle.com/en/companies/wolters-kluwer-1/jobs/customer-service-operations-associate-filing-manager_houston_wjxb6chm | Wolters Kluwer | Customer Service Operations Associate (Filing Manager) | York, United Kingdom, Remote | 35000-58600 USD | posted: 2026-09-13 | route: review | fit: SKIP (licence filing)",
  "- [ ] https://uk.linkedin.com/jobs/view/product-manager-at-light-4430209776?position=6&pageNum=0&refId=jpQJq7twS8l2X61cql8UTA%3D%3D&trackingId=5rToKRv6OPL%2BCnHjHuHDsg%3D%3D | Light | Product Manager | London, England, United Kingdom | jd: local:jds/light-product-manager-bd297b6ce5.md | route: standard | fit: PASS | note: local:jds/light-product-manager-bd297b6ce5.md",
  "- [ ] https://jobs.ashbyhq.com/heidihealth.com.au/fb77fa71-8fe1-452f-928a-221d515dea3f | Heidi | Partnerships Associate | London | posted: 2026-09-02 | route: review | fit: REVIEW (fit call failed: timed out after 180 s)",
  "- [ ] https://uk.indeed.com/viewjob?jk=a0a4ebf4fdcff566 | Scope AI | Chief of Staff | London | jd: local:jds/scope-ai-chief-of-staff-41d28dfcbd.md | route: standard | fit: PASS | note: local:jds/scope-ai-chief-of-staff-41d28dfcbd.md",
  "- [ ] https://jobs.ashbyhq.com/getscope/95f57c60-feb7-49e7-8390-0989b4418f21 | Scope | Chief of Staff | London, UK | posted: 2026-09-15 | jd: local:jds/scope-chief-of-staff-e2add9d8bd.md | route: review | fit: REVIEW (advert not read, nothing to judge)",
  "- [ ] https://uk.indeed.com/viewjob?jk=2e10e68d3f7ff114 | GetGround | Founders Associate | London | jd: local:jds/getground-founders-associate-467f98cf3d.md | route: standard | fit: PASS | note: local:jds/getground-founders-associate-467f98cf3d.md",
  "- [ ] https://jobs.deel.com/klarna/job-details/7d04c8ad-fa8f-4248-b55a-bd5ff5d6aa4a/overview | Klarna | Business Development Associate — Media Sales & Partnerships | London, UK | posted: 2026-08-29 | jd: local:jds/klarna-business-development-associate-media-sales-partnerships-51c715d521.md | route: standard | fit: PASS",
  "- [ ] https://uk.indeed.com/viewjob?jk=f31f31a98150b38f | Investec | Technical Product Owner (Corporate Transactional Banking) | London EC2V | jd: local:jds/investec-technical-product-owner-corporate-transactional-banking-caa5842101.md | route: review | fit: REVIEW (backlog and requirements ownership)",
];

// url → first_seen from data/scan-history.tsv, as readScanDates returns it.
const SCAN_DATES = new Map([
  ["https://uk.linkedin.com/jobs/view/product-manager-ndr-at-darktrace-4431116191?position=7&pageNum=0&refId=ZwBDiPZCHZRcQjbqbHI7HQ%3D%3D&trackingId=%2Fjiz9vOpG0xszeOp716X7g%3D%3D", "2026-09-14"],
  ["https://www.welcometothejungle.com/en/companies/wolters-kluwer-1/jobs/customer-service-operations-associate-filing-manager_houston_wjxb6chm", "2026-09-15"],
  ["https://uk.linkedin.com/jobs/view/product-manager-at-light-4430209776?position=6&pageNum=0&refId=jpQJq7twS8l2X61cql8UTA%3D%3D&trackingId=5rToKRv6OPL%2BCnHjHuHDsg%3D%3D", "2026-09-15"],
  ["https://jobs.ashbyhq.com/heidihealth.com.au/fb77fa71-8fe1-452f-928a-221d515dea3f", "2026-09-15"],
  ["https://uk.indeed.com/viewjob?jk=a0a4ebf4fdcff566", "2026-09-15"],
  ["https://jobs.ashbyhq.com/getscope/95f57c60-feb7-49e7-8390-0989b4418f21", "2026-09-15"],
  ["https://uk.indeed.com/viewjob?jk=2e10e68d3f7ff114", "2026-09-15"],
  ["https://jobs.deel.com/klarna/job-details/7d04c8ad-fa8f-4248-b55a-bd5ff5d6aa4a/overview", "2026-09-15"],
  ["https://uk.indeed.com/viewjob?jk=f31f31a98150b38f", "2026-09-15"],
]);

const EVENING = ["Investec", "Klarna", "GetGround", "Scope", "Scope AI", "Heidi"];

// What pipelineSummary does to each line before ordering.
function inbox(lines = PIPELINE, dates = SCAN_DATES) {
  return lines.map((l) => parseInboxLine(l)).map((j) => ({ ...j, postedAt: j.postedAt ?? dates.get(j.url) }));
}

test("15 September: the six 17:00 rows open the inbox, then 09:00, then 14 September, then no scan date", () => {
  const out = orderInboxByScan(inbox(), SCAN_DATES);
  assert.deepEqual(
    out.map((j) => j.company),
    [...EVENING, "Light", "Wolters Kluwer", "Darktrace", "Kira"],
  );
});

test("Klarna, posted 29 August, sits with its run, not below the 09:00 rows", () => {
  const out = orderInboxByScan(inbox(), SCAN_DATES);
  const klarna = out.findIndex((j) => j.company === "Klarna");
  const light = out.findIndex((j) => j.company === "Light");
  assert.ok(klarna < light, `Klarna at ${klarna}, Light at ${light}`);
});

test("postedAt is left as it was; scannedAt carries the scan date", () => {
  const out = orderInboxByScan(inbox(), SCAN_DATES);
  const by = Object.fromEntries(out.map((j) => [j.company, j]));
  assert.equal(by.Klarna.postedAt, "2026-08-29");
  assert.equal(by.Klarna.scannedAt, "2026-09-15");
  assert.equal(by.Heidi.postedAt, "2026-09-02");
  assert.equal(by["Scope AI"].postedAt, "2026-09-15"); // no posted: label, the history date as before
  assert.equal(by.Darktrace.scannedAt, "2026-09-14");
  assert.equal(by.Kira.scannedAt, undefined);
  assert.equal(by.Kira.postedAt, undefined);
});

test("the view's comparator keeps the server order within one day", () => {
  const ordered = orderInboxByScan(inbox(), SCAN_DATES);
  const resorted = [...ordered].sort(compareScannedAt);
  assert.deepEqual(resorted.map((j) => j.url), ordered.map((j) => j.url));
});

test("rows with no scan date go last, later line first", () => {
  const lines = [
    "- [ ] https://a.example/1 | A | Role | London",
    "- [ ] https://b.example/2 | B | Role | London",
    "- [ ] https://c.example/3 | C | Role | London",
  ];
  const dates = new Map([["https://a.example/1", "2026-09-01"]]);
  assert.deepEqual(orderInboxByScan(inbox(lines, dates), dates).map((j) => j.company), ["A", "C", "B"]);
});

test("the ordering drops no row and changes no done flag", () => {
  const rows = inbox();
  rows[3] = { ...rows[3], done: true };
  const out = orderInboxByScan(rows, SCAN_DATES);
  assert.equal(out.length, rows.length);
  assert.equal(out.filter((j) => j.done).length, 1);
  assert.equal(out.find((j) => j.done).company, "Light");
});

test("X: the count leaves out a hidden row, and ignores an X on a row no longer pending", () => {
  const pending = orderInboxByScan(inbox(), SCAN_DATES);
  assert.equal(countNotHidden(pending, []), 10);
  const klarna = pending.find((j) => j.company === "Klarna").url;
  assert.equal(countNotHidden(pending, [klarna]), 9);
  assert.equal(countNotHidden(pending, [klarna, "https://gone.example/ticked-since"]), 9);
});

test("one URL listed twice: the earlier labelled line is the row kept, not a later bare re-add", () => {
  const bare = "- [ ] https://jobs.deel.com/klarna/job-details/7d04c8ad-fa8f-4248-b55a-bd5ff5d6aa4a/overview | Klarna | Business Development Associate — Media Sales & Partnerships";
  const out = orderInboxByScan(inbox([...PIPELINE, bare]), SCAN_DATES);
  const rows = out.filter((j) => j.company === "Klarna");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fit, "PASS");
  assert.equal(rows[0].postedAt, "2026-08-29");
  assert.equal(rows[0].location, "London, UK");
  assert.equal(out.length, PIPELINE.length);
  // its place is still the labelled line's place in the 17:00 run
  assert.deepEqual(out.slice(0, 6).map((j) => j.company), EVENING);
});

test("one URL listed twice: an earlier ticked line gives way to a later unticked one", () => {
  const lines = [
    "- [x] https://a.example/1 | A | Role | London | fit: SKIP",
    "- [ ] https://a.example/1 | A | Role | London | fit: PASS",
  ];
  const out = orderInboxByScan(inbox(lines, new Map()), new Map());
  assert.equal(out.length, 1);
  assert.equal(out[0].done, false);
  assert.equal(out[0].fit, "PASS");
});

test("X: restore stays available when every X-ed row has since been ticked", () => {
  const pending = orderInboxByScan(inbox(), SCAN_DATES);
  const gone = ["https://gone.example/ticked-1", "https://gone.example/ticked-2"];
  assert.equal(countNotHidden(pending, gone), pending.length); // nothing in the inbox is hidden
  assert.equal(restoreCount(pending, gone), 2); // yet the control shows, with the stored entries
  const klarna = pending.find((j) => j.company === "Klarna").url;
  assert.equal(restoreCount(pending, [klarna, ...gone]), 1); // a hidden row still here is the number
  assert.equal(restoreCount(pending, []), 0);
});

test("X: a stored hidden list that is not an array of strings reads as empty", () => {
  assert.deepEqual(parseHiddenList('["https://a.example/1","https://b.example/2"]'), ["https://a.example/1", "https://b.example/2"]);
  assert.deepEqual(parseHiddenList('{"url":"https://a.example/1"}'), []);
  assert.deepEqual(parseHiddenList('"https://a.example/1"'), []);
  assert.deepEqual(parseHiddenList("null"), []);
  assert.deepEqual(parseHiddenList("not json"), []);
  assert.deepEqual(parseHiddenList('["https://a.example/1", 7, null, {"u":1}]'), ["https://a.example/1"]);
  assert.equal(countNotHidden([{ url: "https://a.example/1" }], parseHiddenList('{"x":1}')), 1);
});

// The evaluation over the live files, through inbox-summary.mjs: the one
// composition the page, the Explore add and `node inbox-summary.mjs` use, so
// this checks what the page shows, not a copy. Read only; skipped when the data
// is absent.
const LIVE = process.env.CAREER_OPS_ROOT?.trim();
const liveReady = !!LIVE && fs.existsSync(path.join(LIVE, "data/pipeline.md")) && fs.existsSync(path.join(LIVE, "data/scan-history.tsv"));

test("live data: newest scan first, later line first within a day, pending count unchanged, X lowers the count by one", { skip: !liveReady && "CAREER_OPS_ROOT not set" }, () => {
  const { jobs, applications, inbox: composed } = readInboxSummary(LIVE);
  const dates = readScanDates(LIVE);
  const after = countInbox(jobs, composed).shown;
  // the same rows unordered, deduped as PipelineView did before the order: first pending line per URL
  const seen = new Set();
  const before = markTrackedInbox(jobs, applications).filter((j) => !j.done && !seen.has(j.url) && seen.add(j.url));
  // each shown row's pipeline.md line: the first unticked line for its URL
  const lineOf = new Map();
  jobs.forEach((j, i) => { if (!j.done && !lineOf.has(j.url)) lineOf.set(j.url, i); });

  console.log(`live: pending before ${before.length}, after ${after.length}`);
  for (const [i, j] of after.slice(0, 8).entries()) console.log(`live: ${i + 1}. ${j.scannedAt ?? "-"} line ${lineOf.get(j.url) + 1} ${j.company} (posted ${j.postedAt ?? "-"})`);

  assert.equal(after.length, before.length);
  assert.equal(dates.size > 0, true, "scan-history.tsv read");
  let sameDay = 0;
  for (let i = 1; i < after.length; i++) {
    assert.ok(compareScannedAt(after[i - 1], after[i]) <= 0, `row ${i + 1} is newer than row ${i}`);
    // within one date the later pipeline.md line sits above the earlier one:
    // first_seen has no time, so this is what puts a 17:00 row above a 09:00 row
    if ((after[i - 1].scannedAt ?? "") === (after[i].scannedAt ?? "")) {
      sameDay++;
      assert.ok(lineOf.get(after[i - 1].url) > lineOf.get(after[i].url), `rows ${i} and ${i + 1} share ${after[i].scannedAt ?? "no date"} but the earlier line is on top`);
    }
  }
  console.log(`live: ${sameDay} same-day neighbours, each with the later line on top`);
  const evening = after.slice(0, EVENING.length).map((j) => j.company);
  // the 15 September check holds only until a later run or a tick changes the head
  const stillPending = EVENING.filter((c) => after.some((j) => j.company === c && j.scannedAt === "2026-09-15"));
  if (after[0]?.scannedAt === "2026-09-15" && stillPending.length === EVENING.length) assert.deepEqual(evening, EVENING);
  assert.equal(countNotHidden(after, [after[0].url]), after.length - 1);
});
