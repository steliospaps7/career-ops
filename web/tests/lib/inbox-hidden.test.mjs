// Tests for the rows hidden with X, kept in data/inbox-hidden.tsv (ticket 7b):
// the route's read, write and merge, the one-time move of the browser's old
// list, the counts in the shared Inbox module and in `node inbox-summary.mjs`,
// and the "no scan date" mark. Each file test builds a data folder in a
// temporary directory; nothing touches the real data/.
//
// Run:  node --experimental-strip-types --test tests/lib/inbox-hidden.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  HIDDEN_FILE,
  parseHiddenTsv,
  serializeHiddenTsv,
  applyHiddenChange,
  cleanUrlList,
  migrateBrowserHidden,
  answerGate,
} from "../../src/lib/inbox-hidden.mjs";
import { readHiddenFile, updateHiddenFile } from "../../src/lib/inbox-hidden-file.mjs";
import { readInboxSummary, countInbox, inboxFate } from "../../src/lib/inbox-summary.mjs";
import { parseHiddenList, scanDateMark } from "../../src/lib/inbox-order.mjs";
import { atomicWrite } from "../../src/lib/core/safe-write.ts";

const FORK = fileURLToPath(new URL("../../..", import.meta.url));

const A = "https://jobs.ashbyhq.com/example/a";
const B = "https://jobs.ashbyhq.com/example/b";
const C = "https://jobs.ashbyhq.com/example/c";
const T1 = "2026-09-24T19:00:00Z";
const T2 = "2026-09-24T19:05:11Z";

const PIPELINE = `# Pipeline

## Pending

- [ ] ${A} | Acme | Operations Lead | London | fit: PASS
- [ ] ${B} | Beta | Chief of Staff | London | fit: PASS
- [ ] ${C} | Gamma | Strategy Associate | London | fit: PASS
- [ ] local:jds/hand-added.md | Delta | Growth Lead | London

## Processed

- [x] https://jobs.example.com/ticked | Epsilon | Analyst | London | skipped (duplicate)
`;

const HISTORY = `url\tfirst_seen\tportal\ttitle\tcompany\tstatus
${A}\t2026-09-24\tashby\tOperations Lead\tAcme\tadded
${B}\t2026-09-23\tashby\tChief of Staff\tBeta\tadded
${C}\t2026-09-22\tashby\tStrategy Associate\tGamma\tadded
`;

function dataFolder({ hidden } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-hidden-"));
  fs.mkdirSync(path.join(root, "data"));
  fs.copyFileSync(path.join(FORK, "tracker-aliases.json"), path.join(root, "tracker-aliases.json"));
  fs.writeFileSync(path.join(root, "data/pipeline.md"), PIPELINE);
  fs.writeFileSync(path.join(root, "data/scan-history.tsv"), HISTORY);
  if (hidden != null) fs.writeFileSync(path.join(root, HIDDEN_FILE), hidden);
  return root;
}

// ── the file: read, write, merge ─────────────────────────────────────────────

test("a missing file and an empty file both read as no hidden rows", () => {
  assert.deepEqual(readHiddenFile(dataFolder()), []);
  assert.deepEqual(readHiddenFile(dataFolder({ hidden: "" })), []);
  assert.deepEqual(parseHiddenTsv("url\thidden_at\n"), []);
});

test("bad lines: no URL dropped, a bad time keeps the URL, a repeat keeps the first", () => {
  const text = `url\thidden_at\n${A}\t${T1}\n\n\t${T1}\n${B}\tyesterday\n${A}\t${T2}\n${C}\n`;
  assert.deepEqual(parseHiddenTsv(text), [
    { url: A, hidden_at: T1 },
    { url: B, hidden_at: "" },
    { url: C, hidden_at: "" },
  ]);
});

test("the file round-trips through serialize and parse, header first", () => {
  const entries = [{ url: A, hidden_at: T1 }, { url: B, hidden_at: T2 }];
  const text = serializeHiddenTsv(entries);
  assert.equal(text, `url\thidden_at\n${A}\t${T1}\n${B}\t${T2}\n`);
  assert.deepEqual(parseHiddenTsv(text), entries);
});

test("an X on a missing file writes it with one stamped line", () => {
  const root = dataFolder();
  const r = updateHiddenFile(root, { add: [A] }, { write: atomicWrite, now: T1 });
  assert.equal(r.added, 1);
  assert.equal(fs.readFileSync(path.join(root, HIDDEN_FILE), "utf8"), `url\thidden_at\n${A}\t${T1}\n`);
});

test("merge adds no duplicate and keeps the first time; restore removes the line", () => {
  const root = dataFolder({ hidden: `url\thidden_at\n${A}\t${T1}\n` });
  const merged = updateHiddenFile(root, { add: [A, B, B] }, { write: atomicWrite, now: T2 });
  assert.equal(merged.added, 1);
  assert.deepEqual(readHiddenFile(root), [{ url: A, hidden_at: T1 }, { url: B, hidden_at: T2 }]);

  const again = updateHiddenFile(root, { add: [A, B] }, { write: () => assert.fail("nothing to write") });
  assert.equal(again.added, 0);

  const restored = updateHiddenFile(root, { remove: [A] }, { write: atomicWrite });
  assert.equal(restored.removed, 1);
  assert.deepEqual(readHiddenFile(root), [{ url: B, hidden_at: T2 }]);
  assert.equal(fs.readdirSync(path.join(root, "data")).filter((f) => f.includes(".tmp-")).length, 0, "no temp file left");
});

test("a request's URL list: non-arrays, non-strings, tabs and line breaks dropped", () => {
  assert.deepEqual(cleanUrlList("not a list"), []);
  assert.deepEqual(cleanUrlList([A, 7, null, "  ", `${B}\tx`, `${C}\nx`, ` ${A} `]), [A]);
  assert.deepEqual(applyHiddenChange([], { add: [A], remove: [A] }, T1), { entries: [], added: 0, removed: 0 });
});

test("a file that exists but cannot be read throws; the X writes nothing, the page still reads", () => {
  // A directory where the file should be: readFileSync fails with EISDIR, not ENOENT.
  const root = dataFolder();
  fs.mkdirSync(path.join(root, HIDDEN_FILE));
  assert.throws(() => readHiddenFile(root), { code: "EISDIR" });
  let wrote = false;
  assert.throws(() => updateHiddenFile(root, { add: [A] }, { write: () => (wrote = true) }), { code: "EISDIR" });
  assert.equal(wrote, false, "a failed read must never lead to a write holding only the new URL");
  const { jobs, inbox } = readInboxSummary(root);
  assert.equal(countInbox(jobs, inbox).shown.length, 4, "the page shows every row rather than failing");
});

test("an answer is applied only if no later request has been answered", () => {
  const gate = answerGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.accept(second), true, "the later X answers first and stands");
  assert.equal(gate.accept(first), false, "the older answer, arriving last, is dropped");
  const third = gate.next();
  assert.equal(gate.accept(third), true);
  assert.equal(gate.accept(third), false, "one answer per request");
});

// ── the browser's old list, moved once ──────────────────────────────────────

function fakeStorage(value) {
  const store = new Map(value == null ? [] : [["career-ops:hidden", value]]);
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    removeItem: (k) => store.delete(k),
    has: (k) => store.has(k),
  };
}

test("the browser key is cleared only after the route answers with the merged count", async () => {
  const storage = fakeStorage(JSON.stringify([A, B]));
  const logs = [];
  let sent;
  const r = await migrateBrowserHidden({
    storage,
    key: "career-ops:hidden",
    parse: parseHiddenList,
    post: async (urls) => ((sent = urls), { urls, count: 2, added: 2 }),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(sent, [A, B]);
  assert.equal(r.status, "merged");
  assert.equal(storage.has("career-ops:hidden"), false);
  assert.match(logs[0], /moved 2 browser-hidden row\(s\) into data\/inbox-hidden\.tsv; 2 new, the file now holds 2/);
});

test("a failed or odd answer leaves the browser key in place", async () => {
  for (const post of [
    async () => { throw new Error("offline"); },
    async () => null,
    async () => ({ error: "boom" }),
    async () => ({ urls: [], count: "2" }),
  ]) {
    const storage = fakeStorage(JSON.stringify([A]));
    const r = await migrateBrowserHidden({ storage, key: "career-ops:hidden", parse: parseHiddenList, post });
    assert.equal(r.status, "kept");
    assert.equal(storage.has("career-ops:hidden"), true);
  }
});

test("no stored key: nothing is sent; a bad stored value sends an empty list and is cleared", async () => {
  let calls = 0;
  const none = await migrateBrowserHidden({
    storage: fakeStorage(null), key: "career-ops:hidden", parse: parseHiddenList, post: async () => (calls++, { count: 0 }),
  });
  assert.equal(none.status, "none");
  assert.equal(calls, 0);

  const storage = fakeStorage("{not json");
  let sent;
  const bad = await migrateBrowserHidden({
    storage, key: "career-ops:hidden", parse: parseHiddenList, post: async (urls) => ((sent = urls), { count: 0, added: 0 }),
  });
  assert.deepEqual(sent, []);
  assert.equal(bad.status, "merged");
  assert.equal(storage.has("career-ops:hidden"), false);
});

// ── the counts: module and root command ─────────────────────────────────────

test("the shared module leaves X-hidden rows out of the shown count and says why", () => {
  const root = dataFolder({ hidden: `url\thidden_at\n${B}\t${T2}\nhttps://gone.example/1\t${T1}\n` });
  const { jobs, inbox, hiddenEntries } = readInboxSummary(root);
  const { pendingLines, hidden, hiddenWithX, shown } = countInbox(jobs, inbox);
  assert.equal(pendingLines, 4);
  assert.equal(hidden.length, 0);
  assert.deepEqual(hiddenWithX.map((j) => [j.url, j.hiddenWithX.at]), [[B, T2]]);
  assert.equal(shown.length, 3);
  assert.ok(!shown.some((j) => j.url === B));
  assert.equal(hiddenEntries.length, 2, "the whole list, a URL no longer pending included");
  assert.deepEqual(inboxFate(inbox, B), { url: B, shown: false, reason: "hidden with X on 2026-09-24" });
});

test("one X drops the shown count by one; restore brings it back", () => {
  const root = dataFolder();
  const shownNow = () => {
    const { jobs, inbox } = readInboxSummary(root);
    return countInbox(jobs, inbox).shown.length;
  };
  assert.equal(shownNow(), 4);
  updateHiddenFile(root, { add: [A] }, { write: atomicWrite });
  assert.equal(shownNow(), 3);
  updateHiddenFile(root, { remove: [A] }, { write: atomicWrite });
  assert.equal(shownNow(), 4);
});

test("node inbox-summary.mjs prints the hidden-with-X count and leaves those rows out", () => {
  const root = dataFolder({ hidden: `url\thidden_at\n${A}\t${T1}\n` });
  const out = execFileSync(process.execPath, [path.join(FORK, "inbox-summary.mjs")], {
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: "utf8",
  });
  assert.match(out, /^Pending lines in data\/pipeline\.md: 4$/m);
  assert.match(out, /^Hidden, already in the tracker: 0$/m);
  assert.match(out, /^Hidden with X: 1$/m);
  assert.match(out, /^ {2}- Acme \| Operations Lead — 2026-09-24T19:00:00Z$/m);
  assert.match(out, /^Shown in the Inbox: 3$/m);
  assert.doesNotMatch(out, /Repeat lines/);
});

// ── the mark on a row with no scan date ─────────────────────────────────────

test("a row with no scan date carries the mark, and sorts last; a dated row does not", () => {
  const { inbox } = readInboxSummary(dataFolder());
  const last = inbox.at(-1);
  assert.equal(last.company, "Delta");
  assert.equal(last.scannedAt, undefined);
  assert.equal(scanDateMark(last), "no scan date");
  assert.equal(scanDateMark(inbox.find((j) => j.url === A)), null);
});
