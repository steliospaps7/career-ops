/**
 * inbox-summary.mjs — the Inbox, composed once from the files, for every reader.
 *
 * The Inbox page, the Explore add and the root command `node inbox-summary.mjs`
 * must agree on what is pending. They used to disagree: the tracker join ran
 * only inside pipelineSummary, the scan's recheck that ticks tracked lines is
 * not on the schedule, so data/pipeline.md keeps tracked lines unticked, and
 * anyone counting from the file got a higher number than the page. Now all
 * three compose the Inbox here, the same way: parse the lines (inbox-line.mjs),
 * join the scan dates, order newest scan first (inbox-order.mjs), hide a row
 * the tracker already holds (inbox-tracked.mjs), and hide a row hidden with X
 * (data/inbox-hidden.tsv, inbox-hidden.mjs).
 *
 * Plain .mjs with relative imports only, so node loads it from the fork root
 * with no build step and no `@/` alias. A view over the files: nothing here
 * writes.
 */
import fs from "node:fs";
import path from "node:path";
import { parseInboxLine } from "./inbox-line.mjs";
import { parseApplications } from "./tracker-table.mjs";
import { markTrackedInbox } from "./inbox-tracked.mjs";
import { orderInboxByScan } from "./inbox-order.mjs";
import { markHiddenInbox } from "./inbox-hidden.mjs";
import { readHiddenFile } from "./inbox-hidden-file.mjs";

function readText(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** Every job line of data/pipeline.md, ticked or not, in file order. */
export function parseInbox(md) {
  const jobs = [];
  for (const line of String(md ?? "").split("\n")) {
    const job = parseInboxLine(line);
    if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * data/scan-history.tsv → Map<url, first_seen(YYYY-MM-DD)>. The scanner stamps
 * every posting with the date it was first seen (col 2), so the Inbox's
 * freshness comes from here without touching the core. Tolerant by
 * construction: no file → empty map; a malformed row is skipped, never thrown.
 */
export function parseScanDates(tsv) {
  const dates = new Map();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue; // skip header
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    // keep the EARLIEST first_seen if a url recurs (it's "first" seen, after all)
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

export function readScanDates(root) {
  return parseScanDates(readText(root, "data/scan-history.tsv"));
}

/** The composition the Inbox shows: the scan date joined on, newest scan first,
 *  one row per URL, a row the tracker holds marked done with its tracker row,
 *  and a row hidden with X marked done with its time. The tracker wins when a
 *  row is both. */
export function composeInbox(jobs, scanDates, applications, hiddenEntries = []) {
  return markHiddenInbox(
    markTrackedInbox(
      orderInboxByScan(
        jobs.map((j) => ({ ...j, postedAt: j.postedAt ?? scanDates.get(j.url) })),
        scanDates,
      ),
      applications,
    ),
    hiddenEntries,
  );
}

/** Read the four files under `root` and compose the Inbox. `hiddenEntries` is
 *  the whole X list, rows no longer pending included, for the restore control. */
export function readInboxSummary(root) {
  const md = readText(root, "data/pipeline.md");
  const tracker = readText(root, "data/applications.md");
  const jobs = parseInbox(md);
  const applications = tracker ? parseApplications(tracker, root) : [];
  // A file that exists but cannot be read shows every row rather than blanking
  // the page; only the route's write refuses on it (inbox-hidden-file.mjs).
  let hiddenEntries = [];
  try {
    hiddenEntries = readHiddenFile(root);
  } catch {
    /* shown as if nothing were hidden */
  }
  return { jobs, applications, hiddenEntries, inbox: composeInbox(jobs, readScanDates(root), applications, hiddenEntries) };
}

/**
 * The counts a reader of the files needs, beside the page's:
 *   pendingLines — unticked job lines in pipeline.md, what a count of the file gives;
 *   hidden       — rows the tracker holds, each with its tracker row;
 *   hiddenWithX  — rows hidden with X on the dashboard (data/inbox-hidden.tsv);
 *   shown        — rows the Inbox shows, the page's "N in inbox".
 */
export function countInbox(jobs, inbox) {
  return {
    pendingLines: jobs.filter((j) => !j.done).length,
    hidden: inbox.filter((j) => j.tracked),
    hiddenWithX: inbox.filter((j) => j.hiddenWithX),
    shown: inbox.filter((j) => !j.done),
  };
}

/** Whether one URL shows in the Inbox and, when it does not, why. */
export function inboxFate(inbox, url) {
  const row = inbox.find((j) => j.url === url);
  if (!row) return { url, shown: false, reason: "not in pipeline.md" };
  if (!row.done) return { url, shown: true };
  if (row.tracked) {
    const t = row.tracked;
    return { url, shown: false, tracked: t, reason: `already in the tracker as row ${t.n} (${t.status || "no status"})` };
  }
  if (row.hiddenWithX) {
    const at = row.hiddenWithX.at;
    return { url, shown: false, reason: `hidden with X${at ? ` on ${at.slice(0, 10)}` : ""}` };
  }
  return { url, shown: false, reason: "its pipeline.md line is ticked" };
}
