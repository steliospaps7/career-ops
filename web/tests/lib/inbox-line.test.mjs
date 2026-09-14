// Tests for the inbox line reader using Node's built-in test runner. Imports
// inbox-line.mjs directly, the one definition readInbox uses, so the test and
// the dashboard cannot drift.
//
// Run:  node --test tests/lib/inbox-line.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboxLine, fitCardLine } from "../../src/lib/inbox-line.mjs";

test("a line carrying fit: SKIP (reason) reaches the card with that reason", () => {
  const line = "- [ ] https://jobs.example.com/1 | Acme | Care Operations Manager | London | jd: local:jds/acme-care.md | route: review | fit: SKIP (the seat runs outsourced contact centres) | note: via board";
  const job = parseInboxLine(line);
  assert.equal(job.fit, "SKIP (the seat runs outsourced contact centres)");
  assert.equal(job.route, "review");
  assert.equal(fitCardLine(job), "review: the seat runs outsourced contact centres");
  // the labels never bleed into the positional cells
  assert.equal(job.role, "Care Operations Manager");
  assert.equal(job.location, "London");
});

test("a REVIEW shows its reason and a PASS shows PASS", () => {
  const review = parseInboxLine("- [ ] https://jobs.example.com/2 | Acme | Analyst | route: review | fit: REVIEW (fit call failed: timed out after 180 s)");
  assert.equal(fitCardLine(review), "review: fit call failed: timed out after 180 s");
  const pass = parseInboxLine("- [ ] https://jobs.example.com/3 | Acme | Product Manager | route: standard | fit: PASS");
  assert.equal(fitCardLine(pass), "PASS");
});

test("a row the gate never judged shows nothing, and parses as before", () => {
  const job = parseInboxLine("- [ ] https://jobs.example.com/4 | Acme | Analyst | London | 50000-60000 GBP | posted: 2026-09-01 | route: standard");
  assert.equal(fitCardLine(job), null);
  assert.equal(job.fit, undefined);
  assert.equal(job.compensation, "50000-60000 GBP");
  assert.equal(job.postedAt, "2026-09-01");
  assert.equal(parseInboxLine("## Pending"), null);
});
