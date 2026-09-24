/**
 * inbox-hidden.mjs — the rows hidden with X, kept in data/inbox-hidden.tsv.
 *
 * An X used to hide a row in one browser's localStorage only. It never reached
 * another browser, the Planner or the run readers, so the page counted fewer
 * rows than every other reader. The list now lives in one file under data/,
 * two tab-separated columns with a header:
 *
 *   url	hidden_at
 *   https://…	2026-09-24T19:05:11Z
 *
 * `hidden_at` is the UTC time of the X. The dashboard is the only writer, through
 * /api/inbox-hidden, which writes the whole file with atomicWrite. pipeline.md is
 * never written: the scan rewrites it at the end of a run, and a dashboard write
 * would race it.
 *
 * Plain .mjs with no node imports, so the page, the route and the root command
 * share it, and it tests with `node --test` and no build step. The file read
 * lives in inbox-hidden-file.mjs.
 */

export const HIDDEN_FILE = "data/inbox-hidden.tsv";
const HEADER = "url\thidden_at";
const UTC_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The UTC time of an X, to the second: `2026-09-24T19:05:11Z`. */
export function hiddenStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A URL the file can hold: a non-empty string with no tab or line break, which
 *  would split the line. Anything else is dropped. */
function cleanUrl(u) {
  if (typeof u !== "string") return null;
  const t = u.trim();
  return t && !/[\t\r\n]/.test(t) ? t : null;
}

/** A request's URL list: an array of strings, cleaned, without duplicates.
 *  Anything that is not an array reads as empty. */
export function cleanUrlList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const u of value) {
    const c = cleanUrl(u);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * data/inbox-hidden.tsv → [{url, hidden_at}], in file order, one per URL (the
 * first line wins). Tolerant by construction: no file or an empty file reads as
 * empty; the header and blank lines are skipped; a line with no URL is dropped;
 * a line with a URL but a bad time keeps the URL with `hidden_at` "", so a hand
 * edit cannot bring a hidden row back.
 */
export function parseHiddenTsv(text) {
  const entries = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim() || line.startsWith("url\t") || line.trim() === "url") continue;
    const [rawUrl, rawAt = ""] = line.split("\t");
    const url = cleanUrl(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const at = rawAt.trim();
    entries.push({ url, hidden_at: UTC_STAMP.test(at) ? at : "" });
  }
  return entries;
}

/** [{url, hidden_at}] → the file's text, header first, one line per entry. */
export function serializeHiddenTsv(entries) {
  return [HEADER, ...entries.map((e) => `${e.url}\t${e.hidden_at}`)].join("\n") + "\n";
}

/**
 * One change to the list: `add` URLs not yet held get a line stamped `now`;
 * `remove` URLs lose theirs. A URL already held keeps its first time, so the
 * browser's old list merged twice adds nothing the second time.
 * @returns {{entries: {url: string, hidden_at: string}[], added: number, removed: number}}
 */
export function applyHiddenChange(entries, { add = [], remove = [] } = {}, now = hiddenStamp()) {
  const drop = new Set(cleanUrlList(remove));
  const kept = entries.filter((e) => !drop.has(e.url));
  const removed = entries.length - kept.length;
  const held = new Set(kept.map((e) => e.url));
  let added = 0;
  for (const url of cleanUrlList(add)) {
    if (held.has(url) || drop.has(url)) continue;
    held.add(url);
    kept.push({ url, hidden_at: now });
    added++;
  }
  return { entries: kept, added, removed };
}

/**
 * Mark the Inbox rows hidden with X. A row still pending whose URL the file
 * holds gets `done: true` and `hiddenWithX: {at}`, so the page, /api/pipeline
 * and `node inbox-summary.mjs` all leave it out. A row already done (ticked, or
 * held by the tracker) is left as it is: it has its own reason.
 */
export function markHiddenInbox(inbox, entries) {
  if (!entries.length) return inbox;
  const at = new Map(entries.map((e) => [e.url, e.hidden_at]));
  return inbox.map((j) => (j.done || !at.has(j.url) ? j : { ...j, done: true, hiddenWithX: { at: at.get(j.url) } }));
}

/**
 * Move the browser's old list (localStorage, before the file existed) into the
 * file, once. `post(urls)` sends them to the route and resolves to its answer.
 * The browser key is cleared only when the answer carries the merged count; a
 * failed or odd answer leaves it for the next load. The merge adds no duplicates,
 * so running twice is harmless.
 * @param {{
 *   storage: {getItem: (k: string) => string | null, removeItem: (k: string) => void},
 *   key: string,
 *   parse: (raw: string) => string[],
 *   post: (urls: string[]) => Promise<{count?: unknown, added?: number} | null>,
 *   log?: (msg: string) => void,
 * }} io
 * @returns {Promise<{status: "none" | "merged" | "kept", sent?: number, count?: number, added?: number}>}
 */
export async function migrateBrowserHidden({ storage, key, parse, post, log = () => {} }) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "none" };
  }
  if (raw == null) return { status: "none" };
  const urls = parse(raw);
  let answer = null;
  try {
    answer = await post(urls);
  } catch {
    answer = null;
  }
  if (!answer || !Number.isInteger(answer.count)) return { status: "kept", sent: urls.length };
  try {
    storage.removeItem(key);
  } catch {
    /* the merge is idempotent; a key left behind merges again next load */
  }
  log(
    `career-ops: moved ${urls.length} browser-hidden row(s) into ${HIDDEN_FILE}; ` +
      `${answer.added ?? "?"} new, the file now holds ${answer.count}`,
  );
  return { status: "merged", sent: urls.length, count: answer.count, added: answer.added };
}
