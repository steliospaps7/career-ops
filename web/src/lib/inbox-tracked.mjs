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
 * (LinkedIn's job number, Indeed's jk, the Ashby, Lever, Greenhouse, Workable
 * and Welcome to the Jungle job ids, and an employer site's ashby_jid or
 * gh_jid) and ignores tracking parameters. reportUrl reads the URL line in
 * the shapes reports have been written in.
 * A URL from any other site has no id and matches nothing; a tracker row with
 * no report, or a report with no `**URL:**` line or no readable file, falls
 * back to the company-and-role match. This module reads no files: the caller
 * passes `readReport` (inbox-summary.mjs resolves the link from data/, refuses
 * one outside the career-ops root and skips a NNN-RESERVED.md placeholder, as
 * findReportFile in career-ops.ts does), and each report path is read once per
 * call. With no `readReport`, only the name match runs.
 *
 * A view over the files: nothing here writes, so no lock is needed and the line
 * is still ticked by the next recheck.
 *
 * A row hidden here says why: it carries `tracked`, the tracker row that holds
 * the seat (its number, status and date), whatever that status is. The Inbox
 * lists those rows under "N already in the tracker", and the Explore add says
 * which row kept a new line out. The posting id is tried first, so a row is
 * labelled with its own advert's tracker row; within each match the first
 * tracker row wins.
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
 * LinkedIn follows liveness-api.mjs's match (the parity test holds them
 * together), plus /comm/jobs/view/, the path LinkedIn's emails link to.
 * @param {string | undefined} url
 * @returns {string | null} e.g. "linkedin:4475542689", "indeed:74e4bad5782f4fc4"
 */
export function postingId(url) {
  const raw = String(url ?? "");
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let m;
  if (/(^|\.)linkedin\.com$/.test(host)) {
    if ((m = u.pathname.match(/^\/(?:comm\/)?jobs\/view\/(?:.*-)?(\d+)\/?$/))) return `linkedin:${m[1]}`;
    const current = u.searchParams.get("currentJobId");
    return current && /^\d+$/.test(current) ? `linkedin:${current}` : null;
  }
  if (/(^|\.)indeed\.[a-z.]+$/.test(host) && (m = raw.match(/[?&](?:jk|vjk)=([0-9a-f]+)/i))) return `indeed:${m[1].toLowerCase()}`;
  if (host === "jobs.ashbyhq.com" && (m = u.pathname.match(/^\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/i))) return `ashby:${m[1].toLowerCase()}`;
  // An Ashby board embedded on the employer's own site carries the job in ashby_jid.
  if ((m = raw.match(/[?&]ashby_jid=([0-9a-f-]{36})(?:[&#]|$)/i))) return `ashby:${m[1].toLowerCase()}`;
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(host) && (m = u.pathname.match(/^\/[^/]+\/([0-9a-f-]{36})(?:\/|$)/i))) return `lever:${m[1].toLowerCase()}`;
  if (/(^|\.)greenhouse\.io$/.test(host) && (m = u.pathname.match(/\/jobs\/(\d+)(?:\/|$)/))) return `greenhouse:${m[1]}`;
  if ((m = raw.match(/[?&]gh_jid=(\d+)(?:[&#]|$)/i))) return `greenhouse:${m[1]}`;
  // apply.workable.com/<account>/j/<ID> or /j/<ID>. jobs.workable.com/view/ uses another id, left alone.
  if (host === "apply.workable.com" && (m = u.pathname.match(/^\/(?:[^/]+\/)?j\/([0-9a-f]+)(?:\/|$)/i))) return `workable:${m[1].toUpperCase()}`;
  if (/(^|\.)welcometothejungle\.com$/.test(host) && (m = u.pathname.match(/\/jobs\/[^/]*_([a-z0-9]{6,})\/?$/i))) return `wttj:${m[1].toLowerCase()}`;
  return null;
}

/** The report path a tracker Report cell links, e.g. "../reports/338-x.md"
 *  from "[338](../reports/338-x.md)", or null. Relative to data/. */
function reportPath(cell) {
  const m = String(cell ?? "").match(/\]\(([^)\s]+\.md)\)/);
  return m ? m[1] : null;
}

/** The advert URL on a report's URL line: `**URL:** x`, `URL: x`, `**URL**: x`,
 *  a space or no-break space before the colon, the URL bare or in <...>, and a
 *  trailing ) > ] . or , stripped. */
export function reportUrl(text) {
  const m = String(text ?? "").match(/^[ \t]*(?:\*\*)?URL(?:\*\*)?[ \t ]*:(?:\*\*)?[ \t ]*<?([^\s<>]+)/m);
  return m ? m[1].replace(/[)>\].,]+$/, "") : null;
}

/**
 * @template {{company: string, role: string, url?: string, done: boolean}} T
 * @param {T[]} inbox
 * @param {{company: string, role: string, report?: string, n?: string, status?: string, date?: string}[]} applications
 * @param {(reportPath: string) => (string | null)} [readReport] the text of a report
 *   linked from a tracker row (path as the cell gives it, relative to data/), or
 *   null for one it will not or cannot read
 * @returns {(T & {tracked?: {n: string, status: string, date: string}})[]} the same rows,
 *   with `done: true` and `tracked` on any row the tracker holds
 */
export function markTrackedInbox(inbox, applications, readReport) {
  const tracked = new Map();
  const byPosting = new Map();
  const texts = new Map(); // report path -> text, so each report is read once per call
  for (const a of applications) {
    const t = { n: a.n ?? "", status: a.status ?? "", date: a.date ?? "" };
    const k = key(a.company, a.role);
    if (k && !tracked.has(k)) tracked.set(k, t);
    const rel = readReport ? reportPath(a.report) : null;
    if (!rel) continue;
    if (!texts.has(rel)) {
      let text = null;
      try {
        text = readReport(rel);
      } catch {
        /* an unreadable report falls back to the name match */
      }
      texts.set(rel, text);
    }
    const id = postingId(reportUrl(texts.get(rel)));
    if (id && !byPosting.has(id)) byPosting.set(id, t);
  }
  return inbox.map((j) => {
    if (j.done) return j;
    // The advert's own tracker row first, so it is labelled with that row and
    // not an older row of the same company and title.
    const k = key(j.company, j.role);
    const hit = byPosting.get(postingId(j.url)) || (k && tracked.get(k));
    return hit ? { ...j, done: true, tracked: hit } : j;
  });
}
