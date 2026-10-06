/**
 * inbox-tracked.mjs — an inbox row whose role is already in the tracker is done.
 *
 * The inbox used to hide a row only when its pipeline.md line was ticked. A
 * single evaluation from the dashboard never ticks the line: the evaluate prompt
 * (run-prompts.mjs) writes the report and the tracker row and stops, and only
 * the scanner's hand-run `--read-pipeline --gate` recheck moves tracked lines to
 * Processed. So a row scored or applied to on 14 September 2026 stayed in the
 * inbox beside its own tracker row.
 *
 * Two matches, either one hides the row.
 *
 * Company plus role, the only key both files always carry: the line's URL cell
 * can be a `local:jds/` path and the tracker keeps no URL column.
 * It is NOT the scanner's key. The recheck uses companyRoleDedupKey in scan.mjs
 * (company lowercased and trimmed; role with a trailing location tag stripped),
 * which cannot be imported cleanly from web/. This key drops case, spaces and
 * punctuation from both halves and strips no tag, so the two disagree both ways:
 *   - tracker "Product Manager" and a line "Product Manager (Berlin)": the
 *     scanner calls it a duplicate, the inbox keeps it pending;
 *   - tracker "Thanks Ben" and a line "ThanksBen": the inbox hides it, the
 *     scanner does not.
 *
 * The advert's own posting id, for a row whose company or title is spelled
 * differently from the tracker's (6 October 2026: tracker row 338 says
 * "Bridebook", the line "Bridebook - The No.1 Wedding Planning App", same
 * LinkedIn advert). A tracker row has no URL, but the report it links does, on
 * its `**URL:**` line. postingId reads the id the job board gives the advert
 * (LinkedIn's /jobs/view/ number, Indeed's jk, the Ashby, Lever, Greenhouse,
 * Workable and Welcome to the Jungle job ids) and ignores tracking parameters.
 * A URL from any other site has no id and matches nothing; a tracker row with
 * no report, or a report with no `**URL:**` line or no readable file, falls
 * back to the company-and-role match. This module reads no files: the caller
 * passes `readReport` (inbox-summary.mjs reads under data/), and each report is
 * read once per call. With no `readReport`, only the name match runs.
 *
 * A view over the files: nothing here writes, so no lock is needed and the line
 * is still ticked by the next recheck.
 *
 * A row hidden here says why: it carries `tracked`, the tracker row that holds
 * the seat (its number, status and date), whatever that status is. The Inbox
 * lists those rows under "N already in the tracker", and the Explore add says
 * which row kept a new line out. The first tracker row with the key, or with
 * the posting id, wins; the name match is tried first.
 *
 * Plain .mjs so the rule is testable with `node --test` and no build step.
 */
import { normalizeTextKey } from "./core/normalize-text-key.mjs";

function key(company, role) {
  const c = normalizeTextKey(company);
  const r = normalizeTextKey(role);
  // A company of "?" (the tracker's unknown-employer marker) or any other
  // symbol-only cell keys to "", and would hide every line with a symbol company
  // and that role. The scanner's index skips such rows too.
  return c && r ? `${c}::${r}` : null;
}

/**
 * The job board's own id for an advert URL, or null for a site without one.
 * @param {string | undefined} url
 * @returns {string | null} e.g. "linkedin:4475542689", "indeed:74e4bad5782f4fc4"
 */
export function postingId(url) {
  const u = String(url ?? "");
  let m;
  if ((m = u.match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/i))) return `linkedin:${m[1]}`;
  if ((m = u.match(/indeed\.[a-z.]+\/[^#]*[?&](?:jk|vjk)=([0-9a-f]+)/i))) return `indeed:${m[1].toLowerCase()}`;
  if ((m = u.match(/jobs\.ashbyhq\.com\/[^/?#]+\/([0-9a-f-]{36})/i))) return `ashby:${m[1].toLowerCase()}`;
  if ((m = u.match(/jobs\.(?:eu\.)?lever\.co\/[^/?#]+\/([0-9a-f-]{36})/i))) return `lever:${m[1].toLowerCase()}`;
  if ((m = u.match(/greenhouse\.io\/[^?#]*\/jobs\/(\d+)/i)) || (m = u.match(/[?&]gh_jid=(\d+)/i))) return `greenhouse:${m[1]}`;
  if ((m = u.match(/apply\.workable\.com\/[^/?#]+\/j\/([0-9a-f]+)/i))) return `workable:${m[1].toUpperCase()}`;
  if ((m = u.match(/welcometothejungle\.com\/[^?#]*\/jobs\/[^/?#]*_([a-z0-9]{6,})(?:[/?#]|$)/i))) return `wttj:${m[1].toLowerCase()}`;
  return null;
}

/** The report path a tracker Report cell links, e.g. "../reports/338-x.md"
 *  from "[338](../reports/338-x.md)", or null. Relative to data/. */
function reportPath(cell) {
  const m = String(cell ?? "").match(/\]\(([^)\s]+\.md)\)/);
  return m ? m[1] : null;
}

/**
 * @template {{company: string, role: string, url?: string, done: boolean}} T
 * @param {T[]} inbox
 * @param {{company: string, role: string, report?: string, n?: string, status?: string, date?: string}[]} applications
 * @param {(reportPath: string) => (string | null)} [readReport] the text of a report
 *   linked from a tracker row (path as the cell gives it, relative to data/), or null
 * @returns {(T & {tracked?: {n: string, status: string, date: string}})[]} the same rows,
 *   with `done: true` and `tracked` on any row the tracker holds
 */
export function markTrackedInbox(inbox, applications, readReport) {
  const tracked = new Map();
  const byPosting = new Map();
  for (const a of applications) {
    const t = { n: a.n ?? "", status: a.status ?? "", date: a.date ?? "" };
    const k = key(a.company, a.role);
    if (k && !tracked.has(k)) tracked.set(k, t);
    const rel = readReport ? reportPath(a.report) : null;
    if (!rel) continue;
    let text = null;
    try {
      text = readReport(rel);
    } catch {
      /* an unreadable report falls back to the name match */
    }
    const id = postingId(String(text ?? "").match(/^\*\*URL:\*\*\s*(\S+)/m)?.[1]);
    if (id && !byPosting.has(id)) byPosting.set(id, t);
  }
  return inbox.map((j) => {
    if (j.done) return j;
    const k = key(j.company, j.role);
    const hit = (k && tracked.get(k)) || byPosting.get(postingId(j.url));
    return hit ? { ...j, done: true, tracked: hit } : j;
  });
}
