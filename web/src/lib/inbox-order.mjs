/**
 * inbox-order.mjs — the inbox opens on the latest scan's rows.
 *
 * The inbox used to order on `postedAt`, and pipelineSummary set it to the
 * line's own `posted:` date ahead of the scan-history date. So on 15 September
 * 2026 the 17:00 run's Klarna row (advert posted 29 August) sank down the list
 * while Scope (posted 15 September) floated, and the six new rows were
 * scattered. `postedAt` still drives the "posted within" filter and the age on
 * each row; the order uses `scannedAt`, the day the scan first saw the posting.
 *
 * scan-history.tsv keeps `first_seen` as a date with no time, so two runs on
 * one day tie. pipeline.md is append-only, so within one day the later line is
 * the later run: it goes first. A row with no scan date (a line added by hand,
 * or one the history never held) goes after every dated row, later lines
 * first. pipeline.md lines carry no scan date of their own, only `posted:`,
 * so the history is the one source.
 *
 * One URL listed twice is one row, and the earlier line is the one kept: it is
 * the one the scan wrote with its labels (posted:, fit:, jd:), and a later bare
 * re-add must not replace it. An earlier ticked line gives way to a later
 * unticked one, as the inbox's first-pending dedupe always did. Every consumer
 * dedupes by URL anyway, so dropping the duplicate here changes no count.
 *
 * Plain .mjs so the rule is testable with `node --test` and no build step. A
 * view over the files: nothing here writes.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @template {{url: string}} T
 * @param {T[]} inbox rows in pipeline.md file order
 * @param {Map<string, string>} scanDates url → first_seen (readScanDates)
 * @returns {(T & {scannedAt?: string})[]} one row per URL, newest scan first
 */
export function orderInboxByScan(inbox, scanDates) {
  // index of the line kept for each URL: the first not ticked, else the first
  const keep = new Map();
  inbox.forEach((job, i) => {
    const k = keep.get(job.url);
    if (k === undefined || (inbox[k].done && !job.done)) keep.set(job.url, i);
  });
  return inbox
    .map((job, i) => ({ job, i }))
    .filter(({ job, i }) => keep.get(job.url) === i)
    .map(({ job, i }) => {
      const d = scanDates.get(job.url);
      return { job: { ...job, scannedAt: d && ISO_DATE.test(d) ? d : undefined }, i };
    })
    .sort((a, b) => compareScannedAt(a.job, b.job) || b.i - a.i)
    .map((e) => e.job);
}

/** Newest `scannedAt` first; a row without one after every row with one. Equal
 *  dates compare 0, so a stable sort keeps the order the rows arrived in. */
export function compareScannedAt(a, b) {
  const x = a.scannedAt || "";
  const y = b.scannedAt || "";
  if (x === y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return y.localeCompare(x);
}

/** How many rows the inbox shows once the rows hidden with X are taken out.
 *  The hidden list is data/inbox-hidden.tsv; an entry for a URL no longer
 *  pending (ticked, or gone from pipeline.md) is not counted. */
export function countNotHidden(pending, hidden) {
  const h = new Set(hidden);
  return pending.filter((j) => !h.has(j.url)).length;
}

/** The browser's old hidden list, read back from localStorage for its one-time
 *  move into data/inbox-hidden.tsv. Anything that is not an array of strings (a
 *  hand edit, another app's value) reads as empty, so a bad value cannot throw
 *  while the Pipeline page renders. */
export function parseHiddenList(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

/** The mark on an Inbox card whose row has no scan date. Such a row sorts after
 *  every dated row (compareScannedAt); the mark says why it sits there. */
export function scanDateMark(job) {
  return job.scannedAt ? null : "no scan date";
}

/** The number on the "N hidden · restore" control: the hidden rows still in
 *  the inbox, or, when none are, every stored entry. The control shows while
 *  the stored list is not empty, so an X on a row since ticked can still be
 *  cleared, and a later re-list of that URL does not arrive already hidden. */
export function restoreCount(pending, hidden) {
  return pending.length - countNotHidden(pending, hidden) || hidden.length;
}
