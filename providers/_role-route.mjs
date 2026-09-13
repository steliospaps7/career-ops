/**
 * providers/_role-route.mjs — the route decision, ticket B2 seam 4.
 *
 * A queued role is labelled `route: score` or `route: standard` before any
 * evaluation token is spent. Tier 1, tier 2 and flagged roles wait for
 * Stelios's Evaluate; everything else gets the standard CV and the basic
 * answers with no evaluation. A role whose advert nobody read is
 * `route: review` instead, and waits for a person to read it (ticket C, C2).
 * The fit gate runs on both routes — the route decides what an application
 * costs, never whether the advert is read.
 *
 * Pure by design, so a change to the tier rule is a one-line edit with a test.
 * The tier table is `data/companies.tsv`, which belongs to the Tiers chat: this
 * module reads it and never writes it, and a company it does not name is
 * untiered rather than an error.
 *
 * Under `providers/` with an underscore prefix like `_http.mjs` and
 * `_advert-reader.mjs`, so the provider registry never discovers it as a board
 * and the system-paths coverage check covers it by directory.
 */

import { existsSync, readFileSync } from 'fs';

/**
 * Canonical company name for the tier lookup: trimmed, lowercased, inner
 * whitespace collapsed. Nothing fuzzier, because a wrong match routes a role to
 * the wrong effort while a miss only costs an evaluation Stelios can press
 * himself.
 */
export function canonicalTierName(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The marker that routes a role to scoring whatever its tier: the literal
 * string `route: score`, in the queue line's note cell or the company's notes
 * column.
 *
 * It was the bare word `flag` until the build review of 11 September 2026.
 * Every occurrence of that word in the real `data/companies.tsv` is a Siyada
 * clause 13.1 compliance note — "Siyada clause 13.1 flag: a supplement brand" —
 * and one of them, Zego, sits on a company marked `out` and read "the size was
 * already the flag". A marker that collides with ordinary prose routes roles by
 * accident, so the Planner's ruling is a literal that no note writes by
 * chance. The word `flag` now routes nothing.
 *
 * Matched case-insensitively with flexible spacing after the colon, because it
 * is typed by hand into a notes cell.
 */
const ROUTE_MARKER_RE = /\broute:\s*score\b/i;

export function noteCarriesRouteMarker(note) {
  return ROUTE_MARKER_RE.test(String(note ?? ''));
}

/**
 * Parse `data/companies.tsv` into a lookup of canonical name → tier and notes.
 *
 * Header-driven rather than positional: the Tiers chat owns the file and may
 * add a column. A row whose name is empty contributes nothing. When one name
 * appears twice the first row wins, so a later stray duplicate cannot silently
 * change a company's route.
 *
 * @param {string} tsvText - Raw file text ('' when the file is absent).
 * @returns {Map<string, {name: string, tier: string, notes: string}>}
 */
export function parseTiersTable(tsvText) {
  const table = new Map();
  const lines = String(tsvText ?? '').split('\n');
  if (lines.length === 0) return table;

  const header = lines[0].split('\t').map(cell => cell.trim().toLowerCase());
  const nameAt = header.indexOf('name');
  const tierAt = header.indexOf('tier');
  const notesAt = header.indexOf('notes');
  if (nameAt === -1) return table;

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const name = String(cells[nameAt] ?? '').trim();
    if (!name) continue;
    const key = canonicalTierName(name);
    if (table.has(key)) continue;
    table.set(key, {
      name,
      tier: tierAt === -1 ? '' : String(cells[tierAt] ?? '').trim(),
      notes: notesAt === -1 ? '' : String(cells[notesAt] ?? '').trim(),
    });
  }
  return table;
}

/** Filesystem wrapper. A missing file is an empty table, never an error. */
export function loadTiersTable(tiersPath) {
  if (!tiersPath || !existsSync(tiersPath)) return new Map();
  try {
    return parseTiersTable(readFileSync(tiersPath, 'utf-8'));
  } catch {
    return new Map();
  }
}

/**
 * The route and the bucket the run summary counts it under.
 *
 * Buckets are exclusive and resolved in this order, so a row is counted once:
 * `tier1`, `tier2`, `dream`, `flagged`, `tier3`, `untiered`.
 *
 * `dream` is the Tiers chat's own word for the wish list — Google, Anthropic,
 * OpenAI and eight more. The spec's rule names tiers 1, 2 and 3 only, because
 * it was written before that value existed in the column. Routing the wish list
 * to `standard` would send the standard pack with no evaluation to the
 * companies Stelios most wants, which is the opposite of what story 17 asks
 * for, so `dream` scores. Every other value the column carries (`out`,
 * `unread`, empty, a name not in the table) is untiered and routes standard.
 *
 * An advert nobody read comes first (ticket C, C2): whatever the tier, it is
 * `review`, because a person reads it before anything is sent. `standard`
 * would send the standard pack on an empty description, and `score` would
 * spend an evaluation on one. A row with no read status at all, which is a
 * board that handed over its own description, routes on its tier as before.
 *
 * @param {string} companyName - Company as the queue line or the board names it.
 * @param {Map<string, {tier: string, notes: string}>} tiersTable
 * @param {string} [lineNote] - The queue line's own note text.
 * @param {string|null} [readStatus] - The stored advert's read status, or null.
 * @returns {{route: 'score'|'standard'|'review', bucket: string, tier: string}}
 */
export function routeDetail(companyName, tiersTable, lineNote = '', readStatus = null) {
  const entry = tiersTable instanceof Map
    ? tiersTable.get(canonicalTierName(companyName))
    : null;
  const tier = entry ? String(entry.tier ?? '').trim().toLowerCase() : '';

  if (readStatus != null && readStatus !== 'read') return { route: 'review', bucket: 'unread', tier };
  if (tier === '1') return { route: 'score', bucket: 'tier1', tier };
  if (tier === '2') return { route: 'score', bucket: 'tier2', tier };
  if (tier === 'dream') return { route: 'score', bucket: 'dream', tier };
  if (noteCarriesRouteMarker(lineNote) || noteCarriesRouteMarker(entry?.notes)) {
    return { route: 'score', bucket: 'flagged', tier };
  }
  if (tier === '3') return { route: 'standard', bucket: 'tier3', tier };
  return { route: 'standard', bucket: 'untiered', tier };
}

/**
 * The route alone, which is what rides the queue line as `route: <value>`.
 *
 * @returns {'score'|'standard'|'review'}
 */
export function routeByTier(companyName, tiersTable, lineNote = '', readStatus = null) {
  return routeDetail(companyName, tiersTable, lineNote, readStatus).route;
}

/** The buckets, in the order the summary prints them. */
export const ROUTE_BUCKETS = {
  score: ['tier1', 'tier2', 'dream', 'flagged'],
  standard: ['tier3', 'untiered'],
  review: ['unread'],
};

export const ROUTE_BUCKET_LABELS = {
  tier1: 'tier 1',
  tier2: 'tier 2',
  dream: 'dream',
  flagged: 'flagged',
  tier3: 'tier 3',
  untiered: 'untiered',
  unread: 'unread',
};
