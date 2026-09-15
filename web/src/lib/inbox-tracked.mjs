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
 * The match is company plus role, the only key both files always carry: the
 * line's URL cell can be a `local:jds/` path and the tracker keeps no URL column.
 * It is NOT the scanner's key. The recheck uses companyRoleDedupKey in scan.mjs
 * (company lowercased and trimmed; role with a trailing location tag stripped),
 * which cannot be imported cleanly from web/. This key drops case, spaces and
 * punctuation from both halves and strips no tag, so the two disagree both ways:
 *   - tracker "Product Manager" and a line "Product Manager (Berlin)": the
 *     scanner calls it a duplicate, the inbox keeps it pending;
 *   - tracker "Thanks Ben" and a line "ThanksBen": the inbox hides it, the
 *     scanner does not.
 * A view over the files: nothing here writes, so no lock is needed and the line
 * is still ticked by the next recheck.
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
 * @template {{company: string, role: string, done: boolean}} T
 * @param {T[]} inbox
 * @param {{company: string, role: string}[]} applications
 * @returns {T[]} the same rows, with `done: true` on any row the tracker holds
 */
export function markTrackedInbox(inbox, applications) {
  const tracked = new Set(applications.map((a) => key(a.company, a.role)).filter(Boolean));
  return inbox.map((j) => {
    const k = key(j.company, j.role);
    return j.done || !k || !tracked.has(k) ? j : { ...j, done: true };
  });
}
