/**
 * inbox-line.mjs — one data/pipeline.md line read into an inbox job.
 *
 * Plain .mjs (same pattern as report-sections.mjs) so the rule is testable with
 * `node --test` and no build step; `readInbox` in career-ops.ts calls it for
 * every line. A view over the file: nothing here writes.
 */

/** A pipeline-row segment like `posted: 2026-07-14`, `trust: 62 stale` or
 *  `note: …` — the core appends these LABELED segments after whatever
 *  positional shape a row has (3/4/5 columns), so a naive positional reader
 *  would misread them as location/compensation on short rows. Any
 *  `word:`-prefixed segment is treated as labeled (forward-compatible with
 *  labels the core hasn't invented yet). */
const LABELED_SEGMENT = /^([a-z][a-z_-]*):\s*(.*)$/i;

/** Parse one line — `- [ ] URL | Company | Role [| Location [| Compensation]] [| label: …]*`.
 *  Positional split for the first columns (the optional 4th `location` #1015
 *  and 5th `compensation` #1017 must NOT bleed into `role`); labeled segments
 *  (posted:/trust:/note:/…) are filtered out of positional assignment wherever
 *  they appear and surfaced when useful (posted: → postedAt, the fit
 *  judgement's fit: and route:, ticket D2b, and jd: → the saved advert).
 *  Unknown labels and further
 *  trailing columns are ignored gracefully. Returns null for a line that is not
 *  a job. */
export function parseInboxLine(line) {
  const m = String(line).match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
  if (!m) return null;
  const all = m[2].split("|").map((s) => s.trim());
  const labels = new Map();
  const parts = [];
  for (const [i, seg] of all.entries()) {
    // the URL cell can contain a colon-y value but is always position 0
    const lm = i >= 3 ? seg.match(LABELED_SEGMENT) : null;
    if (lm) labels.set(lm[1].toLowerCase(), lm[2].trim());
    else parts.push(seg);
  }
  if (parts.length < 3 || !parts[0]) return null; // need at least url | company | role
  const posted = labels.get("posted");
  return {
    done: m[1].toLowerCase() === "x",
    url: parts[0],
    company: parts[1],
    role: parts[2],
    location: parts[3] || undefined, // optional 4th column (#1015)
    compensation: parts[4] || undefined, // optional 5th column (#1017); 6th+ ignored
    // the row's own posting date (scan.mjs `posted:` label) — a more direct
    // freshness signal than the scan-history join, which stays as fallback
    postedAt: posted && /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : undefined,
    // the fit judgement's verdict and the route it set (ticket D2b)
    fit: labels.get("fit") || undefined,
    route: labels.get("route") || undefined,
    // where the scanner saved the advert text, e.g. `local:jds/acme-pm-1a2b.md`
    // (modes/pipeline.md's `local:` prefix). Surfaced raw; the caller decides
    // whether the reference is one it will read.
    jd: labels.get("jd") || undefined,
  };
}

/** The one short line the inbox card shows for the fit judgement: `PASS`, or
 *  `review: <reason>` for a SKIP or a REVIEW the gate kept in the queue. Null
 *  when the line carries no verdict, so a row the gate never judged looks as it
 *  always did. */
export function fitCardLine(job) {
  const fit = String(job?.fit ?? "").trim();
  const m = fit.match(/^(PASS|SKIP|REVIEW)\b\s*(?:\((.*)\))?\s*$/i);
  if (!m) return null;
  if (m[1].toUpperCase() === "PASS") return "PASS";
  const reason = (m[2] || "").trim();
  return reason ? `review: ${reason}` : "review";
}
