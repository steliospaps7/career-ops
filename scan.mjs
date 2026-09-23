#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner with a plugin-based provider layer.
 *
 * Providers live in providers/*.mjs and are loaded at startup. Each provider
 * exports a default object with:
 *   - id: string — matched against `provider:` in portals.yml
 *   - detect(entry): {url}|null — optional auto-detection from careers_url
 *   - fetch(entry, ctx): [{title,url,company,location}] — required
 *
 * Files prefixed with _ are shared helpers (e.g. _http.mjs) and are never
 * loaded as providers. Adding a new HTTP/API source = drop a *.mjs into
 * providers/. Local executable parsers use `providers/local-parser.mjs` when
 * `parser.command` + `parser.script` are set in portals.yml.
 *
 * A tracked_companies entry can set `provider:` explicitly to bypass
 * URL-based auto-detection. The `transport:` field is reserved for future
 * transports — Phase A only ships the http transport.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 *   node scan.mjs --verify         # Playwright-check each new URL; drop expired postings
 *   node scan.mjs --verify --headed-fallback  # retry anti-bot-blocked URLs in a headed browser (needs a display)
 *   node scan.mjs --verify --throttle          # jittered ~5-10s gap between checks (stay under rate limits)
 *   node scan.mjs --verify --throttle=8000     # custom base gap in ms (waits base..2*base)
 *   node scan.mjs --include-blacklisted        # let data/blacklist.md matches through (annotated)
 *   node scan.mjs --since 7                    # postings from the last 7 days
 *   node scan.mjs --posted-after 2026-07-01    # absolute lower bound on posting date
 *   node scan.mjs --posted-before 2026-08-01   # absolute upper bound on posting date
 *   node scan.mjs --rediscover-404             # re-verify tracked URLs that 404/410 (rides on --verify)
 *   node scan.mjs --quiet                      # suppress the manifesto footer
 *   node scan.mjs --help                       # print this usage block and exit
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import * as yaml from 'js-yaml';

import { makeHttpCtx } from './providers/_http.mjs';
import { buildTrustValidator } from './providers/_trust-validator.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { mergeProviderPlugins } from './plugins/_engine.mjs';
import { classifyFetchError } from './verify-portals.mjs';
import { fingerprintText, findCrossListings } from './fingerprint-core.mjs';
import { resolveColumns, parseTrackerRow, normalizeTextKey } from './tracker-parse.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { normalizeCompanyName } from './invite-match.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import {
  readAdvert,
  saveAdvert,
  findAdvert,
  loadAdvertText,
  advertStatusAt,
  defaultTransports,
} from './providers/_advert-reader.mjs';
import { compileKeyword, compilePositiveKeyword, compileContentKeyword, buildTitleFilter } from './title-keywords.mjs';
import {
  routeDetail,
  routeByTier,
  loadTiersTable,
  ROUTE_BUCKETS,
  ROUTE_BUCKET_LABELS,
} from './providers/_role-route.mjs';
import { extractExperienceClauses } from './providers/_experience-clause.mjs';
import { readFitGateSettings, buildFitGate, formatFitValue, formatFitSkipReason, formatFitSummary } from './providers/_fit-gate.mjs';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { withPortalHealthLock } from './portal-health-lock.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { promoteKnownFragmentIdentity } from './url-key.mjs';

try {
  const { config } = await import('dotenv');
  // quiet: dotenv's startup banner goes to stdout, which --json reserves for a
  // single JSON object (#1906).
  config({ quiet: true });
} catch {
  // dotenv is optional — fall back to process.env if not installed
}

const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();

export const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(DATA_ROOT, 'portals.yml');
const PROFILE_PATH = process.env.CAREER_OPS_PROFILE || path.join(DATA_ROOT, 'config/profile.yml');
// Overridable for the same reason the two inputs above are (#2271). A second
// search lane - a bridge/income track, a career-change track, a partner sharing
// the checkout - already gets its own portals.yml and profile, but without these
// two it still writes into the one inbox and the one dedup history. That is not
// just untidy: scan-history.tsv IS the dedup source, so a posting surfaced in
// lane A is silently counted as a duplicate in lane B and never shown at all.
// Exported because scan-ats-full.mjs, scan-interamt.mjs and scan-hn.mjs write to
// these same files through appendToPipeline/appendToScanHistory. They each used
// to carry their own bare-relative copy, so a sibling could check existence and
// create data/pipeline.md in the cwd, then append the actual results to the
// anchored one (#3510). One resolution, imported, cannot drift.
export const SCAN_HISTORY_PATH = process.env.CAREER_OPS_SCAN_HISTORY || path.join(DATA_ROOT, 'data/scan-history.tsv');
export const PIPELINE_PATH = process.env.CAREER_OPS_PIPELINE || path.join(DATA_ROOT, 'data/pipeline.md');
// Where the read adverts are stored (ticket B1). Anchored like every other data
// path; the apify plugin writes the same filename shape into the same folder,
// so jd-capture.mjs resolves either writer's file.
export const JDS_DIR = path.join(DATA_ROOT, 'jds');
// The tier table (ticket B2). data/companies.tsv belongs to the Tiers chat:
// this scanner reads it and never writes it, and a company it does not name is
// untiered rather than an error.
//
// CAREER_OPS_TIERS is a TEST SEAM, not a documented user override: it exists so
// a run can be pointed at a fixture table instead of the real one. It is
// deliberately absent from AGENTS.md and DATA_CONTRACT.md. If it ever becomes
// something a user is told to set, it needs a row there and a line in the
// docs; until then, treat it as internal.
export const TIERS_PATH = process.env.CAREER_OPS_TIERS || path.join(DATA_ROOT, 'data/companies.tsv');
// The tracker, through the repo's own resolver rather than a sixth spelling of
// the same rule: it honours CAREER_OPS_TRACKER, canonicalises symlinks, and
// carries the `{DATA_ROOT}/applications.md` fallback AGENTS.md records. The
// scanner used to hard-code the path and so could not be pointed at a copy,
// which is what `--read-pipeline --gate` needs to be proved against. Read-only
// here: nothing in this file writes the tracker.
const APPLICATIONS_PATH = resolveTrackerPath(DATA_ROOT);
const PROVIDERS_DIR = path.resolve(CODE_ROOT, 'providers');

// Ensure required directories exist (fresh setup). Stays rooted in the user-data
// directory; override parents are created by their writers before first write.
const targetDataDir = path.join(DATA_ROOT, 'data');
try {
  mkdirSync(targetDataDir, { recursive: true });
} catch (err) {
  console.error(`ERROR: Could not create data directory at "${targetDataDir}": ${err.message}`);
  process.exit(1);
}

const CONCURRENCY = 10;

export function isIgnorableDirectoryFsyncError(err, platform = process.platform) {
  return ['EINVAL', 'ENOTSUP', 'ENOSYS'].includes(err?.code)
    || (platform === 'win32' && ['EACCES', 'EPERM'].includes(err?.code));
}

export function atomicWriteFile(filePath, text) {
  const fileStat = lstatSync(filePath, { throwIfNoEntry: false });
  const targetPath = fileStat?.isSymbolicLink() ? realpathSync(filePath) : filePath;
  const tempPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  let fd = null;
  let directoryFd = null;
  try {
    const existingMode = existsSync(targetPath) ? statSync(targetPath).mode & 0o7777 : null;
    fd = openSync(tempPath, 'wx', 0o600);
    if (existingMode !== null) fchmodSync(fd, existingMode);
    writeFileSync(fd, text, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, targetPath);
    try {
      directoryFd = openSync(path.dirname(targetPath), 'r');
      fsyncSync(directoryFd);
    } catch (err) {
      if (!isIgnorableDirectoryFsyncError(err)) throw err;
    } finally {
      if (directoryFd !== null) closeSync(directoryFd);
      directoryFd = null;
    }
  } catch (err) {
    if (fd !== null) closeSync(fd);
    if (directoryFd !== null) closeSync(directoryFd);
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw err;
  }
}

export function emitJsonReceipt(receipt, exitCode) {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = exitCode;
}

// Provider loading + routing live in providers/_registry.mjs so the portal
// health check (verify-portals.mjs) can reuse the exact same layer without
// importing this module.

// ── Title filter ────────────────────────────────────────────────────

// How a keyword matches text lives in title-keywords.mjs, because
// openrouter-runner.mjs filters titles too and cannot import this file (scan.mjs
// creates data/ at import time). It called a second, hand-kept copy of this
// logic until the two drifted; there is now one implementation and this file
// re-exports it, so existing importers — scan-ats-full.mjs and test-all.mjs's
// sections 11b and 44 among them — keep resolving it from here.
// compileContentKeyword shares the `word:`/`stem:` prefix machinery but skips
// the title filter's short-acronym auto-anchor (#3274).
export { compileKeyword, compilePositiveKeyword, compileContentKeyword, buildTitleFilter };

// Compiled-matcher cache for matchedTitleKeywords(), keyed by the
// `title_filter.positive` array reference. The scan loop calls this once per
// job with the same titleFilter config object, so caching avoids recompiling
// every keyword (compileKeyword()) on every single job.
const compiledPositiveCache = new WeakMap();

function compiledPositiveMatchers(positiveList) {
  if (compiledPositiveCache.has(positiveList)) return compiledPositiveCache.get(positiveList);
  const compiled = positiveList
    .filter(k => typeof k === 'string' && k.trim().length > 0)
    .map(k => ({ raw: k, match: compilePositiveKeyword(k.trim().toLowerCase()) }));
  compiledPositiveCache.set(positiveList, compiled);
  return compiled;
}

// Returns the raw (as-written in portals.yml) `title_filter.positive` keywords
// that matched a given title — used to scope `content_filter.by_title_keyword`
// overrides to only the categories that opted into a stricter content check.
// "Raw" includes a `word:` prefix if the entry carries one, so a
// `by_title_keyword` key must be written exactly as the positive entry is.
export function matchedTitleKeywords(title, titleFilter) {
  const raw = Array.isArray(titleFilter?.positive) ? titleFilter.positive : [];
  const lower = (title || '').toLowerCase();
  return compiledPositiveMatchers(raw)
    .filter(({ match }) => match(lower))
    .map(({ raw: kw }) => kw);
}

// ── Location filter ─────────────────────────────────────────────────
// Optional. If `location_filter` is absent from portals.yml, all locations pass.
// Semantics (case-insensitive substring, in this order):
//   - Empty / whitespace-only / non-string location → pass (don't penalize
//     missing or malformed provider data)
//   - `block_hard` matches → reject (the only tier `always_allow` cannot
//     override; for country-level terms that are never a false rejection)
//   - `always_allow` matches → pass (takes precedence over `block` — lets a
//     multi-location string like "Remote, Belgium or France" through because
//     the home region is an option, even though "france" is blocked). When
//     always_allow names the US as a country (united states / usa / u.s. /
//     u.s.a.), USPS state names and 2-letter codes are additional always_allow
//     matches, so block: [Dublin] does not drop "Dublin, OH".
//   - `block` matches → reject
//   - `allow` empty → pass (already cleared block)
//   - `allow` non-empty → must match at least one keyword, OR the TITLE carries
//     an explicit remote marker (see titleSignalsRemote below)

// Normalize a keyword list from portals.yml: tolerates a bare string
// (wrapped to a 1-item array), null/undefined (→ []), and non-string
// entries (filtered out). Survivors are lowercased, trimmed, and any
// resulting empty strings are dropped — an empty keyword would otherwise
// match every location via String.includes(''), silently bypassing the
// other tiers.
function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

// Compile a location keyword into a word-boundary matcher.
//
// Plain String.includes() is wrong for location keywords because country and
// city names are prefixes of unrelated US place names. The motivating bug:
// blocking "india" also rejected "Indian Head, MD", "Indiana", and
// "Indianapolis" — real US locations, silently dropped from every scan.
// Likewise "china" would swallow "Chinatown" and "uk -" would swallow "Truck -".
//
// Lookarounds rather than \b so keywords that begin or end with punctuation
// (", IND", "UK -") still anchor correctly — \b is defined relative to word
// characters and behaves surprisingly at a punctuation edge.
// Note: distinct from compileKeyword() above, which serves the *title* filter and
// only boundary-anchors 2-3 letter acronyms. Location keywords need boundaries on
// every keyword, so they get their own compiler rather than changing title-matching
// behaviour. Returns a predicate, mirroring compileKeyword()'s shape.
function compileLocationKeyword(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startsWord = /[a-z0-9]/.test(keyword[0]);
  const endsWord = /[a-z0-9]/.test(keyword[keyword.length - 1]);
  const prefix = startsWord ? '(?<![a-z0-9])' : '';
  const suffix = endsWord ? '(?![a-z0-9])' : '';
  const re = new RegExp(`${prefix}${escaped}${suffix}`);
  return (lower) => re.test(lower);
}

function compileLocationKeywordList(value) {
  return normalizeKeywordList(value).map(compileLocationKeyword);
}

// Frozen USPS state-name + abbreviation table. Not a world gazetteer: only
// consulted when always_allow already names the United States as a country,
// so EU-targeted configs (no US token) keep their previous semantics.
const US_COUNTRY_ALWAYS_ALLOW = new Set(['united states', 'usa', 'u.s.', 'u.s.a.']);
const USPS_STATES = Object.freeze([
  Object.freeze(['alabama', 'al']),
  Object.freeze(['alaska', 'ak']),
  Object.freeze(['arizona', 'az']),
  Object.freeze(['arkansas', 'ar']),
  Object.freeze(['california', 'ca']),
  Object.freeze(['colorado', 'co']),
  Object.freeze(['connecticut', 'ct']),
  Object.freeze(['delaware', 'de']),
  Object.freeze(['florida', 'fl']),
  Object.freeze(['georgia', 'ga']),
  Object.freeze(['hawaii', 'hi']),
  Object.freeze(['idaho', 'id']),
  Object.freeze(['illinois', 'il']),
  Object.freeze(['indiana', 'in']),
  Object.freeze(['iowa', 'ia']),
  Object.freeze(['kansas', 'ks']),
  Object.freeze(['kentucky', 'ky']),
  Object.freeze(['louisiana', 'la']),
  Object.freeze(['maine', 'me']),
  Object.freeze(['maryland', 'md']),
  Object.freeze(['massachusetts', 'ma']),
  Object.freeze(['michigan', 'mi']),
  Object.freeze(['minnesota', 'mn']),
  Object.freeze(['mississippi', 'ms']),
  Object.freeze(['missouri', 'mo']),
  Object.freeze(['montana', 'mt']),
  Object.freeze(['nebraska', 'ne']),
  Object.freeze(['nevada', 'nv']),
  Object.freeze(['new hampshire', 'nh']),
  Object.freeze(['new jersey', 'nj']),
  Object.freeze(['new mexico', 'nm']),
  Object.freeze(['new york', 'ny']),
  Object.freeze(['north carolina', 'nc']),
  Object.freeze(['north dakota', 'nd']),
  Object.freeze(['ohio', 'oh']),
  Object.freeze(['oklahoma', 'ok']),
  Object.freeze(['oregon', 'or']),
  Object.freeze(['pennsylvania', 'pa']),
  Object.freeze(['rhode island', 'ri']),
  Object.freeze(['south carolina', 'sc']),
  Object.freeze(['south dakota', 'sd']),
  Object.freeze(['tennessee', 'tn']),
  Object.freeze(['texas', 'tx']),
  Object.freeze(['utah', 'ut']),
  Object.freeze(['vermont', 'vt']),
  Object.freeze(['virginia', 'va']),
  Object.freeze(['washington', 'wa']),
  Object.freeze(['west virginia', 'wv']),
  Object.freeze(['wisconsin', 'wi']),
  Object.freeze(['wyoming', 'wy']),
]);

// 2-letter codes: comma-state (", OH" / ",OH, USA") or a trailing token
// ("Dublin OH", Workday URL hint "dublin oh"). Not a generic word-boundary —
// English "in"/"or"/"me" in "Remote, Belgium or France" must not impersonate
// Indiana/Oregon/Maine. State *names* still use compileLocationKeyword.
function compileUsStateAbbrev(abbr) {
  const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:,\\s*${escaped}(?![a-z0-9])|(?:^|[^a-z0-9])${escaped}[^a-z0-9]*$)`);
  return (lower) => re.test(lower);
}

const US_STATE_ALWAYS_ALLOW_MATCHERS = USPS_STATES.flatMap(([name, abbr]) => [
  compileLocationKeyword(name),
  compileUsStateAbbrev(abbr),
]);

// Some providers report a rolled-up display string ("5 Locations", "2 Locations")
// while the canonical URL still names the real primary location. Workday is the
// common case: .../job/Hyderabad-Telangana-India/Network-Engineer_R-65193-1 shows
// up as "5 Locations", so no `block` keyword can ever match the location field.
// Recover that signal by reading the path segment right after `/job/`.
//
// Deliberately narrow: only the post-`/job/` segment is inspected, never the whole
// URL. Scanning the full URL would match company slugs and ATS subdomains by
// accident (a "china" or "india" substring inside an unrelated path). Providers
// without the Workday hostname convention yield no hint and keep their previous
// behaviour exactly, even if their own routes also contain `/job/{id}`.
export function locationHintFromUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (!parsed.hostname.toLowerCase().endsWith('.myworkdayjobs.com')) return '';
  const segments = parsed.pathname.split('/').filter(Boolean);
  const jobIdx = segments.lastIndexOf('job');
  if (jobIdx === -1 || jobIdx === segments.length - 1) return '';
  let segment = segments[jobIdx + 1];
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
  }
  // "Hyderabad-Telangana-India" → "hyderabad telangana india" so multi-word
  // block keywords like "united arab emirates" can still match.
  return segment.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Some ATSs report the hiring office as the location even when the role is
// remote, and state the remoteness in the TITLE instead: Radancy/TalentBrew
// tenants return bare "City, State" strings, so
//   "Program Manager - Remote"  ->  location "Las Vegas, Nevada"
// An `allow` list written in country/region terms ("united states", "remote")
// then rejects a genuinely remote US role. Live measurement on
// careers.unitedhealthgroup.com: 14 PM-family postings, 0 passed `allow`,
// 5 of them said "Remote" outright in the title.
//
// Only an unambiguous work-arrangement marker counts. A bare /remote/ test
// would admit domain compounds — "Remote Sensing Program Manager" is an
// on-site GIS role, and Esri (a tracked company) posts exactly those. So
// "remote" must be followed by end-of-string, a non-letter (")", ",", "-"),
// or " in …" as in "Remote in MO" — never by another word, which is what makes
// "remote sensing" / "remote monitoring" compounds.
export const REMOTE_TITLE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/;

// …and a negation before the word has to lose, which the marker regex alone
// cannot see: in "Non-Remote" / "Not Remote" the delimiter clears the lookbehind
// and the trailing position clears the lookahead, so an explicitly on-site role
// would bypass a non-empty `allow` list — the exact opposite of the intent.
// The separator class must be at least as broad as the marker's own delimiter
// lookahead, or the guard is trivially sidestepped. An ASCII-only `[\s-]*` let
// every non-ASCII dash through — "Non–Remote" (en dash), "Non‑Remote"
// (non-breaking hyphen), em dash, figure dash and minus all still read as
// remote. `[^a-z]*` matches the marker's breadth: it spans any run of
// non-letters, so no punctuation variant can slip between the negation and the
// word.
// It cannot over-reach, because it never crosses a letter: in "Nonprofit
// Program Manager - Remote" the run after "non" starts with "profit", so the
// negation cannot reach "remote". Same for "Not-for-Profit … - Remote",
// "Nordic … - Remote", "Notary … - Remote".
// A negation anywhere in the title disqualifies it. Over-rejecting here is the
// safe direction: this tier only ever *rescues* a posting, so a false negative
// restores the previous behavior while a false positive admits an on-site role.
export const REMOTE_NEGATED_RE = /\b(?:non|not|no)[^a-z]*remote/;

/** @param {unknown} title @returns {boolean} whether the title marks the role remote. */
export function titleSignalsRemote(title) {
  if (typeof title !== 'string' || title.trim() === '') return false;
  const lower = title.toLowerCase();
  if (REMOTE_NEGATED_RE.test(lower)) return false;
  return REMOTE_TITLE_RE.test(lower);
}

// `url` and `title` are optional. Callers that omit them get the original
// location-only semantics, which is what the existing unit tests exercise.
export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllowKeywords = normalizeKeywordList(locationFilter.always_allow);
  const alwaysAllow = alwaysAllowKeywords.map(compileLocationKeyword);
  // US-targeted configs list the country in always_allow and foreign cities
  // in block. "Dublin, OH" does not contain "United States", so without this
  // expansion block: [Dublin] rejects a real US job. Opt-in on the country
  // token — configs with no US always_allow entry are unchanged.
  if (alwaysAllowKeywords.some(k => US_COUNTRY_ALWAYS_ALLOW.has(k))) {
    alwaysAllow.push(...US_STATE_ALWAYS_ALLOW_MATCHERS);
  }
  const allow = compileLocationKeywordList(locationFilter.allow);
  const block = compileLocationKeywordList(locationFilter.block);
  const blockHard = compileLocationKeywordList(locationFilter.block_hard);

  return (location, url, title) => {
    const lower = typeof location === 'string' ? location.trim().toLowerCase() : '';
    const hint = locationHintFromUrl(url);
    // Nothing to judge on either field → pass (don't penalize missing data).
    if (lower === '' && hint === '') return true;
    const matches = (m) => (lower !== '' && m(lower)) || (hint !== '' && m(hint));
    // `block_hard` is the ONE tier always_allow cannot override. It exists because
    // a European city name can be a whole word inside a non-European location, so
    // word-boundary matching (#2087) does not catch it and always_allow's
    // unconditional win silently discards the user's own block entry:
    //
    //   "Porto Alegre, Rio Grande do Sul, Brazil"  always_allow "Porto" beats block "Brazil"
    //   "USA - New York - Malta"                   always_allow "Malta" beats block "USA"
    //
    // Both configs already listed the country under `block`. Plain `block` cannot
    // be promoted wholesale — always_allow was added in #650 precisely so a
    // multi-location posting survives one blocked city ("Stockholm · London ·
    // Madrid" must not die on a London entry) — so the user marks the entries
    // that are country-level and therefore never a false rejection. Opt-in and
    // additive: a config without `block_hard` behaves exactly as before.
    if (blockHard.length > 0 && blockHard.some(matches)) return false;
    // always_allow still wins over block, and may be satisfied by either field:
    // a genuinely US role whose display string says "United States" is never
    // rejected because of what its URL happens to contain.
    if (alwaysAllow.length > 0 && alwaysAllow.some(matches)) return true;
    if (block.length > 0 && block.some(matches)) return false;
    if (allow.length === 0) return true;
    if (allow.some(matches)) return true;
    // Last resort only. Deliberately placed AFTER `block` so a remote title can
    // never rescue a blocked location — "Program Manager - Remote" in Bengaluru
    // stays rejected. This widens `allow`, never `block`.
    return titleSignalsRemote(title);
  };
}

// ── Posting-age filter ──────────────────────────────────────────────
// Optional opt-in. If `max_posting_age_days` is absent (or not a positive
// integer) in portals.yml, every offer passes. An offer is skipped only when
// the provider supplied a postedAt (epoch ms) AND it is older than N days.
// Offers with no date always pass — same "don't penalize missing data"
// convention as the location filter. `now` is injectable for deterministic tests.
export function buildPostingAgeFilter(maxAgeDays, now = Date.now()) {
  const max = Number(maxAgeDays);
  if (!Number.isInteger(max) || max <= 0) return () => true;
  const cutoff = now - max * 24 * 60 * 60 * 1000; // N days in ms, subtracted from now
  return (postedAt) => {
    if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) return true;
    return postedAt >= cutoff;
  };
}

// ── Posted-date lower bound (shared by the filter and the early-stop) ──
// --posted-after states a lower bound absolutely; --since <days> states the
// same thing relatively. They AND together with each other and with
// max_posting_age_days, so the NEWEST bound is what actually decides
// eligibility. Both consumers must agree on it: the downstream filter and the
// provider early-stop hint. Kept as one function so they cannot drift.

/**
 * Parse and validate `--since <days>` from an argv slice.
 *
 * Shared by scan.mjs and scan-ats-full.mjs so ONE flag name cannot mean two
 * different things. scan-ats-full.mjs used `Number(valueOf('--since')) || 3`,
 * which silently swallowed every malformed operand: `--since abc` and
 * `--since 0` both became 3 (the user believes they scanned the window they
 * typed), `--since -5` produced a cutoff in the FUTURE so nothing was ever
 * eligible (indistinguishable from "no new postings"), and `--since 1e400`
 * became Infinity → an -Infinity cutoff, i.e. no window at all (#2498).
 *
 * Returns the day count, or null when the flag is absent — the DEFAULT is the
 * caller's to choose (scan.mjs: no bound; scan-ats-full.mjs: 3 days), only the
 * validation is shared. `error` is a ready-to-print message; callers print and
 * exit rather than this throwing, so both CLIs fail the same way.
 *
 * @param {string[]} args - argv slice.
 * @returns {{days: number|null, error: string|null}}
 */
export function parseSinceDays(args) {
  // Every occurrence is collected, not just the first match of either form:
  // picking one and ignoring the rest means `--since=7 --since` succeeds while
  // an occurrence with no value goes unread.
  const occurrences = args.filter((a) => a === '--since' || a.startsWith('--since='));
  if (occurrences.length > 1) {
    return { days: null, error: `--since given ${occurrences.length} times; pass it once` };
  }
  if (occurrences.length === 0) return { days: null, error: null };
  const occ = occurrences[0];
  const next = args[args.indexOf('--since') + 1];
  const raw = occ.startsWith('--since=')
    ? occ.slice('--since='.length)
    : (next != null && !next.startsWith('--') ? next : null);
  const n = raw == null || raw === '' ? NaN : Number(raw);
  // Number.isFinite also rejects Infinity and 1e309, which pass a bare `> 0`
  // test and would yield an -Infinity cutoff (i.e. silently no window).
  if (!Number.isFinite(n) || n <= 0) {
    return { days: null, error: `--since expects a positive number of days, got ${raw == null || raw === '' ? '(no value)' : `"${raw}"`}` };
  }
  // Finite and positive is not enough: 1e300 days lands outside the ±8.64e15ms
  // range a Date can represent, so the derived cutoff is an Invalid Date and
  // toISOString() throws. Reject it here rather than let it surface as an
  // unhandled "Invalid time value" mid-scan.
  if (Number.isNaN(new Date(Date.now() - n * 86_400_000).getTime())) {
    return { days: null, error: `--since ${raw} is too large to express as a date` };
  }
  return { days: n, error: null };
}

/**
 * Collapse --posted-after and --since into a single absolute lower bound.
 *
 * @param {string|null} postedAfter - YYYY-MM-DD from --posted-after, or null.
 * @param {number|null} sinceDays - Positive day count from --since, or null.
 * @param {number} [now] - Injectable clock for tests.
 * @returns {string|null} YYYY-MM-DD, the newer of the two, or null if neither.
 */
export function resolveEffectiveAfter(postedAfter, sinceDays, now = Date.now()) {
  // Truncating --since to a date rather than an exact timestamp makes it
  // marginally more permissive, which is the safe direction for a bound that
  // also stops pagination.
  // Guarded rather than assumed valid: this is exported and unit-tested, so it
  // must not throw for any input. A day count large enough to push the cutoff
  // outside the representable Date range yields an Invalid Date, and
  // toISOString() would throw RangeError on it.
  const cutoff = Number.isFinite(sinceDays) && sinceDays > 0 ? new Date(now - sinceDays * 86_400_000) : null;
  const sinceIso = cutoff && !Number.isNaN(cutoff.getTime())
    ? cutoff.toISOString().slice(0, 10)
    : null;
  return [postedAfter, sinceIso].filter(Boolean).reduce((a, b) => (a > b ? a : b), null);
}

/**
 * The oldest posting the filters would still accept — the early-stop floor.
 *
 * Stopping pagination any NEWER than this would leave eligible postings
 * unfetched, which is the one thing the optimisation must never do. Returns
 * null when no CLI window is active: max_posting_age_days constrains the floor
 * but must not by itself switch early stopping on for configs that never asked.
 *
 * @param {string|null} effectiveAfter - Output of resolveEffectiveAfter.
 * @param {*} maxAgeDays - config.max_posting_age_days (may be absent/invalid).
 * @param {number} [now] - Injectable clock for tests.
 * @returns {number|null} Epoch ms floor, or null to disable early stopping.
 */
export function resolveEarlyStopMs(effectiveAfter, maxAgeDays, now = Date.now()) {
  if (!effectiveAfter) return null;
  const max = Number(maxAgeDays);
  const ageFloor = Number.isInteger(max) && max > 0 ? now - max * 86_400_000 : -Infinity;
  return Math.max(Date.parse(`${effectiveAfter}T00:00:00Z`), ageFloor);
}

// ── Absolute posted-date filter ─────────────────────────────────────
// CLI-only (--posted-after / --posted-before), unlike the config-driven
// relative max_posting_age_days above. Both bounds optional and inclusive
// (before is treated as end-of-day). A job with no postedAt always passes —
// same "don't penalize missing data" convention as buildPostingAgeFilter.
export function buildPostedDateFilter(afterIso, beforeIso) {
  const afterMs = afterIso ? Date.parse(afterIso) : NaN;
  const beforeMs = beforeIso ? Date.parse(`${beforeIso}T23:59:59.999Z`) : NaN;
  const hasAfter = Number.isFinite(afterMs);
  const hasBefore = Number.isFinite(beforeMs);
  if (!hasAfter && !hasBefore) return () => true;
  return (postedAt) => {
    if (typeof postedAt !== 'number' || !Number.isFinite(postedAt)) return true;
    if (hasAfter && postedAt < afterMs) return false;
    if (hasBefore && postedAt > beforeMs) return false;
    return true;
  };
}

// ── Content filter ──────────────────────────────────────────────────
// Optional. If `content_filter` is absent from portals.yml, all jobs pass.
// Filters on the job DESCRIPTION text to separate same-titled roles with
// different stacks (a "Software Engineer" listing that mentions "PHP" vs one
// that mentions "Rust"). Semantics (case-insensitive substring, in order):
//   - Empty / whitespace-only / non-string description → PASS. The scanner is
//     zero-token and only sees descriptions a provider already returns in its
//     list payload; providers without one must never be silently dropped.
//   - any `negative` keyword present → reject
//   - `positive` empty → pass (already cleared negatives)
//   - `positive` non-empty → at least one keyword must be present
//
// A keyword may opt in to boundary-anchored matching with a `word:` or `stem:`
// prefix (identical to `title_filter` — see title-keywords.mjs). Without a
// prefix an entry is a plain substring, so a bare negative `java` rejects every
// posting mentioning "JavaScript" and `ios` rejects "curiosity"; `word:java` /
// `stem:ios` fix that one entry while leaving the rest of the list untouched
// (#3274). The substring default is deliberate and unchanged: flipping it would
// silently narrow every configured install.
//
// `content_filter.by_title_keyword` (optional): scopes a stricter positive/
// negative pair to only the jobs whose title matched a specific
// `title_filter.positive` keyword, so e.g. an "AI Engineer" title-match can
// require the description to actually mention a concrete AI tool, without
// that requirement leaking onto unrelated categories like "Instructional
// Designer". When one or more of a job's matched title keywords has an
// override, the overrides govern (any override passing is enough); the
// global `positive`/`negative` pair is the fallback for jobs whose matched
// keyword(s) have no override entry.
//
// Provider support: `job.description` is populated only when the provider's
// list API returns the description body without a per-job request (the
// zero-token constraint). Providers that don't supply one leave it empty, and
// those jobs always pass this filter. The set shifts as providers are updated
// — check it with `grep -l 'description:' providers/*.mjs`.

// Normalize a keyword list (lowercase/trim/drop-empties) and compile each
// survivor into a matcher, so a `word:`/`stem:` prefix is honoured and a bare
// keyword keeps its substring behaviour. The `.length` checks downstream still
// read as "did the user configure any keyword here".
function compileContentKeywordList(value) {
  return normalizeKeywordList(value).map(compileContentKeyword);
}

export function buildContentFilter(contentFilter) {
  if (!contentFilter) return () => true;
  const positive = compileContentKeywordList(contentFilter.positive);
  const negative = compileContentKeywordList(contentFilter.negative);

  const byTitleKeyword = new Map();
  if (contentFilter.by_title_keyword && typeof contentFilter.by_title_keyword === 'object' && !Array.isArray(contentFilter.by_title_keyword)) {
    for (const [kw, rule] of Object.entries(contentFilter.by_title_keyword)) {
      if (typeof kw !== 'string' || !kw.trim()) continue;
      byTitleKeyword.set(kw.trim().toLowerCase(), {
        positive: compileContentKeywordList(rule?.positive),
        negative: compileContentKeywordList(rule?.negative),
      });
    }
  }

  return (description, matchedKeywords = []) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();

    const overrides = matchedKeywords
      .filter(k => typeof k === 'string')
      .map(k => byTitleKeyword.get(k.trim().toLowerCase()))
      .filter(Boolean);

    if (overrides.length > 0) {
      return overrides.some(rule => {
        if (rule.negative.length > 0 && rule.negative.some(m => m(lower))) return false;
        if (rule.positive.length === 0) return true;
        return rule.positive.some(m => m(lower));
      });
    }

    if (negative.length > 0 && negative.some(m => m(lower))) return false;
    if (positive.length === 0) return true;
    return positive.some(m => m(lower));
  };
}

// ── Country-eligibility filter (#2093) ──────────────────────────────
// Optional, opt-in. If `country_eligibility_filter` is absent from
// portals.yml, all jobs pass — byte-identical to pre-#2093 behavior.
//
// Problem it solves: `location_filter` only reads the ATS provider's
// STRUCTURED location field (e.g. "Remote"), which many US companies use
// identically regardless of actual country eligibility. The real
// restriction — "US-based candidates only" vs. "US or Canada eligible" —
// often lives only in the JD DESCRIPTION body text, which this filter reads
// (same field `content_filter` already reads — `job.description`).
//
// Semantics (case-insensitive substring), mirroring location_filter's
// "don't penalize missing data" discipline exactly:
//   - Candidate's own `location.country` (config/profile.yml) is "United
//     States" → always pass, unconditionally. An exclusionary "US only"
//     phrase can never legitimately block a US-based candidate, so the
//     filter no-ops entirely rather than special-casing every keyword check.
//   - Empty / whitespace-only / non-string description → pass (no signal).
//   - No `exclusionary` phrase matched → pass (ambiguous stays ambiguous,
//     never guessed — this also means an `inclusive`-only match with no
//     exclusionary wording present is a no-op pass, same as having no
//     signal at all).
//   - `exclusionary` phrase matched AND an `inclusive` phrase is also
//     present → pass (the posting explicitly widens eligibility).
//   - `exclusionary` phrase matched AND the candidate's own country is
//     literally named in the JD text (e.g. a Canadian candidate scanning a
//     posting that separately mentions "Canada" elsewhere) → pass.
//   - `exclusionary` phrase matched, no `inclusive` phrase, and the
//     candidate's own country isn't named → reject.
//
// Config shape (portals.yml):
//   country_eligibility_filter:
//     exclusionary: ["must be located in the united states", ...]
//     inclusive: ["united states or canada", "north america", ...]
//
// Kept as a sibling block to `content_filter` rather than folded into its
// positive/negative shape: this filter cross-references
// `config/profile.yml`'s `location.country` and has its own three-way
// exclusionary/inclusive/candidate-country-named semantics, which doesn't
// fit content_filter's simpler two-list reject/require shape.

export function buildCountryEligibilityFilter(countryEligibilityFilter, candidateCountry) {
  if (!countryEligibilityFilter) return () => true;

  const candidateCountryLower = typeof candidateCountry === 'string'
    ? candidateCountry.toLowerCase().trim()
    : '';

  // A "US-based candidates only" restriction can never legitimately exclude
  // a candidate who is themselves US-based — no-op the whole filter rather
  // than relying on the literal-country-name check below (which would miss
  // phrasing like "US-based candidates only" that never spells out "united
  // states").
  if (candidateCountryLower === 'united states') return () => true;

  const exclusionary = normalizeKeywordList(countryEligibilityFilter.exclusionary);
  const inclusive = normalizeKeywordList(countryEligibilityFilter.inclusive);

  return (description) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();

    if (exclusionary.length === 0) return true;
    if (!exclusionary.some(k => lower.includes(k))) return true;
    if (inclusive.length > 0 && inclusive.some(k => lower.includes(k))) return true;
    if (candidateCountryLower && lower.includes(candidateCountryLower)) return true;

    return false;
  };
}

// ── Visa / work-authorization filter ────────────────────────────────
// Optional. If `visa_filter` is absent (or `enabled: false`), all jobs pass.
// Surfaces roles that sponsor a work visa (H-1B / H-1B1 / O-1 for the US, plus
// the generic "visa sponsorship" wording) and drops roles that explicitly
// refuse sponsorship. Like content_filter it reads the job DESCRIPTION text, so
// it only has signal for providers that populate job.description (see the
// content_filter header above); jobs without one fall back to the
// require_mention rule below.
//
// Semantics (case-insensitive substring):
//   - any `negative` keyword present → reject (an explicit "no sponsorship")
//   - require_mention: false (default) → after clearing negatives, PASS —
//     including jobs with no description. Use this to only weed out the
//     explicit rejections while keeping everything unstated.
//   - require_mention: true → keep only jobs whose description contains at least
//     one `positive` keyword; a missing/empty description is rejected. Use this
//     to surface *only* postings that actively advertise sponsorship.
//
// `positive` / `negative` default to a curated US-sponsorship vocabulary when
// omitted, so `visa_filter: { enabled: true }` works out of the box; supplying
// either list overrides that default.

export const DEFAULT_VISA_POSITIVE = [
  'visa sponsorship',
  'sponsor a visa',
  'sponsor visas',
  'will sponsor',
  'sponsorship available',
  'sponsorship is available',
  'eligible for sponsorship',
  'provide sponsorship',
  'offer sponsorship',
  'immigration support',
  'h-1b',
  'h1b',
  'h-1b1',
  'h1b1',
  'o-1 visa',
];

export const DEFAULT_VISA_NEGATIVE = [
  'no visa sponsorship',
  'no sponsorship',
  'without sponsorship',
  'unable to sponsor',
  'not able to sponsor',
  'cannot sponsor',
  'do not sponsor',
  'does not sponsor',
  'not offer sponsorship',
  'not provide sponsorship',
  'sponsorship is not available',
  'sponsorship not available',
  'not offer visa sponsorship',
];

export function buildVisaFilter(visaFilter) {
  if (!visaFilter || visaFilter.enabled === false) return () => true;
  const positive = visaFilter.positive != null
    ? normalizeKeywordList(visaFilter.positive)
    : DEFAULT_VISA_POSITIVE.slice();
  const negative = visaFilter.negative != null
    ? normalizeKeywordList(visaFilter.negative)
    : DEFAULT_VISA_NEGATIVE.slice();
  const requireMention = visaFilter.require_mention === true;

  return (description) => {
    const hasText = typeof description === 'string' && description.trim() !== '';
    if (!hasText) return !requireMention;
    const lower = description.toLowerCase();
    if (negative.length > 0 && negative.some(k => lower.includes(k))) return false;
    if (!requireMention) return true;
    if (positive.length === 0) return true;
    return positive.some(k => lower.includes(k));
  };
}

// ── Salary filter ───────────────────────────────────────────────────
// Optional. If `salary_filter` is absent from portals.yml, all salaries pass.
// Semantics:
//   - min/max are annual compensation filters (use annualized values)
//   - max: 0 means "no upper limit"
//   - If no salary data exists on a job, it passes (conservative behavior)
//   - If both currencies are known and mismatch (e.g., USD filter, EUR job), it fails
//   - Partial ranges (min only or max only) work correctly via overlap logic
// Uses null-safe checks (!= null, ??) to preserve 0 values correctly.

export function buildSalaryFilter(salaryFilter) {
  if (!salaryFilter) return () => true;

  // Coerce and validate bounds — malformed YAML must not silently mis-filter
  const min = Number(salaryFilter.min ?? 0);
  const max = Number(salaryFilter.max ?? 0);
  const filterCurrency = (salaryFilter.currency || '').trim().toUpperCase();

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    console.error('Warning: salary_filter.min/max must be non-negative numbers — salary filter disabled');
    return () => true;
  }
  if (max > 0 && min > max) {
    console.error('Warning: salary_filter.min cannot exceed salary_filter.max — salary filter disabled');
    return () => true;
  }

  // If both min and max are 0, no filtering applied
  if (min === 0 && max === 0) return () => true;

  return (salary) => {
    // If no salary data exists, pass (conservative - many providers don't expose salary)
    if (!salary) return true;

    const jobMin = salary.min ?? salary.max ?? null;
    const jobMax = salary.max ?? salary.min ?? null;

    // If we have no usable salary values, pass conservatively
    if (jobMin == null && jobMax == null) return true;

    // Currency handling - reject only if BOTH currencies exist and mismatch
    const jobCurrency = (salary.currency || '').trim().toUpperCase();
    if (filterCurrency && jobCurrency && filterCurrency !== jobCurrency) {
      return false;
    }

    // Range overlap logic - reject ONLY if job is completely outside filter range
    // Job entirely below user minimum
    if (min > 0 && jobMax != null && jobMax < min) {
      return false;
    }
    // Job entirely above user maximum
    if (max > 0 && jobMin != null && jobMin > max) {
      return false;
    }

    // Otherwise pass (overlap exists or no valid range to compare)
    return true;
  };
}

export function companyMatch(jobCompany, windowCompany) {
  // Unicode-aware (#2393 family): the [a-z0-9] strip this used to carry erased
  // non-Latin scripts outright, so 株式会社アカネ and 合同会社ゾロ both cleaned
  // to '' and the equality check below reported two unrelated companies as the
  // same one. The empty guard is part of the fix, not decoration — "no usable
  // signal on either side" must never read as "identical".
  const c1NoSpaces = normalizeTextKey(jobCompany);
  const c2NoSpaces = normalizeTextKey(windowCompany);
  if (c1NoSpaces && c1NoSpaces === c2NoSpaces) return true;

  const c1WithSpaces = normalizeTextKey(jobCompany, ' ');
  const c2WithSpaces = normalizeTextKey(windowCompany, ' ');
  if (!c1WithSpaces || !c2WithSpaces) return false;

  // Containment: a short window name should still match a longer official one
  // ("Acme" vs "Acme Corp"), bounded so "Acme" does not match "Acmetric".
  //
  // The anchors are lookarounds, not \b: JS defines \b against ASCII \w even
  // under the u flag. Keeping the accent (rather than stripping it to a space,
  // as the [a-z0-9] filter did before) means '\bnestlé\b' can never hold —
  // neither side of the trailing anchor is a word character — so Nestlé
  // Deutschland vs Nestlé would silently stop matching. Same for Ørsted, Zoë
  // and every other name whose first or last letter is non-ASCII.
  //
  // The anchor class is the one normalizeTextKey keeps, deliberately. An anchor
  // class without \p{M} would treat a Devanagari matra as a boundary and split
  // कंपनी mid-word — the key and its boundaries have to agree on what a letter
  // is, or they drift the way #2397 and #2445 fixed elsewhere.
  //
  // Non-Latin containment does not fire here (株式会社メルカリ vs メルカリ): the
  // lookbehind sees 社, a letter, so there is no boundary to assert, and
  // Japanese is not space-delimited so no anchor rule recovers it. Note this
  // pair DID match before this change, but only via the '' === '' collision
  // that erased both names — not through this path. Making it match on purpose
  // needs corporate-form normalisation, tracked separately in #2570.
  //
  // compileLocationKeyword() above reached for lookarounds too, for a related
  // reason ("\b behaves surprisingly at a punctuation edge"); its escape set is
  // reused here because '\-' is an invalid identity escape under u. Both
  // operands are already normalizeTextKey output — letters, marks, digits and
  // spaces only — so the escape is defensive, not load-bearing.
  const bounded = (name) => new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{M}\\p{N}])`,
    'u',
  );
  return bounded(c2WithSpaces).test(c1WithSpaces) || bounded(c1WithSpaces).test(c2WithSpaces);
}

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Reads config/profile.yml's `location.country` (already a documented
// profile field — see config/profile.example.yml) for the country-
// eligibility filter (#2093). Missing file, missing field, or a malformed
// profile all resolve to '' — buildCountryEligibilityFilter treats an empty
// candidate country the same as "not the candidate's own country's US
// no-op" and simply skips the literal-country-name pass-through, which is
// the same conservative "don't penalize missing data" default used
// throughout this file.
export function loadCandidateCountry(profilePath = PROFILE_PATH) {
  if (!existsSync(profilePath)) return '';
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const country = raw?.location?.country;
    return typeof country === 'string' ? country.trim() : '';
  } catch {
    return '';
  }
}

export function loadReApplyWindows(profilePath = PROFILE_PATH) {
  if (!existsSync(profilePath)) return {};
  try {
    const raw = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
    const windows = raw.re_apply_windows || {};
    const validWindows = {};
    for (const [company, win] of Object.entries(windows)) {
      if (!win || typeof win !== 'object') continue;
      const lastApplyDate = win.last_apply_date;
      if (typeof lastApplyDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(lastApplyDate)) continue;
      if (isNaN(Date.parse(lastApplyDate))) continue;

      const sameRoleDays = win.same_role_days;
      if (sameRoleDays !== undefined && (!Number.isInteger(sameRoleDays) || sameRoleDays < 0)) continue;

      if (win.applied_to !== undefined && !Array.isArray(win.applied_to)) continue;
      if (win.applied_to !== undefined && win.applied_to.some(x => typeof x !== 'string')) continue;

      if (win.cross_role_bucket !== undefined && typeof win.cross_role_bucket !== 'string') continue;

      validWindows[company] = win;
    }
    return validWindows;
  } catch {
    return {};
  }
}

export function buildCooldownFilter(windows, today) {
  if (!windows || Object.keys(windows).length === 0) {
    return () => ({ skip: false });
  }

  const genericKeywords = new Set(['all', 'roles', 'role', 'family', 'bucket', 'group', 'team']);

  return (job) => {
    const jobCompany = job.company || '';
    const jobTitleLower = (job.title || '').toLowerCase();

    for (const [windowCompany, window] of Object.entries(windows)) {
      if (companyMatch(jobCompany, windowCompany)) {
        const lastApplyDate = window.last_apply_date;
        const sameRoleDays = Number(window.same_role_days || 0);
        if (!lastApplyDate) continue;

        const cooldownUntil = addDays(lastApplyDate, sameRoleDays);
        if (today >= cooldownUntil) {
          continue;
        }

        if (Array.isArray(window.applied_to)) {
          const matchesApplied = window.applied_to.some(role => {
            const roleLower = role.toLowerCase();
            return jobTitleLower.includes(roleLower);
          });
          if (matchesApplied) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }

        if (window.cross_role_bucket) {
          const bucketKeywords = window.cross_role_bucket
            .toLowerCase()
            .split('_')
            .filter(kw => kw && !genericKeywords.has(kw));

          const matchesBucket = bucketKeywords.some(kw => {
            if (kw === 'em') {
              return /\bem\b/i.test(jobTitleLower) || jobTitleLower.includes('engineering manager');
            }
            return jobTitleLower.includes(kw);
          });

          if (matchesBucket) {
            return { skip: true, reason: `cooldown:${windowCompany}:${cooldownUntil}`, cooldownUntil };
          }
        }
      }
    }

    return { skip: false };
  };
}


// ── URL rediscovery (--rediscover-404) ──────────────────────────────
// When a tracked company's job URL returns 404/410, the role may have just
// moved to a new URL (Workday/Greenhouse rotate URLs without closing roles).
// These helpers back an opt-in search-and-reverify fallback before giving up.

// extractCareersUrlDomain returns the hostname of a company's careers_url, or
// null when it's missing/unparseable. The presence of a domain is what gates
// the fallback — broad-discovery offers without a careers_url stay ineligible.
export function extractCareersUrlDomain(careersUrl) {
  if (!careersUrl) return null;
  try {
    return new URL(careersUrl).hostname;
  } catch {
    return null;
  }
}

// resolveSearchHref unwraps a DuckDuckGo HTML redirect (`/l/?uddg=<encoded>`)
// to its real destination, so domain matching sees the actual host instead of
// duckduckgo.com. Non-redirect hrefs pass through unchanged.
function resolveSearchHref(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const isDdgHost = u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com');
    if (isDdgHost && u.pathname === '/l/') {
      const target = u.searchParams.get('uddg');
      if (target) return target;
    }
  } catch {
    /* fall through to the raw href */
  }
  return href;
}

// pickRediscoveredUrl chooses the first result whose hostname *exactly* equals
// the careers domain (no substring/look-alike matches), unwrapping search-engine
// redirects first. Pure + exported so result-matching is unit-testable without
// driving a real browser. Returns null when nothing matches.
export function pickRediscoveredUrl(hrefs, domain) {
  if (!domain || !Array.isArray(hrefs)) return null;
  for (const raw of hrefs) {
    const href = resolveSearchHref(raw);
    let host;
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (host === domain) return href;
  }
  return null;
}

// REDISCOVER_TIMEOUT_MS bounds the single fallback search so a slow or blocked
// search engine can't stall the sequential verify loop.
const REDISCOVER_TIMEOUT_MS = 10_000;

// searchForNewUrl runs one site-scoped search for a moved tracked role and
// returns a same-domain URL if found, else null. Every failure path returns
// null — the fallback must never throw into the verify loop. Leaves the page on
// a blank document so the next checkUrlLiveness call starts clean.
async function searchForNewUrl(page, offer) {
  const domain = offer.careersUrlDomain;
  if (!domain) return null;
  const query = `"${offer.title}" "${offer.company}" site:${domain}`;
  try {
    await page.goto(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { waitUntil: 'domcontentloaded', timeout: REDISCOVER_TIMEOUT_MS },
    );
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a.result__a'))
        .map((a) => a.getAttribute('href'))
        .filter(Boolean),
    );
    return pickRediscoveredUrl(hrefs, domain);
  } catch {
    return null;
  } finally {
    try {
      await page.goto('about:blank');
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}

// ── Dedup ───────────────────────────────────────────────────────────

const PERMANENT_SCAN_HISTORY_STATUSES = new Set([
  'skipped_invalid_url',
  'skipped_blocked_host',
]);

function daysBetweenIsoDates(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (startDate.toISOString().slice(0, 10) !== start || endDate.toISOString().slice(0, 10) !== end) return null;
  return Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
}

// `today` defaults to the LOCAL calendar day, not the UTC one. This function
// gates a COOLDOWN (`today < cooldownUntil`) — the user asked not to see a
// posting until a date — and the UTC day is tomorrow for a west-of-Greenwich
// evening run, so the cooldown opened a day early (#3070). The recheck window
// below reads one day high the same way. Callers may still pass `today`
// explicitly; only the default moves.
export function shouldDedupScanHistoryRow({ firstSeen, status = 'added' }, { recheckAfterDays = null, today = localToday() } = {}) {
  if (PERMANENT_SCAN_HISTORY_STATUSES.has(status)) return true;
  if (status.startsWith('cooldown:')) {
    const parts = status.split(':');
    const cooldownUntil = parts[parts.length - 1];
    return today < cooldownUntil;
  }
  if (status !== 'added') return true;
  if (recheckAfterDays == null) return true;
  const ageDays = daysBetweenIsoDates(firstSeen, today);
  if (ageDays == null) return true;
  return ageDays < recheckAfterDays;
}

function scanHistoryPolicy(config = {}) {
  const raw = config.scan_history?.recheck_after_days;
  const parsed = Number.parseInt(raw, 10);
  return {
    recheckAfterDays: Number.isFinite(parsed) && parsed >= 0 ? parsed : null,
  };
}

// Query params that carry no identity information for a job posting — safe to
// strip when computing the dedup key. Deliberately an allowlist rather than
// "strip everything": several ATSes key the posting off a query param (e.g.
// Greenhouse's `gh_jid`), so a blanket strip would collapse distinct roles.
const DEDUP_STRIP_PARAMS = new Set([
  'language', 'lang', 'locale',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'src', 'source', 'gh_src', 'lever-origin', 'lever-source',
  'rltr', // StepStone: regenerated per request, so one posting returns as new every scan
]);

/**
 * Normalize a job posting URL into a stable dedup key.
 *
 * Strips cosmetic query params (locale/tracking), drops a trailing slash,
 * and lowercases scheme, host, and path. Only used to compute the
 * *comparison* key — callers keep writing/displaying the original URL so
 * links stay clickable and scan-history/pipeline.md stay faithful to what
 * the provider returned.
 *
 * The path is lowercased because scan.mjs and scan-ats-full.mjs run as
 * separate processes and can independently produce different casing for the
 * identical posting — a Workday tenant/site path segment reached via the
 * curated portals.yml entry vs. the reverse-ATS dataset, for instance. A
 * case-sensitive key silently treats those as two distinct URLs, so the same
 * role lands in pipeline.md twice. Path casing is not meaningfully distinct
 * for any provider these scanners target.
 *
 * Query *values* keep their original casing — those can be identity-bearing
 * (Greenhouse's `gh_jid`), which is also why DEDUP_STRIP_PARAMS is an
 * allowlist rather than a blanket strip.
 *
 * Falls back to the raw string when the URL is malformed, preserving the
 * old byte-for-byte behavior for unparsable history rows.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrlForDedup(url) {
  if (typeof url !== 'string' || !url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const param of Array.from(parsed.searchParams.keys())) {
    if (DEDUP_STRIP_PARAMS.has(param.toLowerCase())) {
      parsed.searchParams.delete(param);
    }
  }
  promoteKnownFragmentIdentity(parsed);
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  return parsed.toString();
}

/**
 * The leading checkbox marker of a `data/pipeline.md` entry.
 *
 * Only ` ` and `x` are recognized, matching the pre-existing gates: `- [!]`
 * marks a URL that could not be fetched, which is not evidence a posting was
 * surfaced.
 *
 * Anchored, because the URL it guards is then matched anywhere in the entry: a
 * hand-written note that happens to contain checkbox syntax mid-sentence and a
 * link would otherwise seed that link and silently bury a live posting. Leading
 * whitespace is tolerated so an indented entry still dedupes, as it did when the
 * URL had to sit immediately after the checkbox.
 */
const PIPELINE_CHECKBOX_RE = /^\s*- \[[ x]\]\s+/;

/**
 * As `PIPELINE_CHECKBOX_RE`, but rejecting indentation.
 *
 * The company/role gate stays exactly as strict as the `^- \[` anchor it
 * replaces: widening it would seed *more* role keys, and one role key suppresses
 * every other posting that shares it.
 */
const PIPELINE_CHECKBOX_STRICT_RE = /^- \[[ x]\]\s+/;

/**
 * The `~~…~~` wrapper an expired entry is written with.
 *
 * Matched only at the start of the entry body, never searched for line-wide.
 * `~` is a legal URL character and a documented `note:` column may carry its own
 * strikethrough, so treating `~` as a global signal both truncates real URLs and
 * strips live entries of their pair. Expiry is a property of the entry, so it is
 * read at the entry boundary.
 */
const PIPELINE_STRIKETHROUGH_RE = /^~~([\s\S]*?)~~/;

/**
 * A URL inside a pipeline entry.
 *
 * Terminates on whitespace and `|` only. `|` cannot appear unencoded in a URL
 * and is this format's cell separator, so it is the one safe boundary; every
 * other character stays legal. `~` (RFC 3986 unreserved) and `)` (a sub-delim)
 * in particular must not terminate the match — excluding them truncated `~user`
 * paths and parenthesised region suffixes, and a truncated URL both stops
 * deduping and seeds a bare-origin key that everything else on that host then
 * false-matches against.
 *
 * `local:` entries are deliberately not matched — the gates this feeds have
 * always been http(s)-only.
 */
const PIPELINE_URL_RE = /https?:\/\/[^\s|]+/;

/**
 * Split a `data/pipeline.md` checkbox line into its entry body and expiry state.
 *
 * The body is whatever follows the checkbox, unwrapped when the entry is struck
 * out, so every caller parses the same cell sequence either way. An unclosed
 * wrapper still reads as expired: the opening `~~` is the marker.
 *
 * @param {string} line - One raw line of `data/pipeline.md`.
 * @param {RegExp} checkboxRe - Which checkbox anchor this gate accepts.
 * @returns {{body: string, expired: boolean}|null} Null when the line is not an
 *   entry at all.
 */
function pipelineEntry(line, checkboxRe) {
  const checkbox = line.match(checkboxRe);
  if (!checkbox) return null;

  const rest = line.slice(checkbox[0].length);
  if (!rest.startsWith('~~')) return { body: rest, expired: false };

  const closed = rest.match(PIPELINE_STRIKETHROUGH_RE);
  return { body: closed ? closed[1] : rest.slice(2), expired: true };
}

/**
 * Extract the job URL from a `data/pipeline.md` checkbox line, wherever it sits.
 *
 * Six line shapes are documented across the modes, and only the one
 * `appendToPipeline` writes leads with the URL. The others lead with a report
 * number (`#NNN`, `modes/pipeline.md`), a report link
 * (`[NNN](reports/…)`, `reconcile-pipeline.mjs`), a pre-screen marker (`#--`,
 * `modes/pipeline.md`), or a strikethrough (`~~…~~`, `modes/pipeline.md` and
 * `modes/oferta.md`). Anchoring the URL to the checkbox missed all five.
 *
 * An expired entry still seeds a URL key; only its company/role pair is withheld
 * (see `extractPipelineCompanyRole`).
 *
 * @param {string} line - One raw line of `data/pipeline.md`.
 * @returns {string|null} The URL, or null when the line carries none.
 */
function extractPipelineUrl(line) {
  const entry = pipelineEntry(line, PIPELINE_CHECKBOX_RE);
  if (!entry) return null;

  const match = entry.body.match(PIPELINE_URL_RE);
  return match ? match[0] : null;
}

/**
 * Extract the company/role pair from a `data/pipeline.md` checkbox line.
 *
 * Company and role are the two cells *after* the URL cell, not cells 1 and 2 —
 * see `extractPipelineUrl` for why the URL is not always first.
 *
 * Two shapes deliberately yield nothing, mirroring the `status !== 'added'`
 * rule the scan-history branch of `collectSeenCompanyRoles` already applies:
 *
 * - **Expired entries** (`~~…~~`). Strikethrough is how the pipeline records the
 *   same state scan-history records as `skipped_expired`; seeding a dead
 *   posting's role key would let a dead SF URL bury a live NY req. Read at the
 *   entry boundary, so a `note:` column containing its own strikethrough leaves
 *   a live entry's pair intact.
 * - **Pre-screen discards** (`#-- | {url} | skipped (…)`). The cell after the
 *   URL is a discard reason, not a company.
 *
 * @param {string} line - One raw line of `data/pipeline.md`.
 * @returns {{company: string, role: string}|null} The pair, or null when the
 *   line has none to contribute.
 */
function extractPipelineCompanyRole(line) {
  const entry = pipelineEntry(line, PIPELINE_CHECKBOX_STRICT_RE);
  if (!entry || entry.expired) return null;

  const cells = entry.body.split('|').map(cell => cell.trim());
  if (cells[0].startsWith('#--')) return null;

  const urlIndex = cells.findIndex(cell => PIPELINE_URL_RE.test(cell));
  if (urlIndex === -1) return null;

  const [company = '', role = ''] = cells.slice(urlIndex + 1);
  return { company, role };
}

/**
 * Build the seen-URL set from already-read source texts. An absent file is
 * passed as '' (the readIfExists convention shared with
 * `collectSeenCompanyRoles`) — every parse below yields nothing on ''.
 *
 * `extraTokensFor(url, portal)` (optional) lets a caller add provider-scoped
 * dedup tokens alongside the plain normalized-URL one — e.g. a Workday
 * requisition served under several tenant sites (#3439): a historical row
 * recorded under site A's URL wouldn't otherwise match a fresh job fetched
 * from site B, since normalizeUrlForDedup compares URLs verbatim. Only
 * scan-history.tsv rows carry a `portal` column (the pipeline.md/
 * applications.md sources don't record which scanner/provider produced a
 * URL), so the hook only fires there. Return a string, an array of strings,
 * or a falsy value for "nothing extra".
 */
export function collectSeenUrls(sources = {}, policy = {}, { extraTokensFor } = {}) {
  const { scanHistoryText = '', pipelineText = '', applicationsText = '' } = sources;
  const seen = new Set();
  let recheckEligible = 0;

  // scan-history.tsv
  for (const line of scanHistoryText.split('\n').slice(1)) { // skip header
    const [url, firstSeen, portal, , , status = 'added'] = line.split('\t');
    if (!url) continue;
    if (shouldDedupScanHistoryRow({ firstSeen, status }, policy)) {
      seen.add(normalizeUrlForDedup(url));
      if (extraTokensFor) {
        for (const token of [].concat(extraTokensFor(url, portal) || [])) {
          if (token) seen.add(token);
        }
      }
    } else recheckEligible++;
  }

  // pipeline.md — extract URLs from checkbox lines, wherever the URL sits in the
  // line (see extractPipelineUrl: five of the six documented shapes lead with a
  // report number, a report link, or a strikethrough rather than the URL).
  for (const line of pipelineText.split('\n')) {
    const url = extractPipelineUrl(line);
    if (url) seen.add(normalizeUrlForDedup(url));
  }

  // applications.md — extract URLs from report links and any inline URLs
  for (const match of applicationsText.matchAll(/https?:\/\/[^\s|)]+/g)) {
    seen.add(normalizeUrlForDedup(match[0]));
  }

  return { seen, recheckEligible };
}

// Path options mirror mergeIntoPipeline's seam below: the defaults are the
// CAREER_OPS_ROOT-anchored module constants, and a caller with its own lane
// (or a test with a fixture) passes explicit paths. Before CAREER_OPS_ROOT the
// defaults were cwd-relative strings, so callers could retarget them by
// chdir'ing; an anchored default needs a real parameter instead.
export function loadSeenUrls(policy = {}, {
  scanHistoryPath = SCAN_HISTORY_PATH,
  pipelinePath = PIPELINE_PATH,
  applicationsPath = APPLICATIONS_PATH,
  extraTokensFor,
} = {}) {
  return collectSeenUrls({
    scanHistoryText: readIfExists(scanHistoryPath),
    pipelineText: readIfExists(pipelinePath),
    applicationsText: readIfExists(applicationsPath),
  }, policy, { extraTokensFor });
}

/**
 * Normalize a company label when no alias map is configured.
 *
 * This deliberately does only the pre-existing behavior: trim and lowercase the
 * raw company name. `buildCompanyCanonicalizer` wraps this with the optional
 * alias map so installs without `company_aliases` keep byte-for-byte dedupe
 * semantics.
 *
 * @param {unknown} name - Raw company value from a tracker row or provider job.
 * @returns {string} Lowercased, trimmed company key.
 */
function defaultCompanyNormalizer(name) {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Build a company-name canonicalizer from `config.company_aliases`.
 *
 * The map is `{ CanonicalName: [alias, ...] }`; every alias and the canonical
 * name itself resolve to the lowercased canonical name. This closes the gap
 * where an ATS org name, for example Greenhouse "Intercom", differs from the
 * tracker/brand label, for example "Fin". Without it, the company+role dedupe
 * key never matches the tracker and the same role is re-scanned every run.
 *
 * Unknown names pass through as plain lowercased text, so behavior is unchanged
 * for companies with no alias entry.
 *
 * Canonical names always keep their own identity when an alias collides with
 * one. An alias claimed by multiple canonical companies also passes through
 * unchanged so malformed config cannot silently merge unrelated companies.
 *
 * @param {Record<string, unknown>|undefined|null} aliases - Optional canonical
 *   company name to alias list map.
 * @returns {(name: unknown) => string} Canonicalizer for tracker and scan-side
 *   company labels.
 */
export function buildCompanyCanonicalizer(aliases) {
  const map = new Map();
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    const entries = Object.entries(aliases);
    const canonicalKeys = new Set();

    // Canonical names always own their identity, independent of YAML key order.
    for (const [canonical] of entries) {
      const canon = defaultCompanyNormalizer(canonical);
      if (!canon) continue;
      map.set(canon, canon);
      canonicalKeys.add(canon);
    }

    const aliasTargets = new Map();
    for (const [canonical, list] of entries) {
      const canon = defaultCompanyNormalizer(canonical);
      if (!canon) continue;
      const arr = Array.isArray(list) ? list : [list];
      for (const a of arr) {
        const alias = defaultCompanyNormalizer(a);
        if (!alias || canonicalKeys.has(alias)) continue;
        if (!aliasTargets.has(alias)) aliasTargets.set(alias, new Set());
        aliasTargets.get(alias).add(canon);
      }
    }

    // Ambiguous aliases fail open as their raw normalized label. This may allow
    // a duplicate through, but it cannot silently suppress another company.
    for (const [alias, targets] of aliasTargets) {
      if (targets.size === 1) map.set(alias, targets.values().next().value);
    }
  }

  /**
   * Canonicalize one raw company label through the alias map.
   *
   * @param {unknown} name - Raw company value from a tracker row or provider job.
   * @returns {string} Canonical lowercased company key.
   */
  return function canonicalizeCompany(name) {
    const key = defaultCompanyNormalizer(name);
    return map.get(key) ?? key;
  };
}

const ROLE_LOCATION_SUFFIXES = new Set([
  'amer',
  'americas',
  'amsterdam',
  'apac',
  'austin',
  'barcelona',
  'bay area',
  'belgium',
  'berlin',
  'boston',
  'brussels',
  'budapest',
  'canada',
  'chicago',
  'copenhagen',
  'dublin',
  'emea',
  'eu',
  'europe',
  'finland',
  'france',
  'frankfurt',
  'germany',
  'hamburg',
  'helsinki',
  'india',
  'ireland',
  'italy',
  'la',
  'latin america',
  'lisbon',
  'london',
  'los angeles',
  'madrid',
  'melbourne',
  'milan',
  'montreal',
  'munich',
  'netherlands',
  'new york',
  'north america',
  'nyc',
  'on site',
  'onsite',
  'oslo',
  'paris',
  'poland',
  'porto',
  'prague',
  'remote',
  'rome',
  'san francisco',
  'seattle',
  'sf',
  'singapore',
  'spain',
  'stockholm',
  'sydney',
  'tokyo',
  'toronto',
  'uk',
  'united kingdom',
  'united states',
  'us',
  'usa',
  'vancouver',
  'vienna',
  'warsaw',
  'zurich',
]);

/**
 * The location suffixes that are whole markets rather than one office.
 *
 * A city or a country after the title is how one company splits one requisition
 * per office, and collapsing those onto one key is what this normalizer exists
 * for. A region is not that: "Account Executive, EMEA" and "Account Executive,
 * Americas" are two jobs on two continents, and one key for both means the
 * second is dropped as a duplicate and never reaches the queue.
 *
 * So a region is kept in the key, in the bracketed spelling as well as the
 * comma one. That is also what makes the two spellings agree — both keep the
 * region rather than both losing it — which is the Anthropic case seam 7 was
 * written for (ticket B2).
 */
const ROLE_REGION_SUFFIXES = new Set([
  'amer',
  'americas',
  'apac',
  'emea',
  'eu',
  'europe',
  'latin america',
  'north america',
]);

const ROLE_REMOTE_SUFFIXES = new Set([
  'distributed',
  'hybrid',
  'on site',
  'onsite',
  'remote',
  'wfh',
  'work from home',
]);

/**
 * Normalize bracket text before checking whether it is a location suffix.
 *
 * @param {unknown} tag - Text from a trailing parenthetical or bracket suffix.
 * @returns {string} Lowercased, punctuation-normalized suffix text.
 */
function normalizeRoleSuffixTag(tag) {
  return String(tag ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Decide whether a trailing role-title suffix is a location/remote tag.
 *
 * Only known remote/location suffixes are stripped. Seniority, discipline, team,
 * and product qualifiers are intentionally preserved so distinct role variants
 * do not collapse to the same scanner dedupe key.
 *
 * @param {unknown} tag - Text from a trailing parenthetical or bracket suffix.
 * @returns {boolean} True when the suffix is safe to remove for dedupe.
 */
function isRoleLocationSuffix(tag) {
  const normalized = normalizeRoleSuffixTag(tag);
  if (!normalized) return false;
  if (ROLE_LOCATION_SUFFIXES.has(normalized)) return true;

  const raw = String(tag ?? '').toLowerCase();
  const parts = raw
    .split(/[,/|;]+|\s+(?:and|or)\s+/g)
    .map(normalizeRoleSuffixTag)
    .filter(Boolean);
  if (parts.length > 1 && parts.every(part => ROLE_LOCATION_SUFFIXES.has(part))) return true;

  for (const remote of ROLE_REMOTE_SUFFIXES) {
    const prefix = `${remote} `;
    if (normalized.startsWith(prefix) && ROLE_LOCATION_SUFFIXES.has(normalized.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a trailing tag names a whole market, and so must stay in the key.
 *
 * Read the same way `isRoleLocationSuffix` reads a tag — the whole tag, then
 * its comma/slash-separated parts, then the "Remote EMEA" shape — so a mixed
 * tag like "(EMEA, Remote)" counts as a region rather than slipping through as
 * a plain place.
 */
function roleSuffixIsRegion(tag) {
  const normalized = normalizeRoleSuffixTag(tag);
  if (!normalized) return false;
  if (ROLE_REGION_SUFFIXES.has(normalized)) return true;

  const raw = String(tag ?? '').toLowerCase();
  const parts = raw
    .split(/[,/|;]+|\s+(?:and|or)\s+/g)
    .map(normalizeRoleSuffixTag)
    .filter(Boolean);
  if (parts.some(part => ROLE_REGION_SUFFIXES.has(part))) return true;

  for (const remote of ROLE_REMOTE_SUFFIXES) {
    const prefix = `${remote} `;
    if (normalized.startsWith(prefix) && ROLE_REGION_SUFFIXES.has(normalized.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a role title for stable scan-time duplicate identity.
 *
 * Equivalent tracker/provider titles should collapse to one key when a company
 * splits a role per location with a trailing tag like "(Berlin)". Requisition
 * IDs live in URLs rather than titles, so this identity remains URL-agnostic.
 *
 * The normalizer lowercases the title, strips trailing location/remote
 * parenthetical/bracketed tags such as "(Berlin)" and "[Remote]", then
 * collapses punctuation and whitespace so em dash vs hyphen or double spaces do
 * not split a key.
 *
 * This helper does not infer posting churn or detect repost clusters. Those
 * post-tracking facts remain the responsibility of detect-reposts.mjs and the
 * company-history `postingChurn` axis.
 *
 * @param {unknown} role - Raw role title from a tracker row or provider job.
 * @returns {string} Normalized role key.
 */
export function normalizeRoleForDedup(role) {
  // NFKC up front so full-width brackets fold to their ASCII forms while the
  // suffix loop can still see them: "Engineer （Remote）" now strips the same
  // way "Engineer (Remote)" always did.
  //
  // This does NOT make the loop understand non-Latin suffixes — the tag itself
  // is still matched against the English-only ROLE_LOCATION_SUFFIXES set via
  // normalizeRoleSuffixTag(), which carries its own [a-z0-9] strip. So
  // "エンジニア（東京）" and "エンジニア（大阪）" remain two keys. Teaching the
  // suffix vocabulary other scripts is a separate change (new vocabulary, not
  // a key fix) and is deliberately out of scope here.
  let title = String(role ?? '').normalize('NFKC').toLowerCase();
  while (true) {
    // Two spellings of the same tag, and the comma form is the one that cost a
    // duplicate (ticket B2, seam 7). "Applied AI Strategist, EMEA" was cut on
    // 4 September 2026 and came back on 9 September as "Applied AI Strategist
    // (EMEA)" through another board: the bracketed form was stripped, the comma
    // form was not, so the two keys disagreed and the row entered the queue
    // again. Both forms now read the same vocabulary, so a squad or a
    // department after the comma ("Product Owner, Activation Squad") is still
    // kept — only a place is dropped, exactly as the bracketed form has always
    // behaved.
    const match = title.match(/\s*[\[(]([^[\]()]+)[\])]\s*$/)
      || title.match(/\s*,\s*([^,]+?)\s*$/);
    if (!match || !isRoleLocationSuffix(match[1])) break;
    // A region stays in the key. Dropping it merged two continents' worth of
    // one title into one row and lost the second as a duplicate; keeping it is
    // also what makes the bracketed and the comma spelling agree.
    if (roleSuffixIsRegion(match[1])) break;
    // A title that is nothing but the tag ("EMEA") must not key to '' and bury
    // every other role at that company.
    const stripped = title.slice(0, match.index).trimEnd();
    if (!stripped) break;
    title = stripped;
  }
  // Unicode-aware (#2393 family): the [a-z0-9] strip this used to carry keyed
  // every non-Latin title to '', so バックエンドエンジニア and フロントエンド
  // エンジニア at one company shared a dedupe key and the scan dropped the
  // second as already-seen. Space separator keeps the word-collapsing shape.
  return normalizeTextKey(title, ' ');
}

/**
 * Build the canonical company+role dedupe key.
 *
 * This shared helper is used by both the tracker-side load and the scan-side
 * check so those two code paths cannot drift. `canonicalize` defaults to plain
 * lowercase/trim behavior when no alias map is configured.
 *
 * @param {unknown} company - Raw company label.
 * @param {unknown} role - Raw role title.
 * @param {(name: unknown) => string} [canonicalize] - Company canonicalizer.
 * @returns {string} Stable dedupe key in `company::role` form.
 */
export function companyRoleDedupKey(company, role, canonicalize = defaultCompanyNormalizer) {
  return `${canonicalize(company)}::${normalizeRoleForDedup(role)}`;
}

/**
 * Build the seen-role set from the same three sources as `loadSeenUrls`.
 *
 * Existing rows are canonicalized with the same company aliasing and role-title
 * normalization used for freshly scanned jobs. That lets URL-new duplicates match
 * older entries instead of being evaluated again.
 *
 * Seeding from applications.md alone made the key effectively intra-run: a role
 * added by a prior scan lives in scan-history and pipeline, and does not reach
 * applications.md until the user evaluates and applies. Companies that open one req
 * per city therefore leaked one city variant per scan — run 1 added the SF req
 * (marking the key in memory only), run 2 re-seeded from applications.md, found the
 * key absent, and the NY req cleared both the URL check and the role check.
 *
 * Two deliberate semantics on the scan-history source:
 *
 * - Only `added` rows seed a key. `skipped_expired` / `skipped_invalid_url` /
 *   `skipped_blocked_host` are URL-level failures, not evidence the role was
 *   surfaced; seeding from them would let a dead SF URL bury a live NY req. Because
 *   an expired posting is recorded as `skipped_expired` rather than `added`, this
 *   self-heals: when the canonical posting dies, its city variants become eligible
 *   again on the next scan.
 * - Seeding honours `scan_history.recheck_after_days` via the existing
 *   `shouldDedupScanHistoryRow` predicate, so the role key cannot outlive the URL
 *   key it mirrors.
 *
 * @param {{applicationsText?: string, scanHistoryText?: string, pipelineText?: string}} sources
 *   Raw text of each dedupe source; absent sources default to empty.
 * @param {{recheckAfterDays?: number|null, today?: string}} [policy] - Scan-history
 *   recheck policy, shared with `loadSeenUrls`.
 * @param {(name: unknown) => string} [canonicalize=defaultCompanyNormalizer] -
 *   Company canonicalizer shared with scan-side dedupe.
 * @returns {Set<string>} Existing company+role dedupe keys.
 */
export function collectSeenCompanyRoles(sources = {}, policy = {}, canonicalize = defaultCompanyNormalizer) {
  const { applicationsText = '', scanHistoryText = '', pipelineText = '' } = sources;
  const seen = new Set();
  const add = (company, role) => {
    const c = String(company ?? '').trim();
    const r = String(role ?? '').trim();
    if (!c || !r) return;
    // Header and markdown-separator cells are not roles.
    if (c.toLowerCase() === 'company') return;
    if (/^[-:]+$/.test(c) || /^[-:]+$/.test(r)) return;
    seen.add(companyRoleDedupKey(c, r, canonicalize));
  };

  // applications.md — header-aware parse (tracker-parse.mjs, #954). The old
  // positional regex captured the wrong cells on customized layouts (e.g. with a
  // Location column), so the seen-set keyed on garbage and dedup misfired.
  if (applicationsText) {
    const lines = applicationsText.split('\n');
    const colmap = resolveColumns(lines);
    for (const line of lines) {
      const row = parseTrackerRow(line, colmap);
      if (!row) continue;
      add(row.company, row.role);
    }
  }

  // scan-history.tsv — url, first_seen, portal, title, company, status, location
  for (const line of scanHistoryText.split('\n').slice(1)) { // skip header
    const [url, firstSeen, , title, company, status = 'added'] = line.split('\t');
    if (!url) continue;
    if (status !== 'added') continue;
    if (!shouldDedupScanHistoryRow({ firstSeen, status }, policy)) continue;
    add(company, title);
  }

  // pipeline.md — company/title are the two cells after the URL cell, plus
  // optional trailing columns (location, compensation, posted:/trust:/note:
  // segments). The URL is not always first, and expired/pre-screen shapes
  // contribute no pair at all — see extractPipelineCompanyRole. Same failure the
  // applications.md branch above fixed in #954: a positional regex read the
  // wrong cells, so the seen-set keyed on garbage.
  for (const line of pipelineText.split('\n')) {
    const pair = extractPipelineCompanyRole(line);
    if (pair) add(pair.company, pair.role);
  }

  return seen;
}

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
}

/**
 * Load company+role keys already surfaced by a prior scan or tracked by the user.
 *
 * Thin filesystem wrapper over {@link collectSeenCompanyRoles}, mirroring the
 * source list `loadSeenUrls` already reads.
 *
 * The two leading positional parameters are unchanged, so existing callers keep
 * working. The extra sources are injectable via the trailing options object: the
 * module-level paths are relative to `process.cwd()`, so a test that passes only a
 * sandbox tracker would otherwise pick up the developer's real scan-history and
 * pipeline (CI only avoids this because those files are gitignored).
 *
 * @param {string} [appsPath=APPLICATIONS_PATH] - Applications tracker path.
 * @param {(name: unknown) => string} [canonicalize=defaultCompanyNormalizer] -
 *   Company canonicalizer shared with scan-side dedupe.
 * @param {object} [options] - Additional sources and policy.
 * @param {{recheckAfterDays?: number|null, today?: string}} [options.policy] -
 *   Scan-history recheck policy, shared with `loadSeenUrls`.
 * @param {string} [options.scanHistoryPath=SCAN_HISTORY_PATH] - Scan-history path.
 * @param {string} [options.pipelinePath=PIPELINE_PATH] - Pipeline inbox path.
 * @returns {Set<string>} Existing company+role dedupe keys.
 */
export function loadSeenCompanyRoles(
  appsPath = APPLICATIONS_PATH,
  canonicalize = defaultCompanyNormalizer,
  { policy = {}, scanHistoryPath = SCAN_HISTORY_PATH, pipelinePath = PIPELINE_PATH } = {},
) {
  return collectSeenCompanyRoles({
    applicationsText: readIfExists(appsPath),
    scanHistoryText: readIfExists(scanHistoryPath),
    pipelineText: readIfExists(pipelinePath),
  }, policy, canonicalize);
}

// ── Dedup against the tracker (ticket B2, seam 7) ───────────────────
//
// A role already in `data/applications.md` must never be queued again, whether
// it comes back under the same link or under another board's link and a
// slightly different title. Two keys carry it, and both are checked before any
// route or drop:
//
//   1. the posting URL, through `normalizeUrlForDedup`;
//   2. company plus title, through the same canonicalisers
//      `collectSeenCompanyRoles` uses.
//
// The tracker has no URL column and must not grow one. Its URLs are the inline
// ones in the row text — 39 rows carry a trailing `link: <url>` cell — plus the
// `**URL:**` header of each report a row links to. The tracker is read here and
// never written.
//
// The pipeline text is deliberately NOT a source: every pending line would then
// match itself and the whole queue would move to Processed as duplicates.

const REPORT_URL_HEADER_RE = /^\*\*URL:\*\*\s*(\S+)/m;

/** The report files one tracker row links to, resolved against the tracker's own directory. */
function trackerRowReportPaths(row, trackerDir) {
  const cell = String(row.report ?? '');
  const out = [];
  for (const m of cell.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].trim();
    if (!target || /^https?:/i.test(target)) continue;
    out.push(path.resolve(trackerDir, target));
  }
  return out;
}

/**
 * Build the two lookups from the tracker text.
 *
 * Each entry carries the row number back, so a drop can name the row Stelios
 * would open to check it.
 *
 * @param {{applicationsText?: string, trackerPath?: string, canonicalize?: Function}} options
 * @returns {{byUrl: Map<string, object>, byCompanyRole: Map<string, object>}}
 */
export function collectTrackerDedupIndex({
  applicationsText = '',
  trackerPath = APPLICATIONS_PATH,
  canonicalize = defaultCompanyNormalizer,
} = {}) {
  const byUrl = new Map();
  const byCompanyRole = new Map();
  if (!applicationsText) return { byUrl, byCompanyRole };

  const trackerDir = path.dirname(trackerPath);
  const lines = applicationsText.split('\n');
  const colmap = resolveColumns(lines);

  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const company = String(row.company ?? '').trim();
    const role = String(row.role ?? '').trim();
    // Header and markdown-separator cells are not rows, the same guard
    // collectSeenCompanyRoles applies.
    if (!company || !role) continue;
    if (company.toLowerCase() === 'company') continue;
    if (/^[-:]+$/.test(company) || /^[-:]+$/.test(role)) continue;

    const entry = { row: row.num, company, role, status: String(row.status ?? '').trim() };

    const pairKey = companyRoleDedupKey(company, role, canonicalize);
    if (!byCompanyRole.has(pairKey)) byCompanyRole.set(pairKey, entry);

    // Inline URLs in the row text: the `link:` cell, and any other link the
    // notes carry. The report cell's own markdown link is a local path and is
    // read below for the posting URL it records, not treated as one itself.
    for (const m of line.matchAll(/https?:\/\/[^\s|)\]]+/g)) {
      const key = normalizeUrlForDedup(m[0]);
      if (!byUrl.has(key)) byUrl.set(key, entry);
    }

    // The `**URL:**` header of each report the row links to. This is where the
    // posting URL lives for every evaluated row, because the tracker itself
    // records none.
    for (const reportPath of trackerRowReportPaths(row, trackerDir)) {
      if (!existsSync(reportPath)) continue;
      let text = '';
      try {
        text = readFileSync(reportPath, 'utf-8');
      } catch {
        continue;
      }
      const found = text.match(REPORT_URL_HEADER_RE);
      if (!found || !/^https?:/i.test(found[1])) continue;
      const key = normalizeUrlForDedup(found[1]);
      if (!byUrl.has(key)) byUrl.set(key, entry);
    }
  }

  return { byUrl, byCompanyRole };
}

/** Filesystem wrapper, mirroring loadSeenUrls. A missing tracker is no index. */
export function loadTrackerDedupIndex({
  trackerPath = APPLICATIONS_PATH,
  canonicalize = defaultCompanyNormalizer,
} = {}) {
  return collectTrackerDedupIndex({
    applicationsText: readIfExists(trackerPath),
    trackerPath,
    canonicalize,
  });
}

/**
 * The tracker row a queued posting duplicates, or null.
 *
 * The URL is tried first because it is the deterministic key; the pair is what
 * catches a re-listing under a different link, and it is the only key a
 * `local:jds/...` queue line has until ticket B3 stops the apify plugin
 * swapping the URL column.
 *
 * @returns {{row: number, company: string, role: string, key: 'url'|'company-role'}|null}
 */
export function matchTrackerDuplicate({ url, company, title }, index, canonicalize = defaultCompanyNormalizer) {
  if (!index) return null;
  const cleanUrl = typeof url === 'string' ? url.trim() : '';
  if (cleanUrl && /^https?:/i.test(cleanUrl)) {
    const hit = index.byUrl.get(normalizeUrlForDedup(cleanUrl));
    if (hit) return { ...hit, key: 'url' };
  }
  const c = String(company ?? '').trim();
  const r = String(title ?? '').trim();
  if (!c || !r) return null;
  const hit = index.byCompanyRole.get(companyRoleDedupKey(c, r, canonicalize));
  return hit ? { ...hit, key: 'company-role' } : null;
}

/** The reason written onto the line when it moves to Processed. */
export function formatTrackerDuplicateReason(match) {
  if (!match) return '';
  return `skipped (duplicate: tracker row ${match.row}, ${match.company} ${match.role})`;
}

// ── The gate and the route (ticket B2) ──────────────────────────────
//
// B1 filled `job.description` from a stored read. This is the half that decides
// what the filled description costs the row: the three advert filters bite on
// it, a row nobody could read is never dropped on it, and every surviving row
// is labelled with the effort it will get before a single evaluation token is
// spent.

/**
 * The years policy, from the 12 September decision table in
 * `projects/career/General Role Criteria v1.md`.
 *
 * Five or more is out, which is the floor set on 3 September and unchanged.
 * Four is a long shot: the scan keeps it and labels the row, and triage decides
 * — that is where the work-sample question lives. Three or fewer is scored
 * normally.
 *
 * The numbers are here rather than in portals.yml on purpose. A phrase list
 * cannot tell a bar from a wish, which is the whole of finding F01, and the
 * eighty-odd phrases that list carried came out in the same change.
 */
export const YEARS_FLOOR = 5;
export const YEARS_STRETCH = 4;

/**
 * What the advert's years clauses cost this row.
 *
 * A clause binds him only when it is about the reader (`subject !== 'company'`)
 * and the advert does not call it a preference (`mandatory !== false`). An
 * unknown subject and an unstated mandatory both bind: a bare requirements list
 * is the ordinary shape, and reading it as optional would keep everything.
 *
 * @param {string} text - the advert, as stored.
 * @param {(text: string) => Array<object>} [extract] - the reader, injectable
 *   so the rule can be tested without one and so a policy change has one home.
 * @returns {{drop: boolean, sentence?: string, years?: number}} `sentence` on a
 *   drop, `years` when the row is kept as a long shot.
 */
export function judgeExperienceYears(text, extract = extractExperienceClauses) {
  const binding = extract(text).filter(c => c && c.subject !== 'company' && c.mandatory !== false);
  let worst = null;
  for (const clause of binding) {
    if (!Number.isFinite(clause.minimum)) continue;
    if (!worst || clause.minimum > worst.minimum) worst = clause;
  }
  if (!worst) return { drop: false };
  if (worst.minimum >= YEARS_FLOOR) return { drop: true, sentence: worst.sentence };
  if (worst.minimum >= YEARS_STRETCH) return { drop: false, years: worst.minimum };
  return { drop: false };
}

// The words the location rule reads (ticket C, C4). Country words, not towns.
const UK_PLACE_RE = /^(?:united kingdom|uk|u\.k\.|gb|gbr|great britain|britain|england|scotland|wales|northern ireland)$/i;
const NOT_A_TOWN_RE = /\b(?:remote|hybrid|home|anywhere|on-?site|office)\b/i;
const ATTENDANCE_RE = /\bremote(?:ly)?\b|\bwork(?:ing)? from home\b|\bhybrid from anywhere\b|\blondon\b/i;

// What "London" means: the 32 London boroughs, plus the City, which the
// /london/ test above already reads. This defines London and is not a list of
// commutable towns: a listing that writes "Harrow, England, United Kingdom" is
// a London listing, and a town outside these is still read from the advert.
const LONDON_BOROUGHS = new Set([
  'barking and dagenham', 'barnet', 'bexley', 'brent', 'bromley', 'camden',
  'croydon', 'ealing', 'enfield', 'greenwich', 'hackney', 'hammersmith and fulham',
  'haringey', 'harrow', 'havering', 'hillingdon', 'hounslow', 'islington',
  'kensington and chelsea', 'kingston upon thames', 'lambeth', 'lewisham',
  'merton', 'newham', 'redbridge', 'richmond upon thames', 'southwark', 'sutton',
  'tower hamlets', 'waltham forest', 'wandsworth', 'westminster',
]);

function isLondonBorough(place) {
  return LONDON_BOROUGHS.has(String(place).toLowerCase().replace(/\s*&\s*/g, ' and ').replace(/\s+/g, ' ').trim());
}

/**
 * Where the listing says the job is, read against what the advert says about
 * attendance (ticket C, C4).
 *
 * A location that ends in "United Kingdom" says nothing about whether Stelios
 * can do the job from London. The rule fires on one shape only: a place
 * followed by nothing but UK words ("Amersham, England, United Kingdom",
 * "Manchester, GB"), or by one county and then UK words ("Reading, Berkshire,
 * United Kingdom"), with no London in it. That place is the town, read from
 * the listing itself, so there is no town list. Such a row stays only when the
 * listing or the advert says remote, work from home or hybrid from anywhere,
 * or names London, and is then labelled `remote-uk`; otherwise it is dropped
 * with the town named, which is the brief's "Outside London" hard fail.
 *
 * A London listing, a London borough ("Harrow, England, United Kingdom"), a
 * country on its own, a list of countries and a town with no country word are
 * all left alone: none of them names a UK town outside London.
 *
 * @param {string} location - the listing's location cell.
 * @param {string} text - the advert, as stored.
 * @returns {{drop: boolean, town?: string, label?: string}}
 */
export function judgeAttendance(location, text) {
  const listed = typeof location === 'string' ? location.trim() : '';
  if (!listed || /\blondon\b/i.test(listed)) return { drop: false };
  const parts = listed.replace(/\([^)]*\)/g, ' ').split(/[,;·|]/).map(part => part.trim()).filter(Boolean);
  const town = parts[0] || '';
  // After the town: UK words only, or one county and then UK words
  // ("Reading, Berkshire, United Kingdom").
  const rest = parts.slice(1);
  const ukFrom = (i) => rest.length > i && rest.slice(i).every(part => UK_PLACE_RE.test(part));
  const county = rest[0] || '';
  const inTheUk = ukFrom(0) || (ukFrom(1) && !NOT_A_TOWN_RE.test(county));
  if (!inTheUk || UK_PLACE_RE.test(town) || NOT_A_TOWN_RE.test(town)) return { drop: false };
  if (isLondonBorough(town)) return { drop: false };
  if (ATTENDANCE_RE.test(`${listed}\n${String(text ?? '')}`)) return { drop: false, label: 'remote-uk' };
  return { drop: true, town };
}

/**
 * Why a row was dropped, in the words of the filter that dropped it.
 *
 * The filters themselves return a bare boolean, and rebuilding their decision
 * here would be a second copy of the rule. So this re-runs only the *matching*
 * half against the same configuration and names the first phrase that hit.
 * Called on the drop path alone, so a clean run does no extra work.
 */
export function buildDropExplainer(config = {}, candidateCountry = '') {
  const cf = config.content_filter || null;
  const byTitleKeyword = new Map();
  if (cf?.by_title_keyword && typeof cf.by_title_keyword === 'object' && !Array.isArray(cf.by_title_keyword)) {
    for (const [kw, rule] of Object.entries(cf.by_title_keyword)) {
      if (typeof kw !== 'string' || !kw.trim()) continue;
      byTitleKeyword.set(kw.trim().toLowerCase(), rule);
    }
  }

  const named = (list) => normalizeKeywordList(list).map(k => ({ keyword: k, match: compileContentKeyword(k) }));
  const globalNegative = cf ? named(cf.negative) : [];
  const globalPositive = cf ? named(cf.positive) : [];

  const eligibility = config.country_eligibility_filter || null;
  const exclusionary = eligibility ? normalizeKeywordList(eligibility.exclusionary) : [];

  const vf = config.visa_filter || null;
  const visaNegative = vf
    ? normalizeKeywordList(vf.negative != null ? vf.negative : DEFAULT_VISA_NEGATIVE)
    : [];

  function firstHit(entries, lower) {
    for (const entry of entries) if (entry.match(lower)) return entry.keyword;
    return '';
  }

  return function explain(reason, description, matchedKeywords = []) {
    const lower = String(description ?? '').toLowerCase();
    if (!lower.trim()) return '';

    if (reason === 'content') {
      const overrides = matchedKeywords
        .filter(k => typeof k === 'string')
        .map(k => byTitleKeyword.get(k.trim().toLowerCase()))
        .filter(Boolean);
      if (overrides.length > 0) {
        for (const rule of overrides) {
          const hit = firstHit(named(rule?.negative), lower);
          if (hit) return hit;
        }
        return 'no required keyword';
      }
      const hit = firstHit(globalNegative, lower);
      if (hit) return hit;
      return globalPositive.length > 0 ? 'no required keyword' : '';
    }

    if (reason === 'countryEligibility') {
      const country = String(candidateCountry ?? '').toLowerCase().trim();
      for (const phrase of exclusionary) {
        if (lower.includes(phrase)) return phrase;
      }
      return country ? `not open to ${candidateCountry}` : 'not open to this country';
    }

    if (reason === 'visa') {
      for (const phrase of visaNegative) {
        if (lower.includes(phrase)) return phrase;
      }
      return 'no sponsorship mentioned';
    }

    return '';
  };
}

/** The drop reasons the gate can return, in the order it tries them. */
export const ADVERT_DROP_REASONS = ['content', 'years', 'countryEligibility', 'visa', 'location'];

export const ADVERT_DROP_LABELS = {
  content: 'content',
  years: 'years',
  countryEligibility: 'eligibility',
  visa: 'visa',
  location: 'location',
};

/**
 * The one rule the sweep and the standalone pass share, so the two can never
 * drift on what a stored advert costs a row.
 *
 * A row whose read status is anything but `read` is kept, whatever the three
 * filters would say about the empty string it carries: nothing is dropped on an
 * advert nobody read. A row that arrived with the board's own description has
 * no read status at all and is filtered exactly as it always was.
 *
 * @returns {{drop: boolean, reason?: string, phrase?: string, unread?: boolean}}
 */
export function buildAdvertGate({ contentFilter, countryEligibilityFilter, visaFilter, explain, experienceClauses }) {
  const pass = () => true;
  const content = contentFilter || pass;
  const eligibility = countryEligibilityFilter || pass;
  const visa = visaFilter || pass;
  const why = explain || (() => '');
  const clauses = experienceClauses || extractExperienceClauses;

  return function gate({ description = '', matchedKeywords = [], readStatus = null, location = '' } = {}) {
    if (readStatus != null && readStatus !== 'read') return { drop: false, unread: true };
    if (!content(description, matchedKeywords)) {
      return { drop: true, reason: 'content', phrase: why('content', description, matchedKeywords) };
    }
    // The years rule (ticket C, C1). Its own reason, so the DROP line quotes
    // the sentence rather than naming a phrase from a list that no longer
    // carries one. A kept row with a four-year bar comes back labelled.
    const years = judgeExperienceYears(description, clauses);
    if (years.drop) {
      return { drop: true, reason: 'years', phrase: years.sentence };
    }
    if (!eligibility(description)) {
      return { drop: true, reason: 'countryEligibility', phrase: why('countryEligibility', description) };
    }
    if (!visa(description)) {
      return { drop: true, reason: 'visa', phrase: why('visa', description) };
    }
    // The location rule (ticket C, C4), after the read and last, so a row
    // another rule drops is named for that rule. The town is the phrase.
    const attendance = judgeAttendance(location, description);
    if (attendance.drop) {
      return { drop: true, reason: 'location', phrase: attendance.town };
    }
    const kept = { drop: false };
    if (years.years) kept.years = years.years;
    if (attendance.label) kept.location = attendance.label;
    return kept;
  };
}

/**
 * One line per row the advert dropped, so a wrong drop can be rescued in one
 * click and a missed one earns a line in the filter.
 *
 * The stored advert is named where there is one. A row whose board handed over
 * its own description has no stored file, so the line names the posting URL
 * instead: it must always point at something Stelios can open.
 */
export function formatAdvertDropRow(row) {
  const label = ADVERT_DROP_LABELS[row.reason] || row.reason || 'advert';
  const phrase = row.phrase ? `: "${row.phrase}"` : '';
  const where = row.jdPath ? `jd: local:${row.jdPath}` : (row.url || '');
  return `DROP | ${row.company || '?'} | ${row.title || '?'} | ${label}${phrase}${where ? ` | ${where}` : ''}`;
}

/** An empty route tally, one counter per bucket. */
export function emptyRouteTally() {
  const tally = { score: 0, standard: 0, review: 0, buckets: {} };
  for (const bucket of [...ROUTE_BUCKETS.score, ...ROUTE_BUCKETS.standard, ...ROUTE_BUCKETS.review]) tally.buckets[bucket] = 0;
  return tally;
}

export function countRoute(tally, detail) {
  if (!tally || !detail) return;
  if (detail.route === 'score') tally.score++;
  else if (detail.route === 'review') tally.review = (tally.review || 0) + 1;
  else tally.standard++;
  tally.buckets[detail.bucket] = (tally.buckets[detail.bucket] || 0) + 1;
}

/** An empty drop tally, one counter per reason. */
export function emptyAdvertDropTally() {
  const tally = { total: 0, byReason: {}, rows: [] };
  for (const reason of ADVERT_DROP_REASONS) tally.byReason[reason] = 0;
  return tally;
}

export function countAdvertDrop(tally, row) {
  if (!tally || !row) return;
  tally.total++;
  tally.byReason[row.reason] = (tally.byReason[row.reason] || 0) + 1;
  tally.rows.push(row);
}

/**
 * The two lines B2 adds under B1's three. The shape is the decision Stelios
 * reads, so it is given exactly rather than derived.
 */
export function formatGateSummary(dropTally, routeTally) {
  const lines = [];

  if (dropTally && dropTally.total > 0) {
    const breakdown = ADVERT_DROP_REASONS
      .filter(r => dropTally.byReason[r] > 0)
      .map(r => `${ADVERT_DROP_LABELS[r]} ${dropTally.byReason[r]}`)
      .join(', ');
    lines.push(
      `Dropped on advert:     ${dropTally.total}${breakdown ? `         (${breakdown})` : ''}`
      + '               each named below',
    );
  }

  if (routeTally && (routeTally.score > 0 || routeTally.standard > 0)) {
    const part = (route) => {
      const detail = ROUTE_BUCKETS[route]
        .filter(b => routeTally.buckets[b] > 0)
        .map(b => `${ROUTE_BUCKET_LABELS[b]}: ${routeTally.buckets[b]}`)
        .join(', ');
      return `${route} ${routeTally[route]}${detail ? `   (${detail})` : ''}`;
    };
    lines.push(`Routes:                ${part('score')}   ${part('standard')}`);
  }

  // Its own line (ticket C, C2): an unread advert is neither route, and a
  // count folded into `standard` is the silent pass the route exists to stop.
  if (routeTally && routeTally.review > 0) {
    const them = routeTally.review === 1 ? 'it' : 'them';
    // A row the fit gate (ticket D2b) held for review is not unread, so the
    // line names both counts once the gate has held any; without it the line
    // stays exactly as C2 wrote it.
    const fitHeld = routeTally.buckets?.fit || 0;
    lines.push(fitHeld > 0
      ? `Review:                ${routeTally.review}   (unread: ${routeTally.review - fitHeld}, fit: ${fitHeld}) a person reads ${them} before anything is sent`
      : `Review:                ${routeTally.review}   unread, a person reads ${them} before anything is sent`);
  }

  return lines;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function normalizeScanScalar(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function normalizeScanUrl(value) {
  return String(value ?? '').trim().split(/\s+/)[0] || '';
}

const MARKDOWN_ESCAPE_CHARS = {
  '\\': '\\\\',
  '[': '\\[',
  ']': '\\]',
};

export function sanitizeMarkdownField(value) {
  return normalizeScanScalar(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '/');
}

function sanitizePipelineUrl(value) {
  return normalizeScanUrl(value)
    .replace(/[\\[\]]/g, char => MARKDOWN_ESCAPE_CHARS[char])
    .replace(/\|/g, '%7C');
}

export function sanitizeTsvField(value) {
  const normalized = normalizeScanScalar(value);
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
}

// Format an offer's parsed compensation (the annualized {min,max,currency} that
// providers like Ashby attach as `offer.salary`) into a compact, sanitized cell
// such as `120000-160000 USD`. Returns '' when there is no usable salary data.
// Non-positive bounds are dropped (a 0 min/max is meaningless comp data, not "$0").
export function formatCompensation(salary) {
  if (!salary || typeof salary !== 'object') return '';
  const num = (n) => (Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null);
  const lo = num(salary.min);
  const hi = num(salary.max);
  const range = lo && hi && lo !== hi ? `${lo}-${hi}` : (lo || hi || '');
  if (!range) return '';
  const currency = typeof salary.currency === 'string' ? salary.currency.trim() : '';
  return sanitizeMarkdownField(currency ? `${range} ${currency}` : range);
}

// Trust/legitimacy signal (#1743): the scanner sets offer.trustScore (0-100) +
// offer.trustFlags on every job (see buildTrustValidator). Surface it only when
// it's meaningful — a score below 100 means the validator penalized the posting
// (e.g. missing_apply_url, invalid_url, suspicious_domain). A clean posting
// (score 100) or a scan without trust_filter configured stays byte-identical
// (empty), exactly like the posted:/note: segments.
export function trustIsFlagged(offer) {
  return typeof offer.trustScore === 'number' && Number.isFinite(offer.trustScore) && offer.trustScore < 100;
}

function trustFlagList(offer) {
  return Array.isArray(offer.trustFlags)
    ? offer.trustFlags.filter((f) => typeof f === 'string' && f.trim())
    : [];
}

// Labeled pipeline segment, e.g. `trust: 60 missing_apply_url,suspicious_domain`.
// '' when the posting isn't flagged, so an unflagged offer produces no segment.
export function formatTrustSegment(offer) {
  if (!trustIsFlagged(offer)) return '';
  const flags = trustFlagList(offer);
  const body = flags.length ? `${offer.trustScore} ${flags.join(',')}` : String(offer.trustScore);
  return sanitizeMarkdownField(`trust: ${body}`);
}

export function formatPipelineOffer(offer) {
  const url = sanitizePipelineUrl(offer.url);
  const company = sanitizeMarkdownField(offer.company);
  const title = sanitizeMarkdownField(offer.title);
  // Optional trailing columns, each sanitized like every other field:
  //   4th = location, 5th = compensation.
  // Gate location on an actual string so malformed provider data (a number or
  // object) degrades to the 3-column form instead of stringifying into a
  // spurious column. The columns are positional, so a present compensation
  // forces the (possibly empty) location cell to keep comp in column 5.
  // loadSeenUrls dedups on the URL and ignores trailing columns (backward-compatible).
  const location = typeof offer.location === 'string' ? sanitizeMarkdownField(offer.location) : '';
  const compensation = formatCompensation(offer.salary);
  const base = `- [ ] ${url} | ${company} | ${title}`;
  let line = base;
  if (compensation) line = `${base} | ${location} | ${compensation}`;
  else if (location) line = `${base} | ${location}`;
  // Optional labeled posting-date segment (like note:) — keeps the positional
  // 1/3/4/5-column contract in modes/pipeline.md intact.
  const posted = postedAtIsoDate(offer.postedAt);
  if (posted) line = `${line} | posted: ${posted}`;
  // Labeled trust/legitimacy segment (#1743) — rides like posted:/note:, emitted
  // only when the scanner flagged the posting (score < 100). Ordered after
  // posted:, before note:, for a stable serialization.
  const trust = formatTrustSegment(offer);
  if (trust) line = `${line} | ${trust}`;
  // Labeled stored-advert segment (ticket B1) — the URL column stays the
  // posting URL, because dedup (loadSeenUrls) and the liveness gates match
  // `https?://` only, and the apify plugin's habit of swapping that column for
  // a local path is exactly what breaks them. The store reference rides here
  // instead, like posted: and trust:, and modes/_custom.md teaches pipeline and
  // triage to read it. An offer with no stored advert produces no segment.
  const jd = typeof offer.jdPath === 'string' ? offer.jdPath.trim() : '';
  if (jd) line = `${line} | jd: ${sanitizeMarkdownField(`local:${jd}`)}`;
  // Labeled long-shot segment (ticket C, C1) — a years bar of four is kept and
  // said out loud, so triage can see the stretch without re-reading the advert.
  // Ordered after jd: and before route:, so the serialization is stable however
  // the row reached the queue. A row below the stretch produces no segment.
  const years = yearsSegmentValue(offer.years);
  if (years != null) line = `${line} | years: ${years}`;
  // Labeled attendance segment (ticket C, C4) — a UK town outside London kept
  // because the advert says remote or names London. After years:, before route:.
  const locationLabel = locationSegmentValue(offer.locationLabel);
  if (locationLabel) line = `${line} | location: ${locationLabel}`;
  // Labeled route segment (ticket B2) — which effort this row gets, decided
  // before any evaluation token is spent. Ordered after jd:, before note:, for
  // a stable serialization. An offer with no route produces no segment, so a
  // caller that never routes writes byte-identical lines.
  const route = typeof offer.route === 'string' ? offer.route.trim() : '';
  if (route) line = `${line} | route: ${sanitizeMarkdownField(route)}`;
  // Labeled fit segment (ticket D2b) — the model's verdict, `PASS`,
  // `SKIP (<reason>)` or `REVIEW (<reason>)`. After route:, before note:. An
  // offer the gate never judged produces no segment.
  const fit = typeof offer.fit === 'string' ? offer.fit.trim() : '';
  if (fit) line = `${line} | fit: ${sanitizeMarkdownField(fit)}`;
  // Optional free-text ranking signal (e.g. a curated-list flag an importer
  // attaches). Labeled — not positional like location/compensation — so it can
  // ride on any row shape (bare URL, 3-, 4-, or 5-column) without a reader
  // confusing it for a positional cell, and it stays generic: nothing here is
  // source-specific, and an offer without `note` produces byte-identical output.
  const note = typeof offer.note === 'string' ? sanitizeMarkdownField(offer.note) : '';
  return note ? `${line} | note: ${note}` : line;
}

// The stored-advert segment on an existing queue line, e.g.
// `| jd: local:jds/acme-analyst-0123456789.md`. Read and written by the
// standalone pass, which rewrites lines the scan wrote on an earlier day.
const JD_SEGMENT_RE = /\|\s*jd:\s*local:(\S+)/;

/** The stored advert a queue line points at, or null. */
export function extractJdSegment(line) {
  const m = String(line).match(JD_SEGMENT_RE);
  return m ? m[1] : null;
}

/**
 * Add the segment to a queue line, before `note:` when there is one so the
 * serialization matches what formatPipelineOffer writes. A line that already
 * carries one is returned unchanged: the store is the record, and re-reading a
 * posting the run already read is exactly what the idempotent store prevents.
 *
 * `replace: true` is the one exception, and the recheck is its one caller: a
 * segment naming an unread stub is repointed at the apify plugin's file, which
 * is the advert the gate reads (B3 into the fork).
 */
export function insertJdSegment(line, relPath, { replace = false } = {}) {
  if (!relPath) return line;
  const segment = `| jd: ${sanitizeMarkdownField(`local:${relPath}`)}`;
  if (extractJdSegment(line)) {
    return replace ? String(line).replace(JD_SEGMENT_RE, () => segment) : line;
  }
  const noteAt = line.indexOf('| note:');
  if (noteAt === -1) return `${line.replace(/\s+$/, '')} ${segment}`;
  return `${line.slice(0, noteAt)}${segment} ${line.slice(noteAt)}`;
}


// The long-shot segment on an existing queue line, e.g. `| years: 4`.
const YEARS_SEGMENT_RE = /\|\s*years:\s*(\d{1,2})\b/i;

/** A whole number of years, or null for anything that is not one. */
function yearsSegmentValue(value) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 && n < 100 ? n : null;
}

/**
 * Read and write one labelled segment, `| <name>: <value>`, on a queue line.
 * `years:` and `location:` share it.
 *
 * Like `insertRouteSegment` the writer overwrites, and for the same reason: the
 * rule that wrote a label can change, and a re-run must be able to correct a
 * label it wrote last week. A null removes it. A new segment goes in before
 * `route:` and `note:`.
 *
 * @param {string} name - the label, e.g. `years`.
 * @param {RegExp} pattern - matches the segment, the value in group 1.
 * @param {(value: unknown) => (string|number|null)} normalise - the value to
 *   write, or null for anything the label does not accept.
 */
function labelledSegment(name, pattern, normalise) {
  const extract = (line) => {
    const m = String(line).match(pattern);
    return m ? normalise(m[1]) : null;
  };
  const insert = (line, raw) => {
    const value = normalise(raw);
    const text = String(line);
    if (pattern.test(text)) {
      if (value == null) return text.replace(pattern, '').replace(/\s{2,}/g, ' ').replace(/\s+$/, '');
      return text.replace(pattern, `| ${name}: ${value}`);
    }
    if (value == null) return text;
    const segment = `| ${name}: ${value}`;
    for (const before of ['| route:', '| note:']) {
      const at = text.indexOf(before);
      if (at !== -1) return `${text.slice(0, at)}${segment} ${text.slice(at)}`;
    }
    return `${text.replace(/\s+$/, '')} ${segment}`;
  };
  return { extract, insert };
}

const yearsSegment = labelledSegment('years', YEARS_SEGMENT_RE, yearsSegmentValue);

/** The long-shot years a queue line already carries, or null. */
export function extractYearsSegment(line) {
  return yearsSegment.extract(line);
}

/**
 * Add, replace or remove the segment on a queue line. A null removes it, so a
 * row the reader has since read properly stops claiming a bar the advert does
 * not carry.
 */
export function insertYearsSegment(line, years) {
  return yearsSegment.insert(line, years);
}

// The attendance segment on an existing queue line, `| location: remote-uk`.
// Labelled, unlike the positional location cell, which it never replaces.
const LOCATION_SEGMENT_RE = /\|\s*location:\s*(remote-uk)\b/i;

/** The one label the location rule writes, or null for anything else. */
function locationSegmentValue(value) {
  return String(value ?? '').trim().toLowerCase() === 'remote-uk' ? 'remote-uk' : null;
}

const locationSegment = labelledSegment('location', LOCATION_SEGMENT_RE, locationSegmentValue);

/** The attendance label a queue line already carries, or null. */
export function extractLocationSegment(line) {
  return locationSegment.extract(line);
}

/**
 * Add, replace or remove the segment. A re-run under a changed advert or
 * listing must be able to take a label back.
 */
export function insertLocationSegment(line, label) {
  return locationSegment.insert(line, label);
}

// The route segment on an existing queue line, e.g. `| route: score`. Read and
// written by the standalone pass, which labels lines the scan wrote on an
// earlier day. `review` is an unread advert's route (ticket C, C2); a value
// this pattern does not know is never recognised as routed, so every recheck
// would append a second segment beside it.
const ROUTE_SEGMENT_RE = /\|\s*route:\s*(score|standard|review)\b/i;

/** The route a queue line already carries, or null. */
export function extractRouteSegment(line) {
  const m = String(line).match(ROUTE_SEGMENT_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Add or replace the segment on a queue line, after `jd:` and before `note:`
 * so the serialization matches what formatPipelineOffer writes.
 *
 * Unlike `insertJdSegment` this one overwrites: the tier table is the Tiers
 * chat's file and changes under us, so a re-run must be able to correct a route
 * it labelled last week. The stored advert is the opposite case — re-reading a
 * posting the run already read is exactly what the idempotent store prevents.
 */
export function insertRouteSegment(line, route) {
  if (!route) return line;
  const segment = `| route: ${sanitizeMarkdownField(route)}`;
  if (extractRouteSegment(line)) {
    return String(line).replace(ROUTE_SEGMENT_RE, segment);
  }
  const noteAt = line.indexOf('| note:');
  if (noteAt === -1) return `${line.replace(/\s+$/, '')} ${segment}`;
  return `${line.slice(0, noteAt)}${segment} ${line.slice(noteAt)}`;
}

// The fit segment on an existing queue line (ticket D2b), e.g.
// `| fit: SKIP (the seat runs outsourced contact centres)`. Read, never
// written, by the standalone pass: a line the gate held for review keeps
// `route: review` when the pass re-routes it.
const FIT_SEGMENT_RE = /\|\s*fit:\s*(PASS|SKIP|REVIEW)\b/i;

/** The fit verdict a queue line carries, `PASS`, `SKIP` or `REVIEW`, or null. */
export function extractFitSegment(line) {
  const m = String(line).match(FIT_SEGMENT_RE);
  return m ? m[1].toUpperCase() : null;
}

/**
 * The hold rule, shared by the sweep and the standalone pass: a row whose fit
 * verdict is SKIP or REVIEW is routed `review`, counted under the `fit` bucket.
 * A PASS, no verdict, or a row already routed `review` keeps its routing.
 */
export function holdRouteForFit(routing, verdict) {
  if (!verdict || verdict === 'PASS' || routing.route === 'review') return routing;
  return { ...routing, route: 'review', bucket: 'fit' };
}

/**
 * Company and title from a queue line, for the tracker dedup and the route.
 *
 * `extractPipelineCompanyRole` is the scan's own dedup reader and deliberately
 * yields nothing for a struck-out or pre-screened line. This one is the gate's,
 * and it has one job that reader does not: a line whose URL cell was replaced
 * with `local:jds/...` by the apify plugin still carries a company and a title,
 * and until ticket B3 stops that swap the pair is the only key such a line has.
 */
export function pipelineLineIdentity(line) {
  const entry = pipelineEntry(line, PIPELINE_CHECKBOX_RE);
  if (!entry) return null;
  const cells = entry.body.split('|').map(cell => cell.trim());
  if (cells[0].startsWith('#--')) return null;
  let urlIndex = cells.findIndex(cell => PIPELINE_URL_RE.test(cell));
  let url = '';
  let localPath = '';
  if (urlIndex !== -1) {
    url = cells[urlIndex].match(PIPELINE_URL_RE)[0];
  } else {
    // The apify plugin's shape: `- [ ] local:jds/<file> | Company | Title | …`.
    // The stored advert is in the URL cell rather than a `jd:` segment, so it is
    // returned here and the gate reads it from there. Ticket B3 stops the swap;
    // until then this is the only advert such a line points at.
    urlIndex = cells.findIndex(cell => /^local:/i.test(cell));
    if (urlIndex === -1) return null;
    localPath = cells[urlIndex].slice('local:'.length).trim();
  }
  const [company = '', title = '', locationCell = ''] = cells.slice(urlIndex + 1);
  // The positional location cell, for the location rule. A labelled segment in
  // that position (`jd:`, `route:` and the rest) is not a location.
  const location = /^[a-z][a-z_-]*:/i.test(locationCell) ? '' : locationCell;
  // The note cell, not the whole line. The route marker is looked for in a note
  // somebody wrote; searching the line would find it in the company cell, the
  // title, the URL and the jd: filename as well, which is a route decided by a
  // coincidence of spelling.
  const noteCell = cells.find(cell => /^note:/i.test(cell)) || '';
  const note = noteCell ? noteCell.slice(noteCell.indexOf(':') + 1).trim() : '';
  return { url, company, title, localPath, note, location };
}

// postedAt arrives as epoch ms (or absent). Convert to 'YYYY-MM-DD', or '' when missing.
function postedAtIsoDate(postedAt) {
  if (typeof postedAt !== 'number' || !Number.isFinite(postedAt) || postedAt <= 0) return '';
  return new Date(postedAt).toISOString().slice(0, 10);
}
export function formatScanHistoryRow(offer, date, status = 'added') {
  return [
    normalizeScanUrl(offer.url),
    date,
    offer.source,
    offer.title,
    offer.company,
    status,
    offer.location || '',
    // JD-content fingerprint (#1597): 16 hex chars when the provider's list
    // API shipped a usable description, '' otherwise. Lets later scans flag
    // the same body re-posted under a different company (agency cross-listing)
    // without storing the body. All readers tolerate the extra column.
    offer.fingerprint ?? fingerprintText(offer.description),
    // New trailing column: posting date. Existing readers index by position up to
    // col 7, so appending col 8 is backward-compatible.
    postedAtIsoDate(offer.postedAt),
    // Trust/legitimacy signal (#1743): score (only when the scanner flagged the
    // posting, i.e. < 100) + comma-joined flags. Trailing cols 9-10, so existing
    // index-based readers (fingerprint@7, postedAt@8) are unaffected; a clean
    // posting or a scan without trust_filter leaves both empty.
    trustIsFlagged(offer) ? String(offer.trustScore) : '',
    trustIsFlagged(offer) ? trustFlagList(offer).join(',') : '',
    // Normalized company key (#2093): the canonical company form shared across
    // the tracker (normalizeCompanyName — lowercased, punctuation/whitespace
    // folded, trailing legal-entity suffixes stripped) so "Acme Inc.",
    // "Acme, Inc." and "ACME  Inc" all key to `acme`. Stored at write time so
    // repost/name-matching never has to route through executing a script, and
    // the raw display company in col 5 stays faithful to what the provider
    // returned. Trailing col 12 — purely additive: index-based readers
    // (fingerprint@7, postedAt@8, trust@9-10, and the web parser's first 7
    // cols) are unaffected, and older rows that lack it are tolerated by
    // consumers normalizing the raw name on the fly.
    normalizeCompanyName(offer.company || ''),
  ].map(sanitizeTsvField).join('\t');
}

/**
 * Parse scan-history.tsv rows that carry a fingerprint, for the cross-listing
 * check. Older rows without the 8th column simply never match. Takes the file
 * text ('' for an absent file), like its `collect*` siblings.
 *
 * @param {string} [scanHistoryText] - Full scan-history.tsv contents.
 * @returns {Array<{url: string, dateStr: string, company: string, title: string, fingerprint: string}>}
 */
export function collectFingerprintHistory(scanHistoryText = '') {
  const rows = [];
  for (const line of scanHistoryText.split('\n')) {
    const cols = line.split('\t');
    // Skip the header row. Older 7-col headers fall out of the `cols.length < 8`
    // guard below on their own, but the 12-col header names col 7 `fingerprint`
    // (non-empty), so it would otherwise pass that guard and be read as data.
    // Real rows always carry a URL in col 0, never the literal `url`.
    if (cols[0] === 'url') continue;
    if (cols.length < 8 || !cols[7].trim()) continue;
    rows.push({
      url: (cols[0] || '').trim(),
      dateStr: (cols[1] || '').trim(),
      title: (cols[3] || '').trim(),
      company: (cols[4] || '').trim(),
      fingerprint: cols[7].trim(),
    });
  }
  return rows;
}

/**
 * Filesystem wrapper over {@link collectFingerprintHistory}.
 *
 * @param {string} [historyPath] - Override for tests.
 */
export function loadFingerprintHistory(historyPath = SCAN_HISTORY_PATH) {
  return collectFingerprintHistory(readIfExists(historyPath));
}

/**
 * Read the three dedup sources once and derive every per-run dedup structure
 * from that single read (#2382). A scan run used to parse scan-history.tsv
 * three times and pipeline.md/applications.md twice each — at 50k history rows
 * that is ~600 ms of redundant parsing per run.
 *
 * The snapshot is deliberately per-run: callers hold the returned object in
 * run-scoped locals and nothing is cached at module level, so a later run
 * always re-reads the files. Dedup state is therefore frozen at run start;
 * rows appended by a concurrent process mid-run are picked up by the next run
 * (the previous re-read at the cross-listing step could not safely observe
 * them anyway — scan-history appends are not locked).
 *
 * @param {{recheckAfterDays?: number|null, today?: string}} [policy] -
 *   Scan-history recheck policy, shared by the URL and company+role sets.
 * @param {(name: unknown) => string} [canonicalize=defaultCompanyNormalizer] -
 *   Company canonicalizer for the role keys.
 * @returns {{seen: Set<string>, recheckEligible: number, seenCompanyRoles: Set<string>, fingerprintHistory: Array<{url: string, dateStr: string, company: string, title: string, fingerprint: string}>}}
 */
// Same path seam as loadSeenUrls/appendToPipeline: anchored defaults, explicit
// paths for a caller with its own lane or a test with a fixture.
export function loadDedupSnapshot(policy = {}, canonicalize = defaultCompanyNormalizer, {
  scanHistoryPath = SCAN_HISTORY_PATH,
  pipelinePath = PIPELINE_PATH,
  applicationsPath = APPLICATIONS_PATH,
} = {}) {
  const scanHistoryText = readIfExists(scanHistoryPath);
  const pipelineText = readIfExists(pipelinePath);
  const applicationsText = readIfExists(applicationsPath);
  const { seen, recheckEligible } = collectSeenUrls({ scanHistoryText, pipelineText, applicationsText }, policy);
  const seenCompanyRoles = collectSeenCompanyRoles({ applicationsText, scanHistoryText, pipelineText }, policy, canonicalize);
  const fingerprintHistory = collectFingerprintHistory(scanHistoryText);
  return { seen, recheckEligible, seenCompanyRoles, fingerprintHistory };
}

// Standard skeleton created on fresh install — matches the format documented
// in modes/pipeline.md and expected by /career-ops pipeline.
const PIPELINE_SKELETON = `# Pipeline — Pending URLs

Paste job URLs below as \`- [ ] {url}\` then run \`/career-ops pipeline\`.

## Pending

## Processed
`;

// Current section names (English). Legacy Spanish names are checked as fallback
// so existing pipeline.md files created before this change keep working.
const PENDING_MARKERS = ['## Pending', '## Pendientes'];
const PROCESSED_MARKERS = ['## Processed', '## Procesadas'];

// Locked (pipeline-lock.mjs) so scan.mjs, scan-ats-full.mjs, and plugins.mjs
// (pipeline mode) — the three current callers — can never interleave their
// read-modify-write and silently drop each other's offers.
// Same seam as loadSeenUrls above: the default is the CAREER_OPS_ROOT-anchored
// module constant; a caller with its own lane (or a fixture) passes the path.
export async function appendToPipeline(offers, { pipelinePath = PIPELINE_PATH } = {}) {
  if (offers.length === 0) return;

  await withPipelineLock(pipelinePath, async () => {
    // Auto-create with standard skeleton if missing (fresh-install guard).
    let text = existsSync(pipelinePath)
      ? readFileSync(pipelinePath, 'utf-8')
      : PIPELINE_SKELETON;

    const marker = PENDING_MARKERS.find(m => text.includes(m)) ?? null;
    const idx = marker !== null ? text.indexOf(marker) : -1;

    if (idx === -1) {
      // No Pending section found — insert one before Processed (or at end)
      const procIdx = PROCESSED_MARKERS.reduce((found, m) => {
        const i = text.indexOf(m);
        return (found === -1 || (i !== -1 && i < found)) ? i : found;
      }, -1);
      const insertAt = procIdx === -1 ? text.length : procIdx;
      const block = `\n## Pending\n\n` + offers.map(formatPipelineOffer).join('\n') + '\n\n';
      text = text.slice(0, insertAt) + block + text.slice(insertAt);
    } else {
      // Find the end of existing Pending content (next ## or end)
      const afterMarker = idx + marker.length;
      const nextSection = text.indexOf('\n## ', afterMarker);
      const insertAt = nextSection === -1 ? text.length : nextSection;

      const block = '\n' + offers.map(formatPipelineOffer).join('\n') + '\n';
      text = text.slice(0, insertAt) + block + text.slice(insertAt);
    }

    atomicWriteFile(pipelinePath, text);
  });
}

/**
 * Add already-ticked lines to the end of the Processed block, under the same
 * lock appendToPipeline takes. The fit gate's SKIPs (ticket D2b) go here, so a
 * rejected row is recorded once and never enters Pending.
 */
export async function appendProcessedToPipeline(lines, { pipelinePath = PIPELINE_PATH } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return;

  await withPipelineLock(pipelinePath, async () => {
    const text = existsSync(pipelinePath)
      ? readFileSync(pipelinePath, 'utf-8')
      : PIPELINE_SKELETON;
    const all = text.split('\n');
    const procIdx = all.findIndex(l => PROCESSED_MARKERS.some(m => l.trim() === m));
    if (procIdx === -1) {
      while (all.length > 0 && all[all.length - 1].trim() === '') all.pop();
      all.push('', '## Processed', '', ...lines, '');
    } else {
      let insertAt = all.length;
      for (let i = procIdx + 1; i < all.length; i++) {
        if (all[i].startsWith('## ')) { insertAt = i; break; }
      }
      while (insertAt > procIdx + 1 && all[insertAt - 1].trim() === '') insertAt--;
      // A Processed heading with nothing under it yet gets its blank line.
      const lead = insertAt === procIdx + 1 ? [''] : [];
      all.splice(insertAt, 0, ...lead, ...lines);
    }
    atomicWriteFile(pipelinePath, all.join('\n'));
  });
}

/**
 * The fit judgement for one row the sweep is about to queue (ticket D2b).
 *
 * The advert is the row's description, which the reader or the board already
 * filled, or failing that the stored file its `jd:` path names. Returns the
 * gate's outcome, which is never a thrown error: every failure is REVIEW.
 */
export async function assessFit(job, gate, companyName = '', { jdsDir = JDS_DIR } = {}) {
  let advert = typeof job.description === 'string' ? job.description : '';
  if (!advert.trim() && job.jdPath && (job.readStatus == null || job.readStatus === 'read')) {
    advert = loadAdvertText(job.jdPath, { jdsDir });
  }
  return gate.assess({
    company: job.company || companyName || '',
    title: job.title || '',
    location: job.location || '',
    advert,
    readStatus: job.readStatus ?? null,
  });
}

// ── The advert reader (ticket B1) ───────────────────────────────────
//
// The scan decides on the title alone when the board hands over no advert, and
// a content filter reading an empty string passes everything, silently. This
// fills job.description from a stored read before the three advert filters run,
// and records how the text was got so "could not read" is never mistaken for
// "no criterion found".

/** Whether a board already handed over an advert worth filtering on. */
function hasAdvertText(description) {
  return typeof description === 'string' && description.trim().length > 0;
}

/**
 * Whether a read outcome takes the row out of the run.
 *
 * Only `expired` does. The board's own page says the posting is gone, so there
 * is nothing to filter and nothing to apply to; passing it on with an empty
 * description is exactly the silent pass this ticket exists to close. A row
 * nobody could read is the opposite case and is kept, labelled and listed.
 *
 * The row is not written to scan-history: a read verdict of `expired` is one
 * run's reading of one page, and a wrong one recorded there would dedup-filter a
 * live posting out of every later scan. Dropping it from this run is the
 * reversible direction.
 */
export function advertReadDropsRow(status) {
  return status === 'expired';
}

/**
 * Rung 3: the headless reader already in the tree, read-only.
 *
 * Serialized across the whole run by the promise chain below, not merely called
 * once per row. The sweep fetches sources through CONCURRENCY workers, so
 * without this every worker that reached rung 3 launched its own Chromium at the
 * same moment: on 10 September three Welcome to the Jungle rows timed out in the
 * sweep and read cleanly in the sequential standalone pass over the same URLs.
 */
let browserQueue = Promise.resolve();

function browserExtractTransport(url, opts = {}) {
  const settled = () => undefined;
  const run = browserQueue.then(() => spawnBrowserExtract(url, opts), () => spawnBrowserExtract(url, opts));
  // The queue tracks completion, never failure: one row's timeout must not
  // reject the next row's turn.
  browserQueue = run.then(settled, settled);
  return run;
}

function spawnBrowserExtract(url, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(CODE_ROOT, 'browser-extract.mjs'), url, '--mode', 'jd'],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).slice(0, 200)));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error('browser-extract returned unparseable output'));
        }
        resolve({ status: 200, text: parsed.text || '', finalUrl: parsed.url || url });
      },
    );
  });
}

/**
 * One reader for the sweep and for the standalone pass, so both count the same
 * things the same way.
 *
 * A stored advert is re-used and never re-fetched for the same URL, so a re-run
 * costs nothing on the boards.
 */
export function buildAdvertReader({
  config = {},
  jdsDir = JDS_DIR,
  reread = false,
  transports = null,
} = {}) {
  const firecrawlEnabled = config?.read_ladder?.firecrawl?.enabled === true;
  const t = transports || defaultTransports({ browser: browserExtractTransport });
  const tally = {
    considered: 0,
    read: 0,
    reused: 0,
    rungs: { page: 0, feed: 0, 'apply-link': 0, browser: 0, stored: 0, apify: 0 },
    unreadable: 0,
    byFailure: { blocked: 0, shell: 0, expired: 0, other: 0 },
    firecrawlResidue: 0,
    unreadableRows: [],
  };

  /** A stored `read` advert, counted under the rung that read it. */
  function countStoredRead(rung) {
    tally.read++;
    const bucket = rung && tally.rungs[rung] != null ? rung : 'stored';
    tally.rungs[bucket]++;
  }

  async function read({ url, company, title, location }) {
    tally.considered++;
    const identity = { url, company: company || '', title: title || '', location: location || '' };

    const existing = findAdvert(identity, { jdsDir });
    if (existing && !(reread && existing.status !== 'read')) {
      tally.reused++;
      const text = existing.status === 'read' ? loadAdvertText(existing.path, { jdsDir }) : '';
      // A row nobody could read yesterday would walk the same ladder today and
      // reach the paid rung again, so it counts against the residue exactly as a
      // fresh failure does. Without this the second run of any day reports a
      // residue near zero and reads like a fix. An `expired` row is the
      // exception: its ladder ended at the board's own page.
      const reachedFirecrawl = existing.status !== 'read' && existing.status !== 'expired';
      if (reachedFirecrawl) tally.firecrawlResidue++;
      if (existing.status === 'read') {
        countStoredRead(existing.rung);
      } else {
        tally.unreadable++;
        // Bucketed under what the file actually says, not swept into `other`:
        // the breakdown is what tells a bot wall from a posting that is gone.
        const kind = existing.status || 'other';
        tally.byFailure[kind] = (tally.byFailure[kind] || 0) + 1;
        tally.unreadableRows.push({ ...identity, failedAs: existing.status, failedAt: 'stored' });
      }
      return { status: existing.status, rung: existing.rung, jdPath: existing.path, text, reused: true, reachedFirecrawl };
    }

    const outcome = await readAdvert(url, t, { firecrawlEnabled });
    const saved = saveAdvert({
      ...identity,
      text: outcome.text,
      rung: outcome.rung,
      status: outcome.status,
      finalUrl: outcome.finalUrl,
      fetchedAt: new Date().toISOString(),
      source: 'scan-reader',
    }, { jdsDir, reread });

    if (outcome.reachedFirecrawl) tally.firecrawlResidue++;
    if (outcome.status === 'read') {
      tally.read++;
      if (tally.rungs[outcome.rung] != null) tally.rungs[outcome.rung]++;
    } else {
      tally.unreadable++;
      const kind = outcome.status === 'expired' ? 'expired' : (outcome.failedAs || 'other');
      tally.byFailure[kind] = (tally.byFailure[kind] || 0) + 1;
      tally.unreadableRows.push({ ...identity, failedAs: kind, failedAt: outcome.failedAt || 'route' });
    }

    return { ...outcome, jdPath: saved.path, reused: false };
  }

  /**
   * The stored advert for a row that arrived with its own, or null. Never
   * fetches.
   *
   * The apify plugin caches the advert under `jds/` under the same filename
   * this store uses and puts the same text on `description`, so the row is
   * pointed at that file and counted where a stored read is counted. Only a
   * `read` file is named: the gate reads the row's description, and a `jd:`
   * segment naming a stub would send triage to empty text.
   */
  function attachStored({ url, company, title, location }) {
    const identity = { url, company: company || '', title: title || '', location: location || '' };
    const existing = findAdvert(identity, { jdsDir });
    if (!existing || existing.status !== 'read') return null;
    tally.considered++;
    tally.reused++;
    countStoredRead(existing.rung);
    return { status: 'read', rung: existing.rung, jdPath: existing.path, reused: true, reachedFirecrawl: false };
  }

  return { read, attachStored, tally, firecrawlEnabled };
}

/**
 * The sweep's read step for one job that survived the free filters.
 *
 * A job with no description goes down the ladder, and its text, stored path
 * and read status land on the job. A job that already carries its advert is
 * never fetched; when the store holds that advert (the apify plugin's cache)
 * the job is pointed at it, so the queue line gets its `jd:` segment.
 *
 * @returns {Promise<object|null>} The ladder's outcome, or null when no read ran.
 */
export async function fillJobAdvert(job, reader, companyName = '') {
  const entry = {
    url: job.url,
    company: job.company || companyName || '',
    title: job.title,
    location: job.location,
  };
  if (hasAdvertText(job.description)) {
    const stored = reader.attachStored(entry);
    if (stored) job.jdPath = stored.jdPath;
    return null;
  }
  const outcome = await reader.read(entry);
  if (outcome.jdPath) job.jdPath = outcome.jdPath;
  job.readStatus = outcome.status;
  if (outcome.status === 'read' && outcome.text) job.description = outcome.text;
  return outcome;
}

/**
 * One line per row nobody could read, so Stelios knows which adverts to open by
 * hand that morning. A row whose stored file already said `unreadable` says so,
 * rather than repeating the word twice.
 */
export function formatUnreadableRow(row) {
  const how = row.failedAt === 'stored'
    ? `read as ${row.failedAs} on an earlier run, not re-read`
    : `${row.failedAs} at ${row.failedAt}`;
  return `READ | ${row.company || '?'} | ${row.title || '?'} | unreadable: ${how} | ${row.url}`;
}

/**
 * The three lines the run prints about the read. B2 adds the drop and route
 * lines below them; the shape here is the one Stelios reads.
 */
const FAILURE_ORDER = ['blocked', 'shell', 'expired', 'unreadable', 'other'];

export function formatReadSummary(tally, { firecrawlEnabled = false } = {}) {
  const rungs = ['page', 'feed', 'apply-link', 'browser', 'stored', 'apify']
    .filter((k) => tally.rungs[k] > 0)
    .map((k) => `${k === 'apply-link' ? 'apply link' : k} ${tally.rungs[k]}`)
    .join(', ');
  // Every bucket that has a count, not a fixed list: a stored row is bucketed
  // under whatever its file says, and a status the list never anticipated would
  // otherwise be counted in `unreadable` and named nowhere.
  const seen = Object.keys(tally.byFailure).filter((k) => tally.byFailure[k] > 0);
  const failures = [
    ...FAILURE_ORDER.filter((k) => seen.includes(k)),
    ...seen.filter((k) => !FAILURE_ORDER.includes(k)).sort(),
  ]
    .map((k) => `${k} ${tally.byFailure[k]}`)
    .join(', ');
  const residue = tally.firecrawlResidue;
  return [
    `Adverts read:          ${tally.read} of ${tally.considered}${rungs ? `   (${rungs})` : ''}`,
    `Unreadable:            ${tally.unreadable}${failures ? `         (${failures})` : ''}`
      + (tally.unreadable > 0 ? '   listed below for a manual read' : ''),
    `Firecrawl:             ${firecrawlEnabled ? 'ON (not built)' : 'OFF'}        `
      + `${residue} ${residue === 1 ? 'row' : 'rows'} would have reached it today`,
  ];
}

/**
 * The recheck's own count of what it did to the pending lines it kept.
 * `Unchanged` replaced B1's "Already labelled" (ticket C, C5): every line is
 * re-gated on every run, so what matters is whether this run changed it.
 * `Loaded from store` counts the lines whose advert was already stored and was
 * not fetched again.
 */
export function formatRecheckSummary(counts) {
  const rows = (n) => `${n} ${n === 1 ? 'row' : 'rows'}`;
  return [
    `Loaded from store:     ${rows(counts.skipped || 0)}`,
    `Unchanged:             ${rows(counts.unchanged || 0)}`,
    `Relabelled:            ${rows(counts.changed || 0)}`,
  ];
}

/**
 * Mark a pending line processed without losing anything it carried.
 *
 * The queue's older pre-screen shape (`- [x] #-- | <url> | skipped (…)`) throws
 * the company and title cells away and buries them inside the reason, and that
 * is precisely why the Anthropic Applied AI Strategist came back: a line with no
 * readable pair seeds no dedup key, so the re-listing looked new. This keeps the
 * whole entry, ticks the box and appends the reason, so the pair, the URL and
 * the stored advert all survive the move.
 */
export function markPipelineLineProcessed(line, reason) {
  const ticked = String(line).replace(/^(\s*- \[)[ ]?(\])/, '$1x$2');
  return reason ? `${ticked.replace(/\s+$/, '')} | ${reason}` : ticked;
}

/**
 * The reason written on a line the gate dropped.
 *
 * The phrase is sanitized because it is no longer always a configured keyword:
 * a years drop quotes the advert's own sentence, and a pipe inside it would add
 * a cell to the queue line that every positional reader would then miscount.
 */
export function formatGateDropReason(row, today = localToday()) {
  const label = ADVERT_DROP_LABELS[row.reason] || row.reason || 'advert';
  const phrase = row.phrase ? `: "${sanitizeMarkdownField(row.phrase)}"` : '';
  return `skipped (${label}${phrase}, ${today})`;
}

/**
 * The standalone pass: `node scan.mjs --read-pipeline`, and with `--gate` the
 * half that decides what each line costs.
 *
 * Walks the Pending section, reads every entry that carries no `jd:` segment
 * yet, and rewrites the line with one. It takes the same lock appendToPipeline
 * takes and reads no boards, so it is how the roles already queued get the same
 * treatment as tomorrow's scan.
 *
 * With `gate` supplied (`--gate`), each pending line also:
 *
 *   1. is checked against the tracker first, on the posting URL and on company
 *      plus title, and moved to Processed as a duplicate before anything is
 *      read, routed or dropped;
 *   2. meets the three advert filters on its stored text, and moves to
 *      Processed with the phrase that dropped it when one bites;
 *   3. is labelled `route: score` or `route: standard`, including a line that
 *      was already read on an earlier day and is not read again, or
 *      `route: review` when nobody could read its advert.
 *
 * A row whose stored status is not `read` is never dropped on its advert.
 *
 * Every run re-gates every pending line under the current rules and rewrites a
 * line only when its segments change (ticket C, C5). A line moved to Processed
 * keeps every cell, its `triage:` verdict included, with the reason appended.
 * The tracker is read, never written.
 *
 * `readEntry` is injected so the whole pass is testable against a temporary
 * file with no network and no store.
 *
 * @param {object} options
 * @returns {Promise<object>} Counters and the rows behind them.
 */
export async function readPipelineAdverts({
  pipelinePath = PIPELINE_PATH,
  readEntry,
  reread = false,
  storedStatus = (relPath) => advertStatusAt(relPath, { jdsDir: JDS_DIR }),
  storedText = (relPath) => loadAdvertText(relPath, { jdsDir: JDS_DIR }),
  gate = null,
  tiersTable = null,
  trackerIndex = null,
  // The same canonicaliser the sweep dedups with. Without it a tracker row
  // filed under one spelling and a queue line under its configured alias never
  // match, which is exactly the duplicate this check exists to catch.
  canonicalizeCompany = defaultCompanyNormalizer,
  titleFilterConfig = null,
  today = localToday(),
} = {}) {
  const counts = {
    read: 0,
    unreadable: 0,
    expired: 0,
    skipped: 0,
    firecrawlResidue: 0,
    unreadableRows: [],
    routed: emptyRouteTally(),
    drops: emptyAdvertDropTally(),
    duplicates: 0,
    duplicateRows: [],
    moved: 0,
    // Every pending line the pass looked at and did not move (ticket C, C5):
    // `changed` when the run rewrote it, `unchanged` when it is byte-identical.
    changed: 0,
    unchanged: 0,
  };
  if (typeof readEntry !== 'function') throw new Error('readPipelineAdverts: readEntry is required');
  if (!existsSync(pipelinePath)) return counts;

  await withPipelineLock(pipelinePath, async () => {
    const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
    const startIdx = lines.findIndex(l => PENDING_MARKERS.some(m => l.trim() === m));
    if (startIdx === -1) return;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { endIdx = i; break; }
    }

    // Lines the gate takes out of Pending, moved after the walk so the indices
    // stay stable while it runs.
    const movedOut = new Set();
    const movedLines = [];
    // Each pending line as it was read, to count what the run changed.
    const before = new Map();

    for (let i = startIdx + 1; i < endIdx; i++) {
      const line = lines[i];
      const entry = pipelineEntry(line, PIPELINE_CHECKBOX_RE);
      // A struck-out entry is the pipeline's record of a dead posting; there is
      // nothing left to read.
      if (!entry || entry.expired) continue;
      // An entry already ticked has been dealt with; the Pending section can
      // carry one when a mode moved the state without moving the line.
      if (!/^\s*- \[ \]/.test(line)) continue;
      before.set(i, line);

      const identity = pipelineLineIdentity(line) || { url: '', company: '', title: '' };

      // ── 1. The tracker, before any route or drop ──────────────────
      // A role already tracked is not queued again, whether it comes back under
      // the same link or under another board's link and a slightly different
      // title. Checked before the read, so a duplicate costs no fetch either.
      if (gate && trackerIndex) {
        const duplicate = matchTrackerDuplicate(identity, trackerIndex, canonicalizeCompany);
        if (duplicate) {
          counts.duplicates++;
          counts.duplicateRows.push({ ...identity, ...duplicate });
          movedOut.add(i);
          movedLines.push(markPipelineLineProcessed(line, formatTrackerDuplicateReason(duplicate)));
          continue;
        }
      }

      // ── 2. The read ───────────────────────────────────────────────
      // A line the apify plugin wrote carries its advert in the URL cell rather
      // than a `jd:` segment. Without this it has no advert, no filter and no
      // route at all, which is three lines of today's queue passing the gate
      // untouched.
      //
      // Before B3 reached the fork, the free reader was handed that `local:`
      // cell as a URL and stored an empty stub marked unreadable, so most such
      // lines also carry a `jd:` segment naming the stub. The plugin's file is
      // the advert: it wins whenever the segment's file is not `read` and the
      // plugin's file exists. storedState reads the plugin's file, which has no
      // read_status line, as `read`, so `--reread` does not send the line down
      // the fetch branch, where a `local:` line has no URL and is skipped.
      const jdSegment = extractJdSegment(line);
      const preferLocal = Boolean(jdSegment && identity.localPath)
        && storedStatus(jdSegment) !== 'read'
        && storedStatus(identity.localPath) != null;
      const storedPath = (preferLocal ? identity.localPath : jdSegment || identity.localPath) || '';
      const alreadyRead = Boolean(storedPath) && !(reread && storedStatus(storedPath) !== 'read');
      // The segment is pointed at the file the gate reads, so triage, which
      // follows `jd:` and does not fetch, reads the advert and not the stub.
      let workingLine = preferLocal ? insertJdSegment(line, storedPath, { replace: true }) : line;
      let readStatus = null;
      let text = '';
      let jdPath = storedPath || '';

      if (alreadyRead) {
        // B1 stopped here. With the gate on, a line read on an earlier day
        // still has to be filtered and routed, so its stored text is loaded
        // rather than re-fetched.
        counts.skipped++;
        if (!gate) continue;
        // A stored path whose file is gone is an advert nobody read, not a
        // board description: null would let the route pass it as `standard`.
        readStatus = storedStatus(storedPath) ?? 'unreadable';
        if (readStatus === 'read') {
          try {
            text = storedText(storedPath) || '';
          } catch {
            text = '';
          }
        }
      } else {
        const url = identity.url;
        if (!url) continue;
        let outcome = null;
        try {
          outcome = await readEntry({ url, company: identity.company, title: identity.title, line });
        } catch (err) {
          // Per row, never per run.
          outcome = { status: 'unreadable', rung: null, jdPath: null, failedAs: 'blocked', failedAt: 'reader', reachedFirecrawl: true, error: err?.message };
        }
        if (!outcome) continue;

        if (outcome.jdPath) {
          jdPath = outcome.jdPath;
          workingLine = insertJdSegment(workingLine, outcome.jdPath);
        }
        if (outcome.reachedFirecrawl) counts.firecrawlResidue++;
        readStatus = outcome.status;
        text = outcome.status === 'read' ? (outcome.text || '') : '';
        if (outcome.status === 'read') counts.read++;
        else if (outcome.status === 'expired') counts.expired++;
        else {
          counts.unreadable++;
          counts.unreadableRows.push({ url, company: identity.company, title: identity.title, failedAs: outcome.failedAs, failedAt: outcome.failedAt });
        }
      }

      if (!gate) {
        lines[i] = workingLine;
        continue;
      }

      // ── 3. The three advert filters ───────────────────────────────
      const verdict = gate({
        description: text,
        matchedKeywords: matchedTitleKeywords(identity.title, titleFilterConfig),
        readStatus,
        location: identity.location,
      });
      if (verdict.drop) {
        const row = {
          company: identity.company,
          title: identity.title,
          url: identity.url,
          jdPath,
          reason: verdict.reason,
          phrase: verdict.phrase,
        };
        countAdvertDrop(counts.drops, row);
        movedOut.add(i);
        movedLines.push(markPipelineLineProcessed(workingLine, formatGateDropReason(row, today)));
        continue;
      }

      // ── 4. The long shot, then the route ──────────────────────────
      // Only for a row this pass actually read: an unread advert has no verdict
      // to write, and clearing a label the reader wrote on a better day would
      // lose the only thing the queue knows about its years bar.
      if (!verdict.unread) {
        workingLine = insertYearsSegment(workingLine, verdict.years ?? null);
        workingLine = insertLocationSegment(workingLine, verdict.location ?? null);
      }
      // This pass does not judge fit (ticket D2b) and never writes `fit:`, but
      // a line the scan's gate held for review stays `review`: re-routing it on
      // the tier would put a SKIP or a REVIEW back on the standard pack.
      const routing = holdRouteForFit(
        routeDetail(identity.company, tiersTable, identity.note, readStatus),
        extractFitSegment(line),
      );
      countRoute(counts.routed, routing);
      lines[i] = insertRouteSegment(workingLine, routing.route);
    }

    for (const [i, line] of before) {
      if (movedOut.has(i)) continue;
      if (lines[i] === line) counts.unchanged++;
      else counts.changed++;
    }

    if (movedOut.size > 0) {
      counts.moved = movedOut.size;
      const kept = lines.filter((_, idx) => !movedOut.has(idx));
      const procIdx = kept.findIndex(l => PROCESSED_MARKERS.some(m => l.trim() === m));
      if (procIdx === -1) {
        kept.push('', '## Processed', '', ...movedLines);
      } else {
        let insertAt = kept.length;
        for (let i = procIdx + 1; i < kept.length; i++) {
          if (kept[i].startsWith('## ')) { insertAt = i; break; }
        }
        while (insertAt > procIdx + 1 && kept[insertAt - 1].trim() === '') insertAt--;
        kept.splice(insertAt, 0, ...movedLines);
      }
      atomicWriteFile(pipelinePath, kept.join('\n'));
      return;
    }

    // A run that changed no line leaves the file alone, modified time and all,
    // so a second run over the same queue is visibly a no-op.
    if (counts.changed > 0) atomicWriteFile(pipelinePath, lines.join('\n'));
  });

  return counts;
}

// data/scan-history.tsv has exactly the same set of concurrent writers as
// data/pipeline.md — scan.mjs, scan-ats-full.mjs, scan-interamt.mjs and
// plugins.mjs — so it takes the same lock appendToPipeline does, on its own
// path. Unlocked, two writers race in two places: the create branch below is a
// check-then-write, and its writeFileSync truncates, so a scanner that loses
// the race erases rows the winner already appended; and a multi-row
// appendFileSync is not atomic, so a concurrent append can interleave mid-line.
// Both surface as rows that silently stop counting, because every reader skips
// a malformed line quietly.
export async function appendToScanHistory(offers, date, status = 'added') {
  await withPipelineLock(SCAN_HISTORY_PATH, () => {
    // Ensure file + header exist. The header names every column the row writer
    // (formatScanHistoryRow) emits, in the same order: the original 7 positional
    // cols (url…location) plus the append-only trailing cols added since —
    // fingerprint (7), posted_at (8), trust_score (9), trust_flags (10),
    // normalized_company (11). Written ONLY on fresh-file creation; existing files
    // (including headerless legacy files and older 7-col-header files) are never
    // rewritten. All readers either skip line 0 unconditionally, detect the header
    // by its `url\t` prefix, or skip non-URL col-0 rows, so widening it stays
    // backward-compatible. `status` is parameterized so callers can record verify
    // outcomes (`skipped_expired`, etc.) without the legacy `(expired)` suffix.
    if (!existsSync(SCAN_HISTORY_PATH)) {
      mkdirSync(path.dirname(SCAN_HISTORY_PATH), { recursive: true });
      atomicWriteFile(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\tfingerprint\tposted_at\ttrust_score\ttrust_flags\tnormalized_company\n');
    }

    const lines = offers.map(o => formatScanHistoryRow(o, date, status)).join('\n') + '\n';

    appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
  });
}

// ── Company blacklist (#1742) ───────────────────────────────────────

// User Layer, so it follows the data root like every other input this file reads
// (#3510). It was a bare relative string, i.e. resolved against process.cwd(),
// which meant a user with a data root configured got whatever blacklist happened
// to sit in the directory they ran from — usually none, so their do-not-apply
// list was silently empty while the run reported no filtering at all.
const BLACKLIST_PATH = path.join(DATA_ROOT, 'data/blacklist.md');

/**
 * Parse the user's do-not-apply list (data/blacklist.md, user layer, opt-in).
 *
 * The file is a small markdown table the user owns:
 * `| Company | Since | Scope | Reason |`. Nothing here ever creates or writes
 * it — an absent file means no filtering. Companies are keyed with the same
 * normalization every tracker writer shares (normalizeCompany, #1460), so a
 * blacklist row "Acme Corp." still catches an ATS feed that says "acme corp".
 *
 * @param {string} text - Raw data/blacklist.md content.
 * @returns {Map<string, {company: string, since: string, scope: string, reason: string}>}
 *          Normalized company key → entry. First row wins on duplicate keys.
 */
export function parseBlacklist(text) {
  const entries = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue; // separator row
    if (company.toLowerCase() === 'company') continue;  // header row
    const key = normalizeCompany(company);
    if (!key || entries.has(key)) continue;
    entries.set(key, {
      company,
      since: cells[2] || '',
      scope: cells[3] || '',
      reason: cells[4] || '',
    });
  }
  return entries;
}

/**
 * Load data/blacklist.md if the user opted in. Absent file = empty Map = no
 * filtering anywhere — the scan stays byte-identical to a pre-#1742 run.
 *
 * @param {string} [filePath] - Override for tests.
 * @returns {Map<string, {company: string, since: string, scope: string, reason: string}>}
 */
export function loadBlacklist(filePath = BLACKLIST_PATH) {
  if (!existsSync(filePath)) return new Map();
  return parseBlacklist(readFileSync(filePath, 'utf-8'));
}

// ── Scan-run persistence (#1604) ────────────────────────────────────

// Anchored for the same reason (#3510), and with a reader to agree with:
// stats.mjs:36 reads join(DATA_ROOT, 'data', 'scan-runs.tsv'). While this was
// cwd-relative the writer and the reader could name different files, and the
// trend stats simply under-reported whatever landed elsewhere.
const SCAN_RUNS_PATH = path.join(DATA_ROOT, 'data/scan-runs.tsv');

// One row of run counters per non-dry scan — today these numbers are printed
// once in the summary and lost when the terminal scrolls. Full ISO timestamp
// (two scans in one day must not collapse). `status` is 'completed' for a
// finished run; a run that dies after the sweep starts records 'failed' via
// writeRunFailureRow (#2643) so trend stats can exclude survivorship bias.
// Consumers MUST parse by header name, never by position — columns may be
// appended in later versions.
export const SCAN_RUNS_HEADER = 'timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tfiltered_tier\tfiltered_location\tfiltered_posting_age\tfiltered_salary\tfiltered_content\tfiltered_cooldown\tdupes\tnew_added\terrors\tfiltered_blacklist\tfiltered_visa\tfiltered_posted_date\tfiltered_country_eligibility\n';

// Failure-path writes (#2643). main() registers a snapshot closure once the
// sweep's counters exist (never on --dry-run, never before the sweep starts —
// a config error is not a run). The fatal catch and the SIGINT handler both
// call writeRunFailureRow; the snapshot is consumed on first use so the two
// signals can never double-write. Best-effort by design: a failure to record
// the failure must not mask the original error, so everything is swallowed.
let runFailureSnapshot = null;
let runFailureSourceWriter = null;

/**
 * @param {Function} fn - returns the run-summary counters as of now
 * @param {Function} [writeSources] - optional; called with the row's timestamp
 *   to write the per-source rows for the same failed run. It owns the path,
 *   because --source-log is only known inside main().
 */
export function registerRunFailureSnapshot(fn, writeSources = null) {
  runFailureSnapshot = typeof fn === 'function' ? fn : null;
  runFailureSourceWriter = typeof writeSources === 'function' ? writeSources : null;
}

export function writeRunFailureRow(status = 'failed', filePath = SCAN_RUNS_PATH) {
  const snapshot = runFailureSnapshot;
  const writeSources = runFailureSourceWriter;
  runFailureSnapshot = null;
  runFailureSourceWriter = null;
  if (!snapshot) return false;
  // snapshot() is called INSIDE the try: a throwing snapshot must not mask the
  // original failure, which is the whole point of the best-effort contract.
  let timestamp = null;
  try {
    const row = { ...snapshot(), status };
    appendScanRunSummary(row, filePath);
    timestamp = row.timestamp;
  } catch {
    // Best-effort by design — see above.
  }
  if (timestamp === null) return false;
  // The per-source rows for the same failed run, under the SAME timestamp, so
  // the join the log promises holds when the run died as well as when it
  // finished. This is the run where the breakdown matters most: it says which
  // sources had been read before the failure and which never got their turn.
  // Skipped when the row above was not written, rather than promising a join
  // to a run-summary row that does not exist.
  if (writeSources) {
    try {
      writeSources(timestamp);
    } catch {
      // Recording the failure must never mask the original error.
    }
  }
  return true;
}

export function appendScanRunSummary(c, filePath = SCAN_RUNS_PATH) {
  // The header is written only on first creation, so a release that appends or inserts a counter
  // leaves existing files with a header that no longer describes the rows below it. Nothing
  // migrates it and nothing notices: stats.mjs reads by column NAME, so it silently returns a
  // neighbouring counter. Surface the mismatch here rather than papering over it — rewriting the
  // header in place would misalign every historical row instead.
  if (!existsSync(filePath)) {
    atomicWriteFile(filePath, SCAN_RUNS_HEADER);
  } else {
    const onDisk = (readFileSync(filePath, 'utf-8').split('\n', 1)[0] || '') + '\n';
    if (onDisk !== SCAN_RUNS_HEADER) {
      console.error(
        `Warning: ${filePath} header has ${onDisk.trim().split('\t').length} columns but this build writes `
        + `${SCAN_RUNS_HEADER.trim().split('\t').length}. Rows below the header are positionally offset and `
        + `stats.mjs will exclude them. Move ${filePath} aside to start a fresh file — deleting only the header does NOT recover it, because the file still exists and the next run would read the first data row as the header.`,
      );
    }
  }
  const row = [
    c.timestamp, c.status ?? 'completed', c.companies, c.boards, c.found,
    c.filteredTitle, c.filteredTier, c.filteredLocation, c.filteredPostingAge,
    c.filteredSalary, c.filteredContent, c.filteredCooldown, c.dupes, c.newAdded, c.errors,
    // filtered_blacklist (#1742) appended at the END, per the header-name
    // contract above: files created with an older header keep parsing (the
    // extra trailing cell is simply not named there).
    c.filteredBlacklist ?? 0,
    // filtered_visa appended at the END for the same reason.
    c.filteredVisa ?? 0,
    // filtered_posted_date appended at the END for the same reason.
    c.filteredPostedDate ?? 0,
    // filtered_country_eligibility (#2093) appended at the END for the same reason.
    c.filteredCountryEligibility ?? 0,
  ].join('\t') + '\n';
  appendFileSync(filePath, row, 'utf-8');
}

// ── Per-source ledger ───────────────────────────────────────────────
//
// The run summary above is one row per RUN, so "twenty-one sources are
// configured" and "twenty-one sources were read" look identical from the
// outside. The ledger below is the same arithmetic kept per source, so a board
// that has gone quiet, a board that errored and a board whose every row failed
// one filter are three different lines instead of one total.
//
// It is bookkeeping on paths that already exist: every call sits beside the
// run total it mirrors, so a new drop reason cannot be counted in one place
// and missed in the other. reconcileSourceLedger() is the assertion that says
// so, and it runs on every real scan, not only in the suite.

// Drop reasons in SWEEP ORDER — the order the filters actually run in, so a
// line reads like the journey a posting took. Each carries the label printed
// in the terminal and written to the log.
export const SOURCE_DROP_REASONS = [
  { key: 'blacklist', label: 'blacklist' },
  { key: 'title', label: 'title' },
  { key: 'tier', label: 'tier' },
  { key: 'location', label: 'location' },
  { key: 'age', label: 'age' },
  { key: 'postedDate', label: 'posted date' },
  { key: 'salary', label: 'salary' },
  // The reader runs here, between the free filters and the three that read the
  // advert. A posting whose own board page says it is gone is dropped rather
  // than passed on with an empty description.
  { key: 'advertExpired', label: 'advert expired' },
  { key: 'content', label: 'content' },
  { key: 'countryEligibility', label: 'country' },
  { key: 'visa', label: 'visa' },
  { key: 'duplicate', label: 'duplicate' },
  { key: 'cooldown', label: 'cooldown' },
  // The fit judgement (ticket D2b) runs last in the sweep, after the route, and
  // counts here only when its SKIP switch is on and the row left the queue.
  { key: 'fit', label: 'fit' },
  // Not a sweep filter — --verify runs after the sweep and drops postings
  // whose page is gone, has no Apply control, or failed the URL guard.
  { key: 'expired', label: 'expired' },
];

const SOURCE_DROP_KEYS = new Set(SOURCE_DROP_REASONS.map((r) => r.key));

// Its own file, not extra columns on scan-runs.tsv: that file is one row per
// run and its header is guarded by a drift test other modules read, so
// widening it would break a contract for a different shape of data. The
// timestamp is the same string the run-summary row carries, so the two join.
export const SCAN_SOURCES_PATH = process.env.CAREER_OPS_SCAN_SOURCES
  || path.join(DATA_ROOT, 'data/scan-sources.tsv');
export const SCAN_SOURCES_HEADER = 'timestamp\tsource\tkind\tpaid\tstatus\tfound\tkept\tdropped\tdrop_reasons\tdetail\n';

/**
 * One record per source for the current run. Registration is separate from
 * counting on purpose: a source that errors, or that no provider matched, has
 * a line of its own rather than vanishing from the list.
 */
export function createSourceLedger() {
  /** @type {Map<string, any>} */
  const records = new Map();

  const get = (name) => {
    const record = records.get(name);
    if (!record) throw new Error(`source ledger: "${name}" was never registered`);
    return record;
  };

  return {
    register(name, { kind = 'company', paid = false } = {}) {
      let record = records.get(name);
      if (!record) {
        record = {
          name, kind, paid, status: null, detail: '',
          found: 0, kept: 0, dropped: 0, reasons: {},
        };
        records.set(name, record);
      }
      return record;
    },
    /** Mark what the source is, once the provider that will read it is known. */
    describe(name, { kind, paid } = {}) {
      const record = get(name);
      if (kind !== undefined) record.kind = kind;
      if (paid !== undefined) record.paid = paid;
      return record;
    },
    found(name, count) {
      get(name).found += count;
    },
    keep(name) {
      get(name).kept += 1;
    },
    /**
     * Take back a keep. --verify runs after the sweep, so a posting is
     * counted as kept and then removed; without this, per-source kept would
     * stay at the pre-verify count and disagree with what reached the
     * pipeline. Always paired with a drop, so the row still balances.
     */
    unkeep(name) {
      const record = get(name);
      if (record.kept > 0) record.kept -= 1;
    },
    drop(name, reasonKey) {
      if (!SOURCE_DROP_KEYS.has(reasonKey)) {
        throw new Error(`source ledger: unknown drop reason "${reasonKey}"`);
      }
      const record = get(name);
      record.dropped += 1;
      record.reasons[reasonKey] = (record.reasons[reasonKey] || 0) + 1;
    },
    error(name, message) {
      const record = get(name);
      record.status = 'error';
      // Collapsed to one line: a child process's stderr arrives inside the
      // message, and a newline mid-detail breaks the column the eye reads down.
      record.detail = String(message || 'unknown error').replace(/\s+/g, ' ').trim();
    },
    /**
     * The source returned postings, but not the way it should have — today
     * that means a local parser failed and the API fallback carried the fetch.
     * Its counts are real, so the line keeps them; a plain 'ok' would hide a
     * broken parser behind a working one.
     */
    degraded(name, message) {
      const record = get(name);
      record.status = 'degraded';
      record.detail = String(message || 'degraded').replace(/\s+/g, ' ').trim();
    },
    skipped(name, message) {
      const record = get(name);
      record.status = 'skipped';
      record.detail = String(message || 'no provider matched');
    },
    /** One record, status resolved. Used to print a source's line the moment it finishes. */
    record(name) {
      const r = get(name);
      return { ...r, status: r.status || (r.found === 0 ? 'empty' : 'ok') };
    },
    /** Registration order, with the status resolved for anything not already set. */
    records() {
      return [...records.values()].map((r) => ({
        ...r,
        status: r.status || (r.found === 0 ? 'empty' : 'ok'),
      }));
    },
  };
}

/**
 * The per-source totals must sum to the run totals. This is the check that
 * catches a future drop reason added to the run counters and forgotten in the
 * breakdown — the failure mode the ledger exists to prevent.
 *
 * @param {ReturnType<createSourceLedger>} ledger
 * @param {Record<string, number>} runTotals - found, kept and one key per drop reason
 * @returns {Array<{field: string, ledger: number, run: number}>} named mismatches; empty when they agree
 */
export function reconcileSourceLedger(ledger, runTotals) {
  const records = ledger.records();
  const sum = (fn) => records.reduce((total, r) => total + fn(r), 0);
  const mismatches = [];
  const check = (field, ledgerValue) => {
    const runValue = runTotals[field] ?? 0;
    if (ledgerValue !== runValue) mismatches.push({ field, ledger: ledgerValue, run: runValue });
  };
  check('found', sum((r) => r.found));
  check('kept', sum((r) => r.kept));
  for (const { key } of SOURCE_DROP_REASONS) {
    check(key, sum((r) => r.reasons[key] || 0));
  }
  return mismatches;
}

/**
 * One terminal line for one source. Presentation only — column padding will
 * change, so nothing asserts on the exact spacing, only on the fields.
 */
export function formatSourceLine(record) {
  const name = String(record.name).padEnd(24);
  const paid = record.paid ? '  [paid]' : '';
  if (record.status === 'error') return `${name}${'ERROR'.padEnd(11)}${record.detail}${paid}`;
  if (record.status === 'skipped') return `${name}${'SKIPPED'.padEnd(11)}${record.detail}${paid}`;
  const reasons = SOURCE_DROP_REASONS
    .filter(({ key }) => record.reasons[key])
    .map(({ key, label }) => `${label} ${record.reasons[key]}`)
    .join(', ');
  const detail = reasons ? `(${reasons})` : (record.found === 0 ? '(no postings returned)' : '');
  const dropped = record.dropped > 0 ? `dropped ${record.dropped}` : '—';
  // A degraded source keeps its counts — they are real — and says what is
  // wrong after them, so a broken local parser cannot hide behind the API
  // fallback that rescued it.
  const degraded = record.status === 'degraded' ? `  DEGRADED: ${record.detail}` : '';
  return (
    name
    + `found ${record.found}`.padEnd(11)
    + `kept ${record.kept}`.padEnd(10)
    + dropped.padEnd(12)
    + detail.padEnd(paid || degraded ? 30 : 0)
    + paid
    + degraded
  ).trimEnd();
}

/**
 * Append one row per source for this run. The header is written once, when the
 * file is created.
 *
 * @param {Array<object>} records - from ledger.records()
 * @param {string} timestamp - the SAME string the run-summary row carries
 * @param {string} [filePath]
 */
export function appendScanSources(records, timestamp, filePath = SCAN_SOURCES_PATH) {
  if (!Array.isArray(records) || records.length === 0) return;
  mkdirSync(path.dirname(filePath), { recursive: true });
  if (!existsSync(filePath)) atomicWriteFile(filePath, SCAN_SOURCES_HEADER);
  let lines = '';
  for (const r of records) {
    const reasons = SOURCE_DROP_REASONS
      .filter(({ key }) => r.reasons[key])
      .map(({ key, label }) => `${label}=${r.reasons[key]}`)
      .join(' ');
    lines += [
      timestamp,
      sanitizeTsvField(r.name),
      r.kind,
      r.paid ? 'paid' : 'free',
      r.status,
      r.found,
      r.kept,
      r.dropped,
      reasons,
      sanitizeTsvField(r.detail),
    ].join('\t') + '\n';
  }
  appendFileSync(filePath, lines, 'utf-8');
}

/**
 * The previous run's rows in the per-source log, keyed by source name. The
 * last run is the block of rows carrying the file's last timestamp.
 *
 * @param {string} [filePath]
 * @returns {Map<string, {paid: boolean, found: number}>} empty when there is no log
 */
export function readLastRunSources(filePath = SCAN_SOURCES_PATH) {
  const rows = new Map();
  if (!existsSync(filePath)) return rows;
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  let last = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cols = lines[i].split('\t');
    if (cols[0] === 'timestamp') break;
    if (last === null) last = cols[0];
    if (cols[0] !== last) break;
    rows.set(cols[1], { paid: cols[3] === 'paid', found: Number(cols[5]) });
  }
  return rows;
}

/**
 * One warning per paid feed that found nothing on this run and on the last.
 * A paid feed can go quiet for days while its reader reports success (Indeed,
 * 19 to 21 September 2026), and one empty run is normal, so it takes two.
 *
 * @param {Array<object>} records - from ledger.records()
 * @param {Map<string, {paid: boolean, found: number}>} previous - from readLastRunSources
 * @returns {string[]}
 */
export function emptyPaidFeedWarnings(records, previous) {
  return records
    .filter((r) => r.paid && r.found === 0)
    .filter((r) => {
      const before = previous.get(sanitizeTsvField(r.name));
      return before && before.paid && before.found === 0;
    })
    .map((r) => `WARNING: ${r.name} empty two runs running`);
}

// ── Portal health persistence (#1744) ───────────────────────────────

// Anchored to the data root (#3510), read by stats.mjs:39 at the same anchor.
//
// This path has moved twice. It was dirname(fileURLToPath(import.meta.url)) —
// the script's own directory — until 96c578b made it cwd-relative, because a
// sandboxed run was writing fixture rows into the live data/portal-health.tsv of
// whatever checkout owned scan.mjs. That problem was real; the mechanism traded
// one unanchored path for another, and left this file with two different rules
// for where user data lives. Isolation now comes from CAREER_OPS_ROOT, which is
// how the rest of the suite already sandboxes writes — see
// tests/portal-health-path.test.mjs, which still asserts the checkout's own data
// directory is never touched.
const PORTAL_HEALTH_PATH = path.join(DATA_ROOT, 'data/portal-health.tsv');
export const PORTAL_HEALTH_HEADER = 'timestamp\tcompany\tstatus\n';

// Locked (portal-health-lock.mjs) so a concurrent read-modify-write of this
// same file — e.g. tests/portal-health-guard.mjs's regression-cleanup path —
// can never interleave with this append and silently discard one side.
export async function appendPortalHealth(healthRecords, filePath = PORTAL_HEALTH_PATH) {
  await withPortalHealthLock(filePath, async () => {
    mkdirSync(path.dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) atomicWriteFile(filePath, PORTAL_HEALTH_HEADER);
    let lines = '';
    for (const r of healthRecords) {
      lines += [r.timestamp, r.company, r.status].join('\t') + '\n';
    }
    if (lines) appendFileSync(filePath, lines, 'utf-8');
  });
}

export function loadPortalHealth(filePath = PORTAL_HEALTH_PATH) {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      records.push({ timestamp: parts[0], company: parts[1], status: parts[2] });
    }
  }
  return records;
}

export function computeConsecutiveFailures(healthRecords) {
  const streaks = new Map();
  for (const r of healthRecords) {
    // Healthy statuses reset the streak; every other status counts toward it.
    // Inverted (vs. listing failure statuses) so the newer error kinds
    // (auth/server/unknown) can't silently fall outside the streak again.
    // 'empty' is deliberately healthy: a live board with 0 jobs is reachable.
    if (r.status === 'reachable' || r.status === 'empty') {
      streaks.set(r.company, 0);
    } else {
      streaks.set(r.company, (streaks.get(r.company) || 0) + 1);
    }
  }
  return streaks;
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function verifyOffers(offers, { headedFallback = false, throttleBaseMs = 0, rediscover = false } = {}) {
  // Dynamic imports keep the default zero-token path free of Playwright startup
  let chromium;
  let checkUrlLiveness;
  let checkUrlLivenessWithFallback;
  let createHeadedPageProvider;
  let newLivenessPage;
  let jitteredDelayMs;
  let sleep;
  try {
    ({ chromium } = await import('playwright'));
    ({ checkUrlLiveness, checkUrlLivenessWithFallback, createHeadedPageProvider, newLivenessPage, jitteredDelayMs, sleep } = await import('./liveness-browser.mjs'));
  } catch (err) {
    throw new Error(
      `--verify requires Playwright with Chromium (run "npx playwright install chromium"): ${err.message}`,
      { cause: err },
    );
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    throw new Error(
      `--verify could not launch Chromium (run "npx playwright install chromium" or re-run without --verify): ${err.message}`,
      { cause: err },
    );
  }

  // Three permanent buckets + one transient passthrough:
  //   verified  → active pages and transient nav errors (retry next scan)
  //   expired   → classifier-confirmed dead postings (HTTP 4xx, redirect markers,
  //               body patterns, listing pages, insufficient content)
  //   dropped   → page loaded but classifier saw no Apply control. --verify is an
  //               opt-in stricter filter; keeping these defeats the purpose.
  //   invalid   → up-front URL guard rejections (malformed / non-http / private)
  const verified = [];
  const expired = [];
  const dropped = [];
  const invalid = [];
  const migrated = [];

  const headed = headedFallback ? createHeadedPageProvider(chromium) : null;
  const getHeadedPage = headed ? () => headed.get() : undefined;

  try {
    const page = await newLivenessPage(browser);
    // Sequential — project rule: never Playwright in parallel
    for (let i = 0; i < offers.length; i++) {
      const offer = offers[i];
      const { result, code, reason } = headed
        ? await checkUrlLivenessWithFallback(page, offer.url, { getHeadedPage })
        : await checkUrlLiveness(page, offer.url);
      if (result === 'expired') {
        // 404/410 on a tracked company may just be a moved role — run one
        // search + re-verify before giving up (opt-in via --rediscover-404).
        // Only http_gone (HTTP 404/410) qualifies; soft-expiry signals
        // (redirect/body/listing) are real closures, not URL moves.
        if (rediscover && code === 'http_gone' && offer.tracked && offer.careersUrlDomain) {
          const newUrl = await searchForNewUrl(page, offer);
          if (newUrl) {
            // Mirror the primary check: without the headed fallback, a
            // challenge-prone domain would flag the rediscovered URL as
            // expired just because the recheck hit the same anti-bot wall.
            const recheck = headed
              ? await checkUrlLivenessWithFallback(page, newUrl, { getHeadedPage })
              : await checkUrlLiveness(page, newUrl);
            // Require a *confirmed* live page before migrating. A transient
            // 'uncertain' (timeout/DNS/5xx) must not commit an unverified URL —
            // fall through to expired (the original 404/410 is a real closure).
            if (recheck.result === 'active') {
              migrated.push({ ...offer, url: newUrl, previousUrl: offer.url });
              console.log(`  🔄 migrated  ${offer.company} | ${offer.title} → ${newUrl}`);
              continue;
            }
          }
        }
        expired.push({ ...offer, reason });
        console.log(`  ❌ expired   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && GUARD_CODES.has(code)) {
        // Guard failures are permanent (not transient like a timeout) — record them
        // separately so they don't end up in pipeline.md but DO appear in scan-history
        // with a precise status, dedup-blocking them on subsequent scans.
        invalid.push({ ...offer, code, reason });
        console.log(`  ⛔ invalid   ${offer.company} | ${offer.title} (${reason})`);
      } else if (result === 'uncertain' && code === 'no_apply_control') {
        // Page loaded but classifier could not find an Apply control. Treat like
        // expired for routing — drop from pipeline AND record in scan-history so
        // we don't burn a verify cycle on the same URL next scan.
        dropped.push({ ...offer, reason });
        console.log(`  ⚠️ no-apply  ${offer.company} | ${offer.title} (${reason})`);
      } else {
        // 'active' or 'uncertain' due to navigation_error (transient — retry next scan)
        verified.push(offer);
        const icon = result === 'active' ? '✅' : '⚠️';
        console.log(`  ${icon} ${result.padEnd(9)} ${offer.company} | ${offer.title}`);
      }

      const wait = i < offers.length - 1 ? jitteredDelayMs(throttleBaseMs) : 0;
      if (wait) await sleep(wait);
    }
  } finally {
    if (headed) await headed.close();
    await browser.close();
  }

  return { verified, expired, dropped, invalid, migrated };
}

// Stable codes from liveness-browser's up-front URL guard. Routing dispatches
// on these codes (not on regex over reason strings) so wording can change
// without breaking the pipeline.
const GUARD_CODES = new Set(['invalid_url', 'unsupported_protocol', 'blocked_host']);

// guardStatusFor maps a guard code to the canonical scan-history status string.
function guardStatusFor(code) {
  if (code === 'blocked_host') return 'skipped_blocked_host';
  // invalid_url and unsupported_protocol both surface as malformed input
  return 'skipped_invalid_url';
}

// ── CLI args ────────────────────────────────────────────────────────
// #2270: `node scan.mjs --help` used to run a full live scan and write to
// pipeline.md/scan-history.tsv instead of printing usage — the flag was
// never checked at all. Same shape as scan-ats-full.mjs (#1633/#1635),
// reply-watch.mjs (#2743/#2745) and dedup-tracker.mjs (#2744/#2746), shared
// via lib/cli-flags.mjs's validateFlags() (#2775).
const KNOWN_FLAGS = [
  '--dry-run', '--verify', '--headed-fallback', '--throttle', '--rediscover-404',
  '--include-blacklisted', '--company', '--posted-after', '--posted-before',
  '--since', '--quiet', '--json', '--help', '-h', '--source-log',
  '--read-pipeline', '--reread', '--gate',
];

// Flags whose space-separated value is the NEXT argv token (the `--flag=value`
// form is self-contained and never needs this). --throttle is deliberately
// excluded: only its bare and `--throttle=<ms>` forms are read below, so a
// following token is never its value.
const VALUE_FLAGS = ['--company', '--posted-after', '--posted-before', '--since', '--source-log'];

const USAGE = `Usage:
  node scan.mjs                              # scan all enabled companies
  node scan.mjs --dry-run                    # preview without writing files
  node scan.mjs --company Cohere             # scan a single company
  node scan.mjs --verify                     # Playwright-check each new URL; drop expired postings
  node scan.mjs --verify --headed-fallback   # retry anti-bot-blocked URLs in a headed browser (needs a display)
  node scan.mjs --verify --throttle          # jittered ~5-10s gap between checks (stay under rate limits)
  node scan.mjs --verify --throttle=8000     # custom base gap in ms (waits base..2*base)
  node scan.mjs --rediscover-404             # re-verify tracked URLs that 404/410 (rides on --verify)
  node scan.mjs --include-blacklisted        # let data/blacklist.md matches through (annotated)
  node scan.mjs --since 7                    # postings from the last 7 days
  node scan.mjs --posted-after 2026-07-01    # absolute lower bound on posting date
  node scan.mjs --posted-before 2026-08-01   # absolute upper bound on posting date
  node scan.mjs --source-log <path>          # write the per-source rows here instead of data/scan-sources.tsv
  node scan.mjs --read-pipeline              # read the adverts of the rows already queued, and label them
  node scan.mjs --reread                     # re-read a stored advert that was not read the first time
  node scan.mjs --read-pipeline --gate       # also filter, dedup against the tracker, and label each row's route
  node scan.mjs --json                       # emit one machine-readable receipt on stdout
  node scan.mjs --quiet                      # suppress the manifesto footer
  node scan.mjs --help                       # print this usage block and exit`;

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });
  const dryRun = args.includes('--dry-run');
  const jsonMode = args.includes('--json');
  if (jsonMode) console.log = console.error.bind(console);
  const verify = args.includes('--verify');
  // Opt-in: on an anti-bot challenge (e.g. pracuj.pl Cloudflare wall), retry the
  // URL in a headed browser. Off by default — headed Chromium needs a display, so
  // scheduled/unattended scans should not rely on it.
  const headedFallback = args.includes('--headed-fallback');
  // --throttle or --throttle=<ms>: jittered gap between --verify checks to stay
  // under rate-based WAF limits (pracuj.pl flags the session after a few rapid
  // hits). Default base 5000ms. Off by default — most ATS feeds don't need it.
  const throttleArg = args.find((a) => a === '--throttle' || a.startsWith('--throttle='));
  const throttleBaseMs = throttleArg ? (Number(throttleArg.split('=')[1]) || 5000) : 0;
  // --rediscover-404: when a tracked company's URL 404/410s, search for the
  // moved role and re-verify before marking it expired. Opt-in; rides on --verify.
  const rediscover = args.includes('--rediscover-404');
  // --include-blacklisted: bypass the data/blacklist.md filter for auditing.
  // Matching postings flow through annotated instead of being counted out.
  const includeBlacklisted = args.includes('--include-blacklisted');
  // flagValue reads both `--flag value` and `--flag=value`; a bare indexOf misses
  // the second form entirely and silently falls back to the unfiltered default.
  //
  // flagValue alone cannot tell an ABSENT flag from one passed with no operand —
  // both give undefined — so it is paired with hasFlag, per cli-flags.mjs's own
  // guidance. Without that, a trailing `--posted-after` would fall back to "no
  // bound" and scan everything: the same silent-default failure this fixes.
  const requireValue = (flag) => {
    const value = flagValue(args, flag);
    if (value === undefined || value === '') {
      if (hasFlag(args, flag)) {
        console.error(`Error: ${flag} requires a value`);
        process.exit(1);
      }
      return null;
    }
    return value;
  };
  const filterCompany = requireValue('--company')?.toLowerCase() ?? null;
  // --source-log <path>: where the per-source rows go. The double-click file
  // passes a fixed path outside the checkout, because $TMPDIR differs between
  // a sandboxed and an unsandboxed shell and a log written by one is not the
  // log read by the other.
  const sourceLogPath = requireValue('--source-log') ?? SCAN_SOURCES_PATH;
  // --posted-after / --posted-before <YYYY-MM-DD>: absolute-date bounds on the
  // employer's real posting date (job.postedAt), gated against a typo since a
  // silently-ignored bound would look like "no jobs matched" instead of an error.
  const isValidIsoDate = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  const postedAfter = requireValue('--posted-after');
  const postedBefore = requireValue('--posted-before');
  if (postedAfter != null && !isValidIsoDate(postedAfter)) {
    console.error(`Error: --posted-after expects YYYY-MM-DD, got "${postedAfter}"`);
    process.exit(1);
  }
  if (postedBefore != null && !isValidIsoDate(postedBefore)) {
    console.error(`Error: --posted-before expects YYYY-MM-DD, got "${postedBefore}"`);
    process.exit(1);
  }

  // --since <days>: a RELATIVE lower bound on the employer's posting date —
  // the same thing --posted-after expresses absolutely, and it filters exactly
  // like it does. Matches scan-ats-full.mjs, which has always treated --since
  // as a filter; one flag name should not mean two different things.
  //
  // It additionally unlocks an optimisation. providers/workday.mjs returns
  // postings newest-first and can stop paginating once a page is entirely past
  // the window, but that only fires when ctx carries sinceMs — and scan.mjs
  // built a bare makeHttpCtx(), so every Workday tenant paginated to its
  // max_pages cap on every run however stale the deep pages were.
  //
  // Flag presence, operand validity, duplicate occurrences and the
  // out-of-Date-range case are all handled by the SHARED parseSinceDays(), so
  // scan-ats-full.mjs cannot disagree about what --since means (#2498).
  const since = parseSinceDays(args);
  if (since.error) {
    console.error(`Error: ${since.error}`);
    process.exit(1);
  }
  const sinceDays = since.days;

  const effectiveAfter = resolveEffectiveAfter(postedAfter, sinceDays);

  // 1. Load providers
  const providers = await loadProviders(PROVIDERS_DIR);
  // Opt-in: merge enabled keyed/auth-gated provider plugins. Returns immediately
  // (no discovery, no dotenv, no process.env mutation) when config/plugins.yml is
  // absent — so a plain scan with no plugins configured stays byte-identical.
  await mergeProviderPlugins(providers, { root: path.dirname(PROVIDERS_DIR) });
  if (providers.size === 0) {
    console.error('Error: no providers loaded from providers/');
    process.exit(1);
  }

  // 2. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  let rawConfig;
  try {
    rawConfig = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Error: failed to parse ${PORTALS_PATH}: ${err.message}`);
    process.exit(1);
  }
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

  // --read-pipeline: read and label the rows already in the queue, and stop.
  // No board is touched. This is how the roles queued before the reader existed
  // get the same treatment as tomorrow's scan. Running it over the real queue is
  // Stelios's button, from a terminal.
  if (args.includes('--read-pipeline')) {
    const reader = buildAdvertReader({ config, reread: args.includes('--reread') });
    // --gate (ticket B2) adds the three advert filters, the tracker dedup and
    // the route label to the same pass. Without it the pass only reads and
    // labels with jd:, exactly as B1 shipped it.
    const gating = args.includes('--gate');
    const candidateCountryForGate = gating ? loadCandidateCountry() : '';
    const canonicalizeCompanyForGate = buildCompanyCanonicalizer(config.company_aliases);
    const gate = gating
      ? buildAdvertGate({
        contentFilter: buildContentFilter(config.content_filter),
        countryEligibilityFilter: buildCountryEligibilityFilter(config.country_eligibility_filter, candidateCountryForGate),
        visaFilter: buildVisaFilter(config.visa_filter),
        explain: buildDropExplainer(config, candidateCountryForGate),
      })
      : null;
    console.log(`Reading the adverts of the rows already queued in ${PIPELINE_PATH} …`);
    if (gating) console.log(`Gating against ${APPLICATIONS_PATH} and ${TIERS_PATH}, both read-only.`);
    const counts = await readPipelineAdverts({
      reread: args.includes('--reread'),
      gate,
      tiersTable: gating ? loadTiersTable(TIERS_PATH) : null,
      trackerIndex: gating
        ? loadTrackerDedupIndex({ trackerPath: APPLICATIONS_PATH, canonicalize: canonicalizeCompanyForGate })
        : null,
      canonicalizeCompany: canonicalizeCompanyForGate,
      titleFilterConfig: config.title_filter,
      readEntry: async (entry) => {
        const outcome = await reader.read(entry);
        console.log(`  ${outcome.status === 'read' ? '✅' : '⚠️ '} ${outcome.status.padEnd(11)} ${entry.company || '?'} | ${entry.title || '?'}`);
        return outcome;
      },
    });
    console.log('');
    for (const line of formatReadSummary(reader.tally, { firecrawlEnabled: reader.firecrawlEnabled })) {
      console.log(line);
    }
    for (const line of formatRecheckSummary(counts)) {
      console.log(line);
    }
    if (gating) {
      if (counts.duplicates > 0) {
        console.log(`Already tracked:       ${counts.duplicates} moved to Processed`);
      }
      for (const line of formatGateSummary(counts.drops, counts.routed)) {
        console.log(line);
      }
      for (const row of counts.duplicateRows) {
        console.log(`DUPE | ${row.company || '?'} | ${row.title || '?'} | tracker row ${row.row} (${row.key}) | ${row.url || row.company}`);
      }
      for (const row of counts.drops.rows) {
        console.log(formatAdvertDropRow(row));
      }
    }
    for (const row of reader.tally.unreadableRows) {
      console.log(formatUnreadableRow(row));
    }
    return;
  }

  const companies = Array.isArray(config.tracked_companies) ? config.tracked_companies : [];
  const boards = Array.isArray(config.job_boards) ? config.job_boards : [];
  const titleFilter = buildTitleFilter(config.title_filter);

  // Seniority tier classifier integration
  let classifyTier = null;
  const skipTiers = Array.isArray(config.skip_tiers)
    ? config.skip_tiers.filter(t => typeof t === 'string').map(t => t.toLowerCase())
    : [];
  if (skipTiers.length > 0) {
    const mod = await import('./classify-tier.mjs');
    classifyTier = mod.classifyTier || mod.default;
  }

  const locationFilter = buildLocationFilter(config.location_filter);
  const postingAgeFilter = buildPostingAgeFilter(config.max_posting_age_days);
  const postedDateFilter = buildPostedDateFilter(effectiveAfter, postedBefore);

  // Same bound the filter above uses, widened by max_posting_age_days when set.
  // Derived by the same helper so the hint and the filter cannot disagree.
  const earlyStopSinceMs = resolveEarlyStopMs(effectiveAfter, config.max_posting_age_days);
  const salaryFilter = buildSalaryFilter(config.salary_filter);
  const trustValidator = buildTrustValidator(config.trust_filter);
  const contentFilter = buildContentFilter(config.content_filter);
  const candidateCountry = loadCandidateCountry();
  const countryEligibilityFilter = buildCountryEligibilityFilter(config.country_eligibility_filter, candidateCountry);
  const visaFilter = buildVisaFilter(config.visa_filter);
  // Ticket B1: the reader that fills job.description before the three filters
  // above can read it. Built here so one tally serves the whole run.
  const advertReader = buildAdvertReader({ config, reread: args.includes('--reread') });
  // Ticket B2: the gate the filled description meets, the drop tally that names
  // each drop, the tier table and the route tally. The tier table is
  // data/companies.tsv, the Tiers chat's file: read, never written, and a
  // company it does not name is untiered rather than an error.
  const advertGate = buildAdvertGate({
    contentFilter,
    countryEligibilityFilter,
    visaFilter,
    explain: buildDropExplainer(config, candidateCountry),
  });
  const advertDrops = emptyAdvertDropTally();
  const tiersTable = loadTiersTable(TIERS_PATH);
  const routeTally = emptyRouteTally();
  const visaEnabled = Boolean(config.visa_filter) && config.visa_filter.enabled !== false;

  // 3. Resolve a provider for each enabled company / board
  const targets = [];
  // One record per enabled source, registered here rather than in the sweep so
  // that a source no provider matched, and one whose config is broken, each get
  // a line of their own. Silence is never the same as absence.
  const sourceLedger = createSourceLedger();
  // Offer URL → the source that produced it, so --verify's drops can be
  // attributed after the sweep's own scope is gone.
  const sourceByOfferUrl = new Map();
  let skippedCount = 0;
  let boardCount = 0;
  const resolveErrors = [];
  const agentHandoff = [];

  /**
   * Processes a list of configuration entries, resolves their appropriate data providers,
   * and appends valid entries to the global scanning targets list.
   * @param {Array<{ name?: string, enabled?: boolean, [key: string]: unknown }>} entries - List of entries.
   * @param {{ isBoard?: boolean }} [options={}] - Configuration options.
   */
  function resolveEntries(entries, { isBoard = false } = {}) {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.enabled === false) continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) {
        console.error(`⚠️  Skipping entry — missing or non-string 'name' field: ${JSON.stringify(entry)}`);
        continue;
      }
      if (filterCompany && !entry.name.toLowerCase().includes(filterCompany)) continue;

      const kind = isBoard ? 'board' : 'company';
      sourceLedger.register(entry.name, { kind });

      const resolved = resolveProvider(entry, providers);
      if (!resolved) {
        skippedCount++;
        sourceLedger.skipped(entry.name, 'no provider matched');
        if (entry.scan_method === 'websearch') {
          agentHandoff.push({
            company: entry.name,
            method: 'websearch',
            query: entry.scan_query || entry.search_query || entry.careers_url || '',
          });
        }
        continue;
      }

      if (resolved.error) {
        resolveErrors.push({ company: entry.name, error: resolved.error });
        sourceLedger.error(entry.name, resolved.error);
        continue;
      }

      // The paid marker is derived, never configured: a source read through the
      // apify plugin is one that spends money, so the yield and the spend show
      // up in the same glance.
      sourceLedger.describe(entry.name, { paid: resolved.provider.id === 'apify' });
      targets.push({ ...entry, _provider: resolved.provider, _isBoard: isBoard });
      if (isBoard) boardCount++;
    }
  }

  resolveEntries(companies);
  resolveEntries(boards, { isBoard: true });

  const localParserCount = targets.filter(t => t._provider.id === 'local-parser').length;
  const companyCount = targets.length - boardCount;
  const parts = [`${companyCount} companies`];
  if (boardCount > 0) parts.push(`${boardCount} job boards`);
  parts.push(`${localParserCount} local parser`);
  parts.push(`${skippedCount} skipped — no provider matched`);
  console.log(`Scanning ${parts.join('; ')} via providers`);
  if (dryRun) console.log('(dry run — no files will be written)');

  // One line per source, printed as each finishes. The sources nothing could
  // read are settled already, so they lead — a board with a broken entry is
  // visible before the sweep rather than missing from the list afterwards.
  console.log('\nSources:');
  for (const record of sourceLedger.records()) {
    if (record.status === 'skipped' || record.status === 'error') {
      console.log(formatSourceLine(record));
    }
  }

  // 3.5. Load the user's do-not-apply list (#1742). Opt-in: absent file =
  // empty Map = the filter below never fires.
  const blacklist = loadBlacklist();

  // 4. Load dedup sets — one read per source file for the whole run (#2382).
  const historyPolicy = scanHistoryPolicy(config);
  const canonicalizeCompany = buildCompanyCanonicalizer(config.company_aliases);
  const dedupSnapshot = loadDedupSnapshot(historyPolicy, canonicalizeCompany);
  const seenUrls = dedupSnapshot.seen;
  const seenCompanyRoles = dedupSnapshot.seenCompanyRoles;

  // 4.5. The fit judgement (ticket D2b). Off unless config/profile.yml says
  // `fit_gate: enabled: true`; with it off nothing below calls a model and the
  // run prints and writes exactly what it did before.
  const fitSettings = readFitGateSettings(PROFILE_PATH, { root: DATA_ROOT });
  const fitGate = fitSettings.enabled ? buildFitGate(fitSettings, { canonicalize: canonicalizeCompany }) : null;
  if (fitGate) {
    console.log(`Fit gate on: ${fitSettings.model}, effort ${fitSettings.effort}, SKIP switch ${fitSettings.skip ? 'on' : 'off'}, at most ${fitSettings.maxRows} rows and ${Math.round(fitSettings.budgetMs / 60_000)} min`);
  }
  let totalFilteredFit = 0;
  const fitSkippedOffers = [];

  // 5. Fetch from each target
  // LOCAL day. This one value does two things that both care which day it is:
  // it is the `today` buildCooldownFilter compares against, and it is the
  // firstSeen date written into scan-history.tsv. On the UTC day a
  // west-of-Greenwich evening scan opened cooldowns early AND stamped history
  // rows with tomorrow, which then read one day old on the next recheck (#3070).
  const date = localToday();
  const windows = loadReApplyWindows();
  const cooldownFilter = buildCooldownFilter(windows, date);
  let totalFilteredCooldown = 0;
  const cooldownOffers = [];
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredTier = 0;
  let totalFilteredLocation = 0;
  let totalFilteredPostingAge = 0;
  let totalFilteredPostedDate = 0;
  let totalFilteredSalary = 0;
  let totalFilteredAdvertExpired = 0;
  let totalFilteredContent = 0;
  let totalFilteredCountryEligibility = 0;
  let totalFilteredBlacklist = 0;
  let annotatedBlacklisted = 0;
  let totalFilteredVisa = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [...resolveErrors];
  const emptyTargets = [];

  // Arm the failure-path row (#2643) now that the sweep is about to start and
  // every counter it reads is in scope. new_added is hardcoded 0 on a failed
  // run even if the sweep added postings before dying (the count isn't settled
  // mid-sweep). Excluded from trend averages so it can't skew them, but a
  // raw-TSV reader should treat that 0 as a sentinel, not a true count.
  if (!dryRun) {
    registerRunFailureSnapshot(() => ({
      timestamp: new Date().toISOString(),
      companies: targets.filter(t => !t._isBoard).length,
      boards: targets.filter(t => t._isBoard).length,
      found: totalFound, filteredTitle: totalFilteredTitle, filteredTier: totalFilteredTier,
      filteredLocation: totalFilteredLocation, filteredPostingAge: totalFilteredPostingAge,
      filteredSalary: totalFilteredSalary, filteredContent: totalFilteredContent + totalFilteredFit,
      filteredCooldown: totalFilteredCooldown, dupes: totalDupes, newAdded: 0,
      errors: errors.length, filteredBlacklist: totalFilteredBlacklist,
      filteredVisa: totalFilteredVisa, filteredPostedDate: totalFilteredPostedDate,
      filteredCountryEligibility: totalFilteredCountryEligibility,
    }), (timestamp) => appendScanSources(sourceLedger.records(), timestamp, sourceLogPath));
    // Ctrl-C mid-sweep is the common abort. Best effort: record, then die
    // with the conventional SIGINT code.
    process.once('SIGINT', () => {
      writeRunFailureRow('failed');
      process.exit(130);
    });
  }

  const tasks = targets.map(company => async () => {
    let provider = company._provider;
    // includeUndated is deliberately ALWAYS true, independent of the window.
    // It does not mean "include undated postings in the results" — scan.mjs
    // already decides that downstream, where buildPostedDateFilter passes a
    // posting with no parseable date. It means "provider, do not pre-empt that
    // decision": without it, workday.mjs's no-date-skip returns page 0 only for
    // any tenant whose CXS payload omits postedOn entirely, silently dropping
    // postings this scanner would have kept.
    //
    // It covers the all-undated tenant, not the mixed one. workday.mjs's
    // pageIsPastWindow reads dated postings only, so on a page mixing stale
    // dated postings with undated ones the early-stop still fires and undated
    // postings on later pages go unfetched. Documented in modes/scan.md; the
    // fix belongs in workday.mjs, where closing it costs the optimisation on
    // every tenant that mixes.
    const ctx = { ...makeHttpCtx(), sinceMs: earlyStopSinceMs, includeUndated: true };
    let sourceName = provider.id === 'local-parser' ? 'local-parser' : `${provider.id}-api`;
    try {
      let jobs;
      try {
        jobs = await provider.fetch(company, ctx);
      } catch (parserErr) {
        if (provider.id !== 'local-parser') throw parserErr;
        const fallback = resolveProvider(company, providers, { skipIds: ['local-parser'] });
        if (!fallback || fallback.error) throw parserErr;
        provider = fallback.provider;
        sourceName = `${provider.id}-api`;
        jobs = await provider.fetch(company, ctx);
        errors.push({
          company: company.name,
          error: `local parser failed, used API fallback: ${parserErr.message}`,
        });
        // The fetch succeeded, so the counts below are real and the line must
        // not read as a clean run: the local parser is broken and only the API
        // fallback is keeping this source alive. Recorded as a degraded status,
        // not an error, because the postings did arrive.
        sourceLedger.degraded(company.name, `local parser failed, used ${provider.id} API fallback: ${parserErr.message}`);
      }
      if (!Array.isArray(jobs)) {
        throw new Error(`${provider.id}: fetch() did not return an array`);
      }
      totalFound += jobs.length;
      sourceLedger.found(company.name, jobs.length);
      if (!company._isBoard && jobs.length === 0) {
        emptyTargets.push(company.name);
      }

      for (const job of jobs) {
        // Trust enrichment — runs before filters, never drops
        const trustResult = trustValidator(job);
        job.trustScore = trustResult.score;
        job.trustFlags = trustResult.flags;
        job.trustLevel = trustResult.level;

        // Company blacklist (#1742) — the user's own do-not-apply decision,
        // checked first: it's company-level, not a per-posting signal. Never
        // silent: skips are counted and reported in the run summary, and
        // --include-blacklisted lets the posting through annotated instead.
        if (blacklist.size > 0) {
          const blEntry = blacklist.get(normalizeCompany(job.company || company.name || ''));
          if (blEntry) {
            if (!includeBlacklisted) {
              totalFilteredBlacklist++;
              sourceLedger.drop(company.name, 'blacklist');
              continue;
            }
            annotatedBlacklisted++;
            job.blacklisted = true;
            const label = `blacklisted${blEntry.reason ? `: ${blEntry.reason}` : ''}`;
            job.note = typeof job.note === 'string' && job.note.trim()
              ? `${label} — ${job.note}`
              : label;
          }
        }

        if (!titleFilter(job.title)) {
          totalFilteredTitle++;
          sourceLedger.drop(company.name, 'title');
          continue;
        }
        if (classifyTier && skipTiers.includes(classifyTier(job.title))) {
          totalFilteredTier++;
          sourceLedger.drop(company.name, 'tier');
          continue;
        }
        // job.title is passed so a role whose remoteness is stated in the title
        // ("Program Manager - Remote") isn't rejected for a city-only location.
        if (!locationFilter(job.location, job.url, job.title)) {
          totalFilteredLocation++;
          sourceLedger.drop(company.name, 'location');
          continue;
        }
        if (!postingAgeFilter(job.postedAt)) {
          totalFilteredPostingAge++;
          sourceLedger.drop(company.name, 'age');
          continue;
        }
        if (!postedDateFilter(job.postedAt)) {
          totalFilteredPostedDate++;
          sourceLedger.drop(company.name, 'postedDate');
          continue;
        }
        if (!salaryFilter(job.salary)) {
          totalFilteredSalary++;
          sourceLedger.drop(company.name, 'salary');
          continue;
        }
        // ── Read the advert (ticket B1) ──────────────────────────
        // The free title, tier, location, age and salary filters have cut
        // first, so the reader touches only rows that would otherwise reach the
        // queue. It fills job.description and the three filters below run
        // unchanged. A row it cannot read is kept, labelled and listed — never
        // dropped on an advert nobody read, and never passed on an empty one.
        // A row that arrived with its advert (the apify plugin's) is not
        // fetched; it is pointed at the plugin's stored file instead.
        const readOutcome = await fillJobAdvert(job, advertReader, company.name);
        if (readOutcome && advertReadDropsRow(readOutcome.status)) {
          totalFilteredAdvertExpired++;
          sourceLedger.drop(company.name, 'advertExpired');
          continue;
        }
        // ── The gate (ticket B2) ─────────────────────────────────
        // One rule, shared with the standalone pass, so the two cannot drift.
        // A row whose read status is anything but `read` is kept, labelled and
        // listed: nothing is dropped on an advert nobody read. A drop is named
        // with the phrase that dropped it and the stored file it was read from.
        const verdict = advertGate({
          description: job.description,
          matchedKeywords: matchedTitleKeywords(job.title, config.title_filter),
          readStatus: job.readStatus ?? null,
          location: job.location,
        });
        if (verdict.drop) {
          // A years drop counts as a content drop in the per-source ledger and
          // the run summary: both read the advert's text, and the ledger's keys
          // are a column in data/scan-sources.tsv that other scripts parse.
          // The DROP line and the gate summary name it as `years` on its own.
          const ledgerReason = verdict.reason === 'years' ? 'content' : verdict.reason;
          if (ledgerReason === 'content') totalFilteredContent++;
          else if (ledgerReason === 'countryEligibility') totalFilteredCountryEligibility++;
          else if (ledgerReason === 'visa') totalFilteredVisa++;
          // A town outside London counts where the free location filter's
          // drops count: same ledger key, same run total.
          else if (ledgerReason === 'location') totalFilteredLocation++;
          sourceLedger.drop(company.name, ledgerReason);
          countAdvertDrop(advertDrops, {
            company: job.company || company.name || '',
            title: job.title,
            url: job.url,
            jdPath: job.jdPath || '',
            reason: verdict.reason,
            phrase: verdict.phrase,
          });
          continue;
        }
        if (verdict.years) job.years = verdict.years;
        if (verdict.location) job.locationLabel = verdict.location;
        const dedupUrl = normalizeUrlForDedup(job.url);
        if (seenUrls.has(dedupUrl)) {
          totalDupes++;
          sourceLedger.drop(company.name, 'duplicate');
          continue;
        }
        const key = companyRoleDedupKey(job.company, job.title, canonicalizeCompany);
        if (seenCompanyRoles.has(key)) {
          totalDupes++;
          sourceLedger.drop(company.name, 'duplicate');
          continue;
        }
        const cooldownResult = cooldownFilter(job);
        if (cooldownResult.skip) {
          totalFilteredCooldown++;
          sourceLedger.drop(company.name, 'cooldown');
          cooldownOffers.push({
            job: { ...job, source: sourceName },
            status: cooldownResult.reason,
          });
          continue;
        }
        // Mark as seen to avoid intra-scan dupes
        seenUrls.add(dedupUrl);
        seenCompanyRoles.add(key);
        // Tag with the company's careers domain so verify can offer a 404/410
        // rediscovery fallback. A null domain (no careers_url) marks the offer
        // as broad-discovery — ineligible for the fallback, per the issue scope.
        const careersUrlDomain = extractCareersUrlDomain(company.careers_url);
        // The route, decided before any evaluation token is spent. It rides the
        // queue line as `route: score` or `route: standard`, or `route: review`
        // when nobody could read the advert; it never decides whether the
        // advert is read, which is free and has already happened.
        let routing = routeDetail(job.company || company.name || '', tiersTable, job.note || '', job.readStatus ?? null);
        // The fit judgement (ticket D2b), for every row about to be queued,
        // whatever its tier: the tier decides attention, not whether fit is
        // checked. A SKIP leaves the queue only with the SKIP switch on and the
        // company not under always_allow; otherwise it stays, like a REVIEW, as
        // `route: review` with the verdict on the line.
        if (fitGate) {
          const fit = await assessFit(job, fitGate, company.name);
          if (fit.verdict === 'SKIP' && !fit.held) {
            totalFilteredFit++;
            sourceLedger.drop(company.name, 'fit');
            fitSkippedOffers.push({ ...job, route: routing.route, source: sourceName, fitReason: fit.reason });
            continue;
          }
          job.fit = formatFitValue(fit);
          routing = holdRouteForFit(routing, fit.verdict);
        }
        countRoute(routeTally, routing);
        job.route = routing.route;
        sourceLedger.keep(company.name);
        // --verify drops postings after the sweep has finished, by which
        // time the entry that produced them is out of scope. The URL is what
        // survives into every verify bucket, so it is the key back.
        sourceByOfferUrl.set(job.url, company.name);
        newOffers.push({
          ...job,
          source: sourceName,
          tracked: Boolean(careersUrlDomain),
          careersUrlDomain,
        });
      }
    } catch (err) {
      errors.push({
        company: company.name,
        error: err.message,
        kind: classifyFetchError(err),
      });
      sourceLedger.error(company.name, err.message);
    }
    // Printed the moment this source finishes, not in a block at the end, so a
    // long sweep shows progress instead of a blank screen. Order is therefore
    // completion order; the columns still read down the screen.
    console.log(formatSourceLine(sourceLedger.record(company.name)));
  });

  await parallelFetch(tasks, CONCURRENCY);

  // 5.5. Optional liveness verification — drop expired and guard-rejected postings
  let verifiedOffers = newOffers;
  let expiredOffers = [];
  let droppedOffers = [];
  let invalidOffers = [];
  let migratedOffers = [];
  if (verify && newOffers.length > 0) {
    console.log(`\nVerifying liveness of ${newOffers.length} new offer(s) with Playwright (sequential)...`);
    const result = await verifyOffers(newOffers, { headedFallback, throttleBaseMs, rediscover });
    verifiedOffers = result.verified;
    expiredOffers = result.expired;
    droppedOffers = result.dropped;
    invalidOffers = result.invalid;
    migratedOffers = result.migrated;
    // Migrated offers re-enter the pipeline at their newly discovered URL.
    if (migratedOffers.length > 0) {
      verifiedOffers = [...verifiedOffers, ...migratedOffers];
    }
  }

  // 5.6. Attribute the verify pass's drops. Until here a source's `kept` is the
  // pre-verify count, and the postings verify removed belong to no source and no
  // reason — so the breakdown would claim postings reached the pipeline that
  // never did. Expired, no-apply-control and guard-rejected are one reason here:
  // all three mean the posting did not survive verification, and the run summary
  // already reports the three separately.
  for (const offer of [...expiredOffers, ...droppedOffers, ...invalidOffers]) {
    const source = sourceByOfferUrl.get(offer.url);
    if (!source) continue;
    sourceLedger.unkeep(source);
    sourceLedger.drop(source, 'expired');
  }

  // The per-source totals must sum to the run totals. Checked on every real
  // run, not only in the suite: a drop reason added to the counters above and
  // forgotten in the ledger is exactly the silent divergence this catches.
  // Runs after the verify attribution above, so `kept` is what actually
  // reached the pipeline rather than what the sweep proposed.
  const ledgerMismatches = reconcileSourceLedger(sourceLedger, {
    found: totalFound,
    kept: verifiedOffers.length,
    blacklist: totalFilteredBlacklist,
    title: totalFilteredTitle,
    tier: totalFilteredTier,
    location: totalFilteredLocation,
    age: totalFilteredPostingAge,
    postedDate: totalFilteredPostedDate,
    salary: totalFilteredSalary,
    advertExpired: totalFilteredAdvertExpired,
    content: totalFilteredContent,
    countryEligibility: totalFilteredCountryEligibility,
    visa: totalFilteredVisa,
    duplicate: totalDupes,
    cooldown: totalFilteredCooldown,
    fit: totalFilteredFit,
    expired: expiredOffers.length + droppedOffers.length + invalidOffers.length,
  });
  if (ledgerMismatches.length > 0) {
    console.error(
      `\n⚠️  Per-source counts do not sum to the run totals: `
      + `${ledgerMismatches.map((m) => `${m.field} ${m.ledger} vs ${m.run}`).join(', ')}. `
      + `The run summary is correct; the per-source breakdown below is short by that much.`,
    );
  }

  // 5.7. Cross-listing check (#1597): fingerprint each new offer's JD body and
  // compare against recent history rows from a DIFFERENT company — the same
  // requirements text under two names is usually an agency re-post of a direct
  // listing (or vice versa), which URL and company+role dedup both miss.
  // Fingerprints are computed once here and reused by appendToScanHistory.
  for (const offer of verifiedOffers) {
    offer.fingerprint = fingerprintText(offer.description);
  }
  // History rows come from the run-start snapshot: nothing has appended to
  // scan-history.tsv yet at this point in the run (all writes happen below),
  // so this sees the same bytes a re-read would — minus the third full parse.
  const crossListings = findCrossListings(verifiedOffers, dedupSnapshot.fingerprintHistory);

  // 6. Write results
  if (!dryRun && verifiedOffers.length > 0) {
    await appendToPipeline(verifiedOffers);
    await appendToScanHistory(verifiedOffers, date);
  }
  // The fit gate's SKIPs (ticket D2b), recorded once: a ticked line in
  // Processed with every cell kept and the reason appended, and the URL in
  // scan-history under a status the dedup honours, so no later scan assesses
  // the row again.
  if (!dryRun && fitSkippedOffers.length > 0) {
    await appendProcessedToPipeline(fitSkippedOffers.map(
      (offer) => markPipelineLineProcessed(formatPipelineOffer(offer), sanitizeMarkdownField(formatFitSkipReason(offer.fitReason, date))),
    ));
    await appendToScanHistory(fitSkippedOffers, date, 'skipped_fit');
  }
  if (!dryRun && cooldownOffers.length > 0) {
    const cooldownGroups = {};
    for (const item of cooldownOffers) {
      if (!cooldownGroups[item.status]) {
        cooldownGroups[item.status] = [];
      }
      cooldownGroups[item.status].push(item.job);
    }
    for (const [status, group] of Object.entries(cooldownGroups)) {
      await appendToScanHistory(group, date, status);
    }
  }
  // Expired postings — plus the old URLs of migrated offers — are recorded as
  // skipped_expired so subsequent scans dedup-skip the dead URLs.
  const expiredForHistory = [
    ...expiredOffers,
    ...migratedOffers.map(o => ({ ...o, url: o.previousUrl })),
  ];
  if (!dryRun && expiredForHistory.length > 0) {
    await appendToScanHistory(expiredForHistory, date, 'skipped_expired');
  }
  // Pages that loaded but had no Apply control: record so we don't re-verify
  // them next scan, but never let them reach pipeline.md.
  if (!dryRun && droppedOffers.length > 0) {
    await appendToScanHistory(droppedOffers, date, 'skipped_no_apply_control');
  }
  // Guard-rejected URLs (invalid / unsupported protocol / blocked host) are
  // recorded with a precise status so subsequent scans dedup-skip them via
  // loadSeenUrls, but they never reach pipeline.md.
  if (!dryRun && invalidOffers.length > 0) {
    // Group by code so the TSV reflects the actual reason category.
    const byStatus = new Map();
    for (const o of invalidOffers) {
      const status = guardStatusFor(o.code);
      if (!byStatus.has(status)) byStatus.set(status, []);
      byStatus.get(status).push(o);
    }
    for (const [status, group] of byStatus) {
      await appendToScanHistory(group, date, status);
    }
  }

  // 7. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  const summaryCompanies = targets.filter(t => !t._isBoard).length;
  const summaryBoards = targets.filter(t => t._isBoard).length;
  console.log(`Companies scanned:     ${summaryCompanies}`);
  if (summaryBoards > 0) console.log(`Job boards scanned:    ${summaryBoards}`);
  console.log(`Total jobs found:      ${totalFound}`);
  if (config.title_filter || totalFilteredTitle > 0) {
    console.log(`Filtered by title:     ${totalFilteredTitle} removed`);
  }
  if (skipTiers.length > 0) {
    console.log(`Filtered by tier:      ${totalFilteredTier} removed`);
  }
  if (config.location_filter || totalFilteredLocation > 0) {
    console.log(`Filtered by location:  ${totalFilteredLocation} removed`);
  }
  if (config.max_posting_age_days != null || totalFilteredPostingAge > 0) {
    console.log(`Filtered by age:       ${totalFilteredPostingAge} removed`);
  }
  // effectiveAfter, not postedAfter — --since sets a lower bound too, and a
  // scan that filtered by date should say so regardless of which flag set it.
  if (effectiveAfter || postedBefore) {
    console.log(`Filtered by posted date: ${totalFilteredPostedDate} removed`);
  }
  if (config.salary_filter || totalFilteredSalary > 0) {
    console.log(`Filtered by salary:    ${totalFilteredSalary} removed`);
  }
  if (config.content_filter || totalFilteredContent > 0) {
    console.log(`Filtered by content:   ${totalFilteredContent} removed`);
  }
  if (config.country_eligibility_filter || totalFilteredCountryEligibility > 0) {
    console.log(`Filtered by country eligibility: ${totalFilteredCountryEligibility} removed`);
  }
  if (visaEnabled) {
    console.log(`Filtered by visa:      ${totalFilteredVisa} removed`);
  }
  if (Object.keys(windows).length > 0 || totalFilteredCooldown > 0) {
    console.log(`Filtered by cooldown:  ${totalFilteredCooldown} removed`);
  }
  console.log(`Duplicates:            ${totalDupes} skipped`);
  // The read (ticket B1). Printed whenever the reader was asked for anything,
  // so a run where every board handed over an advert stays byte-identical.
  if (advertReader.tally.considered > 0) {
    console.log('');
    for (const line of formatReadSummary(advertReader.tally, { firecrawlEnabled: advertReader.firecrawlEnabled })) {
      console.log(line);
    }
    if (totalFilteredAdvertExpired > 0) {
      console.log(`Dropped, posting gone: ${totalFilteredAdvertExpired} removed`);
    }
    for (const row of advertReader.tally.unreadableRows) {
      console.log(formatUnreadableRow(row));
    }
  }
  // The two lines B2 adds under B1's three, and the drops they count. Printed
  // outside the read block on purpose: a row dropped on a description its board
  // handed over was still dropped on the advert, and every queued row is routed
  // whether or not the reader was asked for anything. formatGateSummary returns
  // nothing when there is nothing to say, so a run with neither stays
  // byte-identical.
  {
    const gateLines = formatGateSummary(advertDrops, routeTally);
    if (gateLines.length > 0 && advertReader.tally.considered === 0) console.log('');
    for (const line of gateLines) console.log(line);
    // One line per drop, naming the phrase that dropped it and the stored
    // advert it was read from.
    for (const row of advertDrops.rows) {
      console.log(formatAdvertDropRow(row));
    }
    // The fit gate's summary line and one line per SKIP and REVIEW (ticket
    // D2b). Nothing when the gate is off.
    if (fitGate) {
      for (const line of formatFitSummary(fitGate)) console.log(line);
    }
  }
  if (blacklist.size > 0) {
    if (includeBlacklisted) {
      console.log(`Blacklisted:           ${annotatedBlacklisted} let through annotated (--include-blacklisted)`);
    } else {
      console.log(`Blacklisted:           ${totalFilteredBlacklist} skipped (blacklist)`);
    }
  }
  if (crossListings.length > 0) {
    console.log(`\n⚠️  Possible cross-listings (same JD text, different company) — warn only, nothing was dropped:`);
    for (const { offer, row, score } of crossListings) {
      console.log(`  - ${offer.company} — ${offer.title}`);
      console.log(`    ≈ ${Math.round(score * 100)}% of ${row.company} — ${row.title} (seen ${row.dateStr})`);
      console.log(`    ${offer.url}`);
      console.log(`    vs ${row.url}`);
    }
    console.log(`  If one side is an agency, apply through ONE channel only — a double submission burns both (#1596).`);
  }
  if (historyPolicy.recheckAfterDays != null) {
    console.log(`Recheck eligible:      ${dedupSnapshot.recheckEligible} old scan-history URL(s)`);
  }
  if (verify) {
    console.log(`Expired (verified):    ${expiredOffers.length} dropped`);
    console.log(`Rediscovered (moved):  ${migratedOffers.length} migrated`);
    console.log(`No apply control:      ${droppedOffers.length} dropped`);
    console.log(`Invalid (guarded):     ${invalidOffers.length} dropped`);
  }
  console.log(`New offers added:      ${verifiedOffers.length}`);

  // Trust validation summary (only when trust_filter is configured)
  if (config.trust_filter && config.trust_filter.enabled !== false && verifiedOffers.length > 0) {
    const trustHigh = verifiedOffers.filter(o => o.trustLevel === 'high').length;
    const trustMedium = verifiedOffers.filter(o => o.trustLevel === 'medium').length;
    const trustLow = verifiedOffers.filter(o => o.trustLevel === 'low').length;
    console.log(`Trust validation:      ${trustHigh} high, ${trustMedium} medium, ${trustLow} low`);
    // Flag breakdown
    /** @type {Record<string, number>} */
    const flagCounts = {};
    for (const o of verifiedOffers) {
      for (const f of (o.trustFlags || [])) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
    if (Object.keys(flagCounts).length > 0) {
      const parts = Object.entries(flagCounts).map(([k, v]) => `${k}: ${v}`);
      console.log(`Trust flags:           ${parts.join(', ')}`);
    }
  }

  if (agentHandoff.length > 0) {
    console.log(`Agent/WebSearch handoff: ${agentHandoff.length} compan${agentHandoff.length === 1 ? 'y' : 'ies'} not handled by zero-token providers`);
    for (const item of agentHandoff.slice(0, 25)) {
      const hint = item.query ? ` — ${item.query}` : '';
      console.log(`  • ${item.company} (${item.method})${hint}`);
    }
    if (agentHandoff.length > 25) {
      console.log(`  … ${agentHandoff.length - 25} more omitted; narrow with --company or inspect portals.yml`);
    }
  }

  const unreachableTargets = errors.filter((e) => e.kind === 'slug_gone');
  const networkTargets = errors.filter((e) => e.kind === 'network');
  const otherErrors = errors.filter((e) => e.kind !== 'slug_gone' && e.kind !== 'network');
  
  const STREAK_THRESHOLD = config.portal_health_threshold || 3;
  const nowStr = new Date().toISOString();
  const healthRecords = [];
  
  // Record each errored target under its real classifyFetchError kind. Before
  // this, only slug_gone/network were recorded and auth (401/403), server
  // (5xx), and unknown fell through to 'reachable' — so a portal WAF-403ing
  // every run was logged as healthy forever and never reached the 🚨 streak
  // escalation. The TSV status vocabulary is additive: auth/server/unknown
  // join the existing reachable|slug_gone|network|empty.
  const errorKindByCompany = new Map(
    errors.filter((e) => e.kind).map((e) => [e.company, e.kind])
  );
  for (const t of targets) {
    const isEmpty = emptyTargets.includes(t.name);

    let status = errorKindByCompany.get(t.name) || 'reachable';
    if (status === 'reachable' && isEmpty) status = 'empty';

    healthRecords.push({ timestamp: nowStr, company: t.name, status });
  }

  const pastHealth = loadPortalHealth();
  const currentStreaks = computeConsecutiveFailures([...pastHealth, ...healthRecords]);

  const persistentlyDead = [];
  const newlyDeadSlug = [];
  const newlyDeadNetwork = [];
  
  // All error kinds can reach the 🚨 persistent list (auth/server/unknown
  // included — a WAF that 403s the scanner every run is coverage decay too).
  // Below threshold, only slug_gone/network keep their dedicated warnings;
  // auth/server/unknown stay in the one-off `Errors (N):` print below.
  for (const e of [...unreachableTargets, ...networkTargets, ...otherErrors.filter((x) => x.kind)]) {
    const streak = currentStreaks.get(e.company) || 1;
    if (streak >= STREAK_THRESHOLD) {
      if (!persistentlyDead.includes(e.company)) persistentlyDead.push(e.company);
    } else if (e.kind === 'slug_gone') {
      if (!newlyDeadSlug.some(x => x.company === e.company)) newlyDeadSlug.push(e);
    } else if (e.kind === 'network') {
      newlyDeadNetwork.push(e);
    }
  }

  if (persistentlyDead.length > 0) {
    console.log(`\n🚨 FIX NEEDED: ${persistentlyDead.length} target(s) have been unreachable for ${STREAK_THRESHOLD}+ runs:`);
    console.log(`   ${persistentlyDead.join(', ')}`);
    console.log(`   Run: node verify-portals.mjs to check if the ATS migrated, or update their board slugs.`);
  }
  if (newlyDeadSlug.length > 0) {
    const names = newlyDeadSlug.map(x => x.company).join(', ');
    console.log(`\n⚠️  ${newlyDeadSlug.length} target(s) unreachable (slug?): ${names} — run: node verify-portals.mjs`);
  }
  if (emptyTargets.length > 0) {
    console.log(`🟡 ${emptyTargets.length} target(s) live but empty: ${emptyTargets.join(', ')}`);
  }
  // Read before this run's rows are appended below, so "the last run" is the previous one.
  for (const line of emptyPaidFeedWarnings(sourceLedger.records(), readLastRunSources(sourceLogPath))) {
    console.log(line);
  }
  if (newlyDeadNetwork.length > 0) {
    console.log(`\nNetwork errors (${newlyDeadNetwork.length}):`);
    for (const e of newlyDeadNetwork) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }
  if (otherErrors.length > 0) {
    console.log(`\nErrors (${otherErrors.length}):`);
    for (const e of otherErrors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (verifiedOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of verifiedOffers) {
      const trustSuffix = o.trustScore != null && o.trustScore < 100
        ? ` [Trust: ${o.trustScore}/100${o.trustFlags?.length ? ' — ' + o.trustFlags.join(', ') : ''}]`
        : '';
      const blacklistSuffix = o.blacklisted ? ' [BLACKLISTED — on your do-not-apply list]' : '';
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}${trustSuffix}${blacklistSuffix}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  // Persist this run's counters (#1604) — guarded exactly like the other
  // writes; a --dry-run must leave no trace.
  if (!dryRun) {
    await appendPortalHealth(healthRecords);
    // One timestamp for both writes, so a per-source row joins its run-summary
    // row on an exact string match rather than on two clocks agreeing.
    const runTimestamp = new Date().toISOString();
    appendScanSources(sourceLedger.records(), runTimestamp, sourceLogPath);
    appendScanRunSummary({
      timestamp: runTimestamp, status: 'completed',
      companies: summaryCompanies, boards: summaryBoards, found: totalFound,
      filteredTitle: totalFilteredTitle, filteredTier: totalFilteredTier,
      filteredLocation: totalFilteredLocation, filteredPostingAge: totalFilteredPostingAge,
      filteredSalary: totalFilteredSalary,
      // A fit SKIP read the advert, like a years drop, and scan-runs.tsv has
      // no column of its own for it: its header is a guarded contract. The
      // per-source log and the summary name it as `fit`.
      filteredContent: totalFilteredContent + totalFilteredFit, filteredCooldown: totalFilteredCooldown,
      dupes: totalDupes, newAdded: verifiedOffers.length, errors: errors.length,
      filteredBlacklist: totalFilteredBlacklist,
      filteredVisa: totalFilteredVisa,
      filteredPostedDate: totalFilteredPostedDate,
      filteredCountryEligibility: totalFilteredCountryEligibility,
    });
  }
  // The run completed (or was a dry run) — disarm the failure row.
  registerRunFailureSnapshot(null);

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');

  if (jsonMode) {
    const filtered = totalFilteredTitle + totalFilteredTier + totalFilteredLocation
      + totalFilteredPostingAge + totalFilteredPostedDate + totalFilteredSalary
      + totalFilteredContent + totalFilteredCountryEligibility + totalFilteredBlacklist
      + totalFilteredVisa + totalFilteredCooldown + totalFilteredFit;
    emitJsonReceipt({
      version: 'careerops.scan.receipt@1',
      date,
      scanned: targets.length,
      skipped: skippedCount,
      found: totalFound,
      filtered,
      duplicates: totalDupes,
      added: verifiedOffers.length,
      added_urls: verifiedOffers.map(offer => offer.url),
      errors: errors.map(({ company, error }) => ({ company, error })),
      dry_run: dryRun,
    }, errors.length > 0 ? 2 : 0);
  }

  // One-time-ever manifesto note: first successful REAL run only. The state
  // file keeps it from ever repeating; --dry-run must leave no trace, and a
  // piped/quiet run is not the moment for it.
  if (!dryRun && process.stdout.isTTY && !process.argv.includes('--quiet') && !existsSync('.manifesto-noted')) {
    // OSC 8 hyperlink where support is known, so the click attributes as
    // utm_source=cli while the visible text stays clean; otherwise print the
    // URL with the utm so typed visits attribute too.
    const osc8 = ['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby'].includes(process.env.TERM_PROGRAM)
      || !!process.env.WT_SESSION || !!process.env.KITTY_WINDOW_ID
      || parseInt(process.env.VTE_VERSION || '0', 10) >= 5000;
    const link = osc8
      ? '\x1b]8;;https://career-ops.org/manifesto?utm_source=cli\x1b\\career-ops.org/manifesto\x1b]8;;\x1b\\'
      : 'career-ops.org/manifesto?utm_source=cli';
    console.log(`\nthe practice behind this tool has a name and a manifesto: ${link}`);
    try { writeFileSync('.manifesto-noted', new Date().toISOString() + '\n'); } catch { /* best-effort */ }
  }
}

// Only run main() when invoked directly (`node scan.mjs`), not when imported by tests.
// `|| ''` guards the case where Node is invoked without a script arg (e.g. `node -e`).
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    writeRunFailureRow('failed');
    process.exitCode = 1;
  });
}
