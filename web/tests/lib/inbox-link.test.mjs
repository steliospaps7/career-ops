// Tests for the inbox row's link rule using Node's built-in test runner.
// Imports inbox-link.mjs directly, the one definition TriageRow uses, so the
// test and the dashboard cannot drift.
//
// Run:  node --test tests/lib/inbox-link.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxLinkHref } from "../../src/lib/inbox-link.mjs";

test("an https:// URL becomes the link", () => {
  const url = "https://jobs.ashbyhq.com/acme/1a2b3c4d-5e6f-7a8b-9c0d-ef1234567890";
  assert.equal(inboxLinkHref(url), url);
});

test("an http:// URL becomes the link", () => {
  const url = "http://careers.example.com/jobs/42";
  assert.equal(inboxLinkHref(url), url);
});

test("a LinkedIn URL with a query string comes back unchanged", () => {
  const url = "https://www.linkedin.com/jobs/view/4301234567/?refId=abc%3D%3D&trackingId=xYz%2B1&trk=public_jobs_topcard-title";
  assert.equal(inboxLinkHref(url), url);
});

test("javascript:alert(1) is not a link", () => {
  assert.equal(inboxLinkHref("javascript:alert(1)"), null);
});

test("a local: reference is not a link", () => {
  assert.equal(inboxLinkHref("local:jds/x.md"), null);
});

test("an empty string is not a link", () => {
  assert.equal(inboxLinkHref(""), null);
  assert.equal(inboxLinkHref(undefined), null);
});
