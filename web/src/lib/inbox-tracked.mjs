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
 * The match is company plus role, the key the scanner's recheck uses, because it
 * is the only key both files always carry: the line's URL cell can be a
 * `local:jds/` path and the tracker keeps no URL column. A view over the files:
 * nothing here writes, so no lock is needed and the line is still ticked by the
 * next recheck.
 *
 * Plain .mjs so the rule is testable with `node --test` and no build step.
 */
import { normalizeTextKey } from "./core/normalize-text-key.mjs";

function key(company, role) {
  return `${normalizeTextKey(company)}::${normalizeTextKey(role)}`;
}

/**
 * @template {{company: string, role: string, done: boolean}} T
 * @param {T[]} inbox
 * @param {{company: string, role: string}[]} applications
 * @returns {T[]} the same rows, with `done: true` on any row the tracker holds
 */
export function markTrackedInbox(inbox, applications) {
  const tracked = new Set(applications.map((a) => key(a.company, a.role)));
  return inbox.map((j) => (j.done || !tracked.has(key(j.company, j.role)) ? j : { ...j, done: true }));
}
