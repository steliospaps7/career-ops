/**
 * inbox-link.mjs — whether an inbox row's stored URL may become a link.
 *
 * Plain .mjs (same pattern as inbox-line.mjs) so the rule is testable with
 * `node --test` and no build step; `TriageRow` calls it for the line under
 * "Company · Role". A view over the row: nothing here writes.
 */

/** The row's URL as an `href` when it is an `http:` or `https:` address,
 *  returned exactly as stored (never shortened or re-encoded). Null for
 *  anything else — empty, `local:jds/…`, `javascript:`, another scheme — so the
 *  caller shows it as plain text, or no line when empty. */
export function inboxLinkHref(url) {
  const s = String(url ?? "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return s;
}
