// Tests for the inbox line reader using Node's built-in test runner. Imports
// inbox-line.mjs directly, the one definition readInbox uses, so the test and
// the dashboard cannot drift.
//
// Run:  node --test tests/lib/inbox-line.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboxLine, fitCardLine } from "../../src/lib/inbox-line.mjs";
// The core's one definition of the `fit:` value (ticket D2b). It imports only
// `fs`, so web's own CI, which installs web's packages alone, can load it.
import { formatFitValue } from "../../../providers/_fit-prompt.mjs";

test("parity: the card reads every fit: value the core writes", () => {
  const reason = "a Manager grade at that band is a stretch (4 September), and the rules pull both ways";
  for (const [verdict, card] of [
    ["PASS", "PASS"],
    ["SKIP", `review: ${reason}`],
    ["REVIEW", `review: ${reason}`],
  ]) {
    const value = formatFitValue({ verdict, reason });
    const line = `- [ ] https://jobs.example.com/p | Acme | Analyst | London | route: review | fit: ${value} | note: x`;
    const job = parseInboxLine(line);
    assert.equal(job.fit, value, `${verdict}: the segment reads back whole`);
    assert.equal(fitCardLine(job), card, `${verdict}: the card line`);
  }
});

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

test("the jd: segment reaches the job as the saved advert (ticket 2e)", () => {
  // The real Fred Perry row, 22 September 2026: an Indeed URL whose advert the
  // scan had already saved. The reader dropped `jd:` on the floor, so the
  // evaluate prompt could not name the file and the run died on Indeed's wall.
  const line =
    "- [ ] https://uk.indeed.com/viewjob?jk=1505caa519d66118 | Fred Perry | Product Manager - Menswear | London WC1X 0AA | jd: local:jds/fred-perry-product-manager-menswear-eea864f490.md | route: review | fit: REVIEW (the seat is a stretch) | note: local:jds/fred-perry-product-manager-menswear-eea864f490.md";
  const job = parseInboxLine(line);

  assert.equal(job.jd, "local:jds/fred-perry-product-manager-menswear-eea864f490.md");
  // ...and the positional cells are untouched by the extra label
  assert.equal(job.company, "Fred Perry");
  assert.equal(job.role, "Product Manager - Menswear");
  assert.equal(job.location, "London WC1X 0AA");
});

test("a row with no jd: segment has no saved advert", () => {
  const job = parseInboxLine("- [ ] https://jobs.example.com/1 | Acme | Analyst | London");
  assert.equal(job.jd, undefined);
});
