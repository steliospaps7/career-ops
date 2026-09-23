// @ts-check
// Read the advert, and store it. Ticket B1 of the career-ops fork.
//
// Files prefixed with _ are never loaded as providers by the registry, so this
// lives beside _http.mjs and _html-to-text.mjs rather than in the repo root:
// providers/ and tests/ are covered by directory in the system-paths check, and
// a new root script would have to be named one by one in update-system.mjs,
// which is the maintainer's file.
//
// The problem this closes: a third of the boards hand over a title and a link
// and no advert, so `content_filter` reads an empty string and passes
// everything. The filter is real; the input was missing. Nothing here
// interprets what it reads — an advert is data, never instructions, and the
// only writes this module makes are the stored file itself.
//
// Every rung takes its transport as an argument, so the suite drives the whole
// ladder from fixtures and no test touches the network.

import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { classifyLiveness } from '../liveness-core.mjs';
import { resolveAtsApi, isSafeValue } from '../liveness-api.mjs';
import { htmlToText } from './_html-to-text.mjs';
import { withStatedCompensation } from './ashby.mjs';
import { wttjApiUrl, wttjAdvertText } from './wttj.mjs';
import { providerFetchContext } from './_ip-guard.mjs';
import { DEFAULT_USER_AGENT } from '../user-agent.mjs';

/**
 * The floor an advert must clear to count as read. Same number as
 * liveness-core's MIN_CONTENT_CHARS, and for the same reason: below it, a page
 * is navigation and a footer. Required on every path, including a page whose
 * Apply button is visible — an apply control is evidence the posting is live,
 * never evidence there is an advert on it, and the filters read the text.
 */
export const MIN_ADVERT_CHARS = 300;

/** How much of one advert is kept. Long enough for every filter phrase to be in it. */
export const ADVERT_TEXT_CAP = 40_000;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_JDS_DIR = 'jds';

// ── The route table ─────────────────────────────────────────────────
//
// Five hosts return a shell to a plain fetch and a full advert to a free JSON
// (or, for LinkedIn, plain-markup) route. Pure: a URL in, a fetch plan out.
//
// Host detection and the SSRF guard are `liveness-api.mjs`'s, not a second copy:
// `resolveAtsApi` already knows every host this reader wants, including
// `jobs.eu.lever.co` and `job-boards.eu.greenhouse.io`, and it runs `isSafeValue`
// over every value it takes out of the URL before any of them reaches a URL we
// fetch. A path segment outside that charset yields no feed at all, and the
// reader falls back to a plain fetch of the posting URL it was given. The
// endpoints below are still built here, because two of them carry a query the
// liveness check has no use for.

/**
 * @typedef {object} ReadRoute
 * @property {'feed'|'page'} kind   'feed' when a free host route exists for this URL.
 * @property {string|null} host     The host family ('ashby' … 'linkedin'), or null.
 * @property {string} url           What rung 1 asks for.
 * @property {'json'|'html'} format How to read the response.
 * @property {string} [org]         The board owner, as the host spells it.
 * @property {string} [jobId]       The posting id.
 * @property {string} pageUrl       The posting page, kept for the fallback and the queue line.
 */

/**
 * Resolve the first rung's fetch plan for a posting URL.
 *
 * @param {unknown} rawUrl
 * @returns {ReadRoute|null} null for anything that is not an https posting URL,
 *   so a malformed row is a skipped row rather than a thrown run.
 */
export function resolveReadRoute(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
  let u;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  // https only, the same guard the apify plugin applies to actor output: a
  // javascript:, data:, file: or plain http URL is never fetched here.
  if (u.protocol !== 'https:') return null;

  const pageUrl = rawUrl.trim();
  const page = { kind: /** @type {const} */ ('page'), host: null, url: pageUrl, format: /** @type {const} */ ('html'), pageUrl };

  const ats = resolveAtsApi(pageUrl);
  if (ats) {
    const p = ats.parts;
    switch (ats.ats) {
      case 'greenhouse':
        return {
          kind: 'feed', host: 'greenhouse', format: 'json', org: p.board, jobId: p.id, pageUrl,
          url: `https://boards-api.greenhouse.io/v1/boards/${p.board}/jobs/${p.id}`,
        };
      case 'lever':
        // `mode=json` is the documented explicit form, and p.apiHost carries the
        // EU board's own API host rather than a hard-coded api.lever.co.
        return {
          kind: 'feed', host: 'lever', format: 'json', org: p.slug, jobId: p.id, pageUrl,
          url: `https://${p.apiHost}/v0/postings/${p.slug}/${p.id}?mode=json`,
        };
      case 'ashby':
        // Ashby's free route is the whole board feed; the posting is picked out
        // of it by id.
        return {
          kind: 'feed', host: 'ashby', format: 'json', org: p.org, jobId: p.jobId, pageUrl,
          url: `https://api.ashbyhq.com/posting-api/job-board/${p.org}?includeCompensation=true`,
        };
      case 'linkedin':
        // The guest endpoint returns markup, not JSON.
        return { kind: 'feed', host: 'linkedin', format: 'html', jobId: p.id, pageUrl, url: ats.apiUrl };
      default:
        // Workday, today. `browser-extract.mjs` already reads a Workday posting
        // through its CXS endpoint at rung 3, so the reader claims no feed here
        // rather than growing a sixth one the ticket did not ask for.
        return page;
    }
  }

  // Welcome to the Jungle's posting page carries no office address, and the
  // board's search index had the city wrong (ticket 6). The job's own record
  // has both the advert and the address; wttjApiUrl checks both slugs.
  const wttj = wttjApiUrl(pageUrl);
  if (wttj) return { kind: 'feed', host: 'wttj', format: 'json', pageUrl, url: wttj };

  // Workable is the one host resolveAtsApi does not carry, so its two values get
  // the same isSafeValue check by hand before either reaches a fetched URL.
  if (u.hostname.toLowerCase().replace(/^www\./, '') === 'apply.workable.com') {
    const m = u.pathname.match(/^\/([^/]+)\/j\/([^/]+)/);
    if (m && isSafeValue(m[1]) && isSafeValue(m[2])) {
      return {
        kind: 'feed', host: 'workable', format: 'json', org: m[1], jobId: m[2], pageUrl,
        url: `https://apply.workable.com/api/v2/accounts/${m[1]}/jobs/${m[2]}`,
      };
    }
    return page;
  }

  return page;
}

// ── The status mapping ──────────────────────────────────────────────
//
// liveness-core's classifyLiveness is reused rather than growing a second
// classifier. There is no login-wall pattern in it and this ticket adds none: a
// login page that returns 200 lands in `shell` and the reader moves on, which is
// the right outcome.

const LIVENESS_TO_READ_STATUS = {
  apply_control_visible: 'read',
  access_blocked: 'blocked',
  bot_challenge: 'blocked',
  server_error: 'blocked',
  insufficient_content: 'shell',
  listing_page: 'shell',
  redirected_off_posting: 'shell',
  no_apply_control: 'shell',
  expired_body: 'expired',
  expired_url: 'expired',
  http_gone: 'expired',
};

/**
 * @param {string} code - a classifyLiveness code.
 * @returns {'read'|'blocked'|'shell'|'expired'} An unknown code reads as `shell`:
 *   the safe end, because a shell moves to the next rung and never passes a
 *   filter on an empty advert.
 */
export function mapLivenessToReadStatus(code) {
  return LIVENESS_TO_READ_STATUS[code] || 'shell';
}

// ── Reading one response ────────────────────────────────────────────

const ANCHOR_RE = /<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)\s*>/gi;

/** Visible anchor and button text, for classifyLiveness's apply-control check. */
function applyControls(html) {
  const out = [];
  for (const m of String(html).matchAll(ANCHOR_RE)) {
    const text = htmlToText(m[1]);  // a control label, never an advert: the default cap is right
    if (text) out.push(text);
    if (out.length >= 200) break;
  }
  return out;
}

const APPLY_HREF_TEXT = /\b(apply|postuler|bewerben|solicitar|aplikuj)\b/i;

/**
 * The destination of a page's apply control, absolute, or null.
 *
 * An aggregator's apply button usually lands on the employer's own applicant
 * system, which is the rung that pays.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function extractApplyHref(html, baseUrl) {
  const anchors = String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi);
  for (const m of anchors) {
    const attrs = m[1];
    const text = htmlToText(m[2]);
    const hrefMatch = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!hrefMatch) continue;
    const href = (hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|javascript|tel|data):/i.test(href)) continue;
    const looksLikeApply = APPLY_HREF_TEXT.test(text) || /\bapply\b/i.test(href) || /class\s*=\s*["'][^"']*apply/i.test(attrs);
    if (!looksLikeApply) continue;
    let resolved;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== 'https:') continue;
    if (resolved.href === baseUrl) continue;
    return resolved.href;
  }
  return null;
}

/** Pull the advert body out of a known host's free feed. Pure. */
export function extractFeedDescription(host, payload, jobId) {
  if (payload == null) return '';
  switch (host) {
    case 'ashby': {
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      const job = jobs.find((j) => String(j?.id) === String(jobId));
      if (!job) return '';
      // The band Ashby states in its compensation field rides as the last line.
      return withStatedCompensation(htmlToText(job.descriptionPlain || job.descriptionHtml || job.description || '', ADVERT_TEXT_CAP), job);
    }
    case 'lever':
      return htmlToText(payload.descriptionPlain || payload.description || '', ADVERT_TEXT_CAP);
    case 'greenhouse':
      return htmlToText(payload.content || '', ADVERT_TEXT_CAP);
    case 'workable':
      return htmlToText(payload.description || payload?.job?.description || '', ADVERT_TEXT_CAP);
    case 'wttj':
      // The office address lines lead, then the advert (providers/wttj.mjs).
      return wttjAdvertText(payload, ADVERT_TEXT_CAP);
    default:
      return '';
  }
}

/**
 * The apply destination a known host's feed carries, or null.
 *
 * This is the only apply link available when the posting page itself is blocked:
 * rung 2 has no HTML to read a control out of, and the feed already named the
 * employer's own applicant system.
 */
export function extractFeedApplyUrl(host, payload, jobId) {
  if (payload == null) return null;
  let candidate = null;
  switch (host) {
    case 'ashby': {
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      const job = jobs.find((j) => String(j?.id) === String(jobId));
      candidate = job?.applyUrl || job?.jobUrl || null;
      break;
    }
    case 'lever':
      candidate = payload.applyUrl || null;
      break;
    case 'greenhouse':
      candidate = payload.absolute_url || null;
      break;
    case 'workable':
      candidate = payload.application_url || payload.url || null;
      break;
    default:
      candidate = null;
  }
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  try {
    const u = new URL(candidate.trim());
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Classify one fetched body into a reader status and its text.
 *
 * @returns {{status:'read'|'blocked'|'shell'|'expired', text:string, code:string, reason:string}}
 */
function classifyBody({ status, requestedUrl, finalUrl, html = '', text = null }) {
  const bodyText = text != null ? String(text) : htmlToText(html, ADVERT_TEXT_CAP);
  const verdict = classifyLiveness({
    status,
    requestedUrl,
    finalUrl,
    bodyText,
    applyControls: html ? applyControls(html) : [],
  });
  const mapped = mapLivenessToReadStatus(verdict.code);
  if (mapped === 'blocked' || mapped === 'expired') {
    return { status: mapped, text: '', code: verdict.code, reason: verdict.reason };
  }
  // Everything else turns on the text itself. An advert below the floor is a
  // shell whatever the page's buttons say — that is the whole point of the
  // read_status field, and of story 8.
  if (bodyText.trim().length >= MIN_ADVERT_CHARS) {
    return { status: 'read', text: bodyText.slice(0, ADVERT_TEXT_CAP), code: verdict.code, reason: verdict.reason };
  }
  return { status: 'shell', text: '', code: 'insufficient_content', reason: 'advert below the readable minimum' };
}

// ── The ladder ──────────────────────────────────────────────────────

/**
 * @typedef {object} ReadResult
 * @property {'read'|'expired'|'unreadable'} status
 * @property {'page'|'feed'|'apply-link'|'browser'|null} rung
 * @property {string} text
 * @property {string} finalUrl
 * @property {Array<{rung:string,status:string,reason:string}>} failures
 * @property {boolean} reachedFirecrawl
 * @property {string|null} [failedAs]  The kind of the last real failure.
 * @property {string|null} [failedAt]  The rung it happened on.
 */

/**
 * Work down the five rungs and stop at the first that returns real text.
 *
 * Fails per row, never per run: every transport error is caught and recorded as
 * a rung failure, so one bot challenge cannot stop a scan.
 *
 * @param {string} url
 * @param {{fetchText?:Function, fetchJson?:Function, browser?:Function}} transports
 * @param {{firecrawlEnabled?:boolean}} [options]
 * @returns {Promise<ReadResult>}
 */
export async function readAdvert(url, transports = {}, options = {}) {
  /** @type {Array<{rung:string,status:string,reason:string}>} */
  const failures = [];
  const route = resolveReadRoute(url);
  if (!route) {
    return {
      status: 'unreadable', rung: null, text: '', finalUrl: typeof url === 'string' ? url : '',
      failures: [{ rung: 'route', status: 'unreadable', reason: 'not an https posting URL' }],
      reachedFirecrawl: false, failedAs: 'unreadable', failedAt: 'route',
    };
  }

  const done = (rung, body, finalUrl) => ({
    status: /** @type {const} */ ('read'), rung, text: body.text, finalUrl,
    failures, reachedFirecrawl: false, failedAs: null, failedAt: null,
  });

  // ── Rung 1a: the host's free feed, when one exists ────────────────
  let feedApplyUrl = null;
  if (route.kind === 'feed') {
    try {
      let body;
      if (route.format === 'json') {
        const res = await transports.fetchJson(route.url);
        feedApplyUrl = extractFeedApplyUrl(route.host, res?.json, route.jobId);
        const text = extractFeedDescription(route.host, res?.json, route.jobId);
        body = classifyBody({ status: res?.status ?? 200, requestedUrl: route.url, finalUrl: route.url, text });
      } else {
        const res = await transports.fetchText(route.url);
        body = classifyBody({ status: res?.status ?? 200, requestedUrl: route.url, finalUrl: res?.finalUrl || route.url, html: res?.body || '' });
      }
      if (body.status === 'read') return done('feed', body, route.pageUrl);
      if (body.status === 'expired') {
        // The board's own data says the posting is gone. Nothing later can
        // disagree, so the ladder ends here.
        return {
          status: 'expired', rung: 'feed', text: '', finalUrl: route.pageUrl,
          failures: [...failures, { rung: 'feed', status: 'expired', reason: body.reason }],
          reachedFirecrawl: false, failedAs: 'expired', failedAt: 'feed',
        };
      }
      failures.push({ rung: 'feed', status: body.status, reason: body.reason });
    } catch (err) {
      failures.push({ rung: 'feed', status: 'blocked', reason: err?.message || String(err) });
    }
  }

  // ── Rung 1b: the posting page itself ──────────────────────────────
  let pageHtml = '';
  let pageFinalUrl = route.pageUrl;
  try {
    const res = await transports.fetchText(route.pageUrl);
    pageHtml = res?.body || '';
    pageFinalUrl = res?.finalUrl || route.pageUrl;
    const body = classifyBody({ status: res?.status ?? 200, requestedUrl: route.pageUrl, finalUrl: pageFinalUrl, html: pageHtml });
    if (body.status === 'read') return done('page', body, pageFinalUrl);
    if (body.status === 'expired') {
      return {
        status: 'expired', rung: 'page', text: '', finalUrl: pageFinalUrl,
        failures: [...failures, { rung: 'page', status: 'expired', reason: body.reason }],
        reachedFirecrawl: false, failedAs: 'expired', failedAt: 'page',
      };
    }
    failures.push({ rung: 'page', status: body.status, reason: body.reason });
  } catch (err) {
    failures.push({ rung: 'page', status: 'blocked', reason: err?.message || String(err) });
  }

  // ── Rung 2: the destination of the apply control ──────────────────
  // LinkedIn's Easy Apply and other in-platform apply controls have no
  // destination to follow, so the rung is skipped rather than fetched.
  if (route.host !== 'linkedin') {
    const href = feedApplyUrl && feedApplyUrl !== route.pageUrl
      ? feedApplyUrl
      : (pageHtml ? extractApplyHref(pageHtml, pageFinalUrl) : null);
    if (href) {
      try {
        const res = await transports.fetchText(href);
        const finalUrl = res?.finalUrl || href;
        const body = classifyBody({ status: res?.status ?? 200, requestedUrl: href, finalUrl, html: res?.body || '' });
        if (body.status === 'read') return done('apply-link', body, finalUrl);
        failures.push({ rung: 'apply-link', status: body.status === 'expired' ? 'expired' : body.status, reason: body.reason });
      } catch (err) {
        failures.push({ rung: 'apply-link', status: 'blocked', reason: err?.message || String(err) });
      }
    }
  }

  // ── Rung 3: the headless browser ──────────────────────────────────
  if (typeof transports.browser === 'function') {
    try {
      const res = await transports.browser(route.pageUrl);
      const finalUrl = res?.finalUrl || route.pageUrl;
      const body = classifyBody({ status: res?.status ?? 200, requestedUrl: route.pageUrl, finalUrl, text: res?.text ?? '' });
      if (body.status === 'read') return done('browser', body, finalUrl);
      failures.push({ rung: 'browser', status: body.status, reason: body.reason });
    } catch (err) {
      failures.push({ rung: 'browser', status: 'blocked', reason: err?.message || String(err) });
    }
  }

  // ── Rung 4: Firecrawl. Counted, never called ──────────────────────
  // The switch exists and the run counts every row that reaches this rung. The
  // call itself, its key and its cap are a follow-up, written when Stelios has
  // read one day's residue count and said yes. Turning the switch on today
  // changes the note, not the behaviour.
  failures.push({
    rung: 'firecrawl',
    status: 'skipped',
    reason: options.firecrawlEnabled ? 'firecrawl switch on, but the call is not built yet' : 'firecrawl off',
  });

  // ── Rung 5: unreadable. Kept, labelled, listed ────────────────────
  const last = [...failures].reverse().find((f) => f.rung !== 'firecrawl') || null;
  return {
    status: 'unreadable', rung: null, text: '', finalUrl: pageFinalUrl,
    failures, reachedFirecrawl: true,
    failedAs: last ? last.status : 'unreadable',
    failedAt: last ? last.rung : null,
  };
}

// ── The store ───────────────────────────────────────────────────────

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  return `jd-${createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10)}`;
}

function yamlEscape(value) {
  const s = String(value ?? '').replace(/\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The apify plugin's filename shape, so the two writers never collide on the
 * same posting and jd-capture.mjs resolves either.
 *
 * @returns {string} `{company-title}-{sha1(url)[0:10]}.md`
 */
export function advertFilename(company, title, url) {
  const baseSlug = slugify(`${company}-${title}`);
  const urlHash = createHash('sha1').update(String(url || `${company}-${title}`)).digest('hex').slice(0, 10);
  return `${baseSlug}-${urlHash}.md`;
}

/** Read one frontmatter field out of a stored advert. */
function frontmatterField(raw, field) {
  const m = raw.match(new RegExp(`^${field}:\\s*"?([^"\\n]*)"?\\s*$`, 'm'));
  return m ? m[1] : null;
}

/**
 * The stored advert for a posting, or null.
 *
 * This is what lets the caller skip the ladder: a stored advert is re-used and
 * never re-fetched for the same URL, so a re-run costs nothing on the boards.
 *
 * @returns {{path:string, status:string|null, rung:string|null, failedAs?:string|null}|null}
 */
export function findAdvert({ company, title, url }, { jdsDir = DEFAULT_JDS_DIR } = {}) {
  const filename = advertFilename(company, title, url);
  const filepath = join(jdsDir, filename);
  if (!existsSync(filepath)) return null;
  let raw = '';
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch {
    return null;
  }
  return { path: `${DEFAULT_JDS_DIR}/${filename}`, ...storedState(raw) };
}

/**
 * The status and rung a stored file records.
 *
 * A file with no `read_status` was written by the apify plugin, which does not
 * write one, and carries the full advert its paid actor returned. It reads as
 * `read`: treating the absent field as "not read" would let `--reread` delete an
 * advert somebody paid for and replace it with a free fetch of a page that may
 * no longer exist.
 */
function storedState(raw) {
  const status = frontmatterField(raw, 'read_status');
  if (status === null) return { status: 'read', rung: 'apify', foreign: true };
  // How the ladder failed, for a file it could not read (ticket 6): `shell`
  // means a host answered with no advert, `blocked` that none answered. Files
  // written before 23 September 2026 carry no such line and read as null.
  const failedAs = status === 'read' ? null : (frontmatterField(raw, 'read_failed_as') || null);
  return { status, rung: frontmatterField(raw, 'read_rung') || null, foreign: false, failedAs };
}

/**
 * The `read_status` of one stored file, addressed by the path a queue line's
 * `jd:` segment names. Null when there is no such file.
 */
export function advertStatusAt(relPath, { jdsDir = DEFAULT_JDS_DIR } = {}) {
  const filename = String(relPath).split('/').pop();
  const filepath = join(jdsDir, filename);
  if (!existsSync(filepath)) return null;
  try {
    return storedState(readFileSync(filepath, 'utf-8')).status;
  } catch {
    return null;
  }
}

/** The advert body of a stored file, without its frontmatter. '' when unreadable. */
export function loadAdvertText(relPath, { jdsDir = DEFAULT_JDS_DIR } = {}) {
  const filename = String(relPath).split('/').pop();
  const filepath = join(jdsDir, filename);
  if (!existsSync(filepath)) return '';
  let raw = '';
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch {
    return '';
  }
  const end = raw.indexOf('\n---', 3);
  const body = end === -1 ? raw : raw.slice(end + 4);
  return body.replace(/^\s*#[^\n]*\n/, '').trim();
}

/**
 * Write one advert under `jds/`, atomically and idempotently.
 *
 * An existing file is re-used and never overwritten, unless `reread` is set and
 * its status is not `read` — a run that could not read a posting yesterday may
 * read it today; one that did read it is left alone.
 *
 * A store failure is a null path, never a thrown run: the row still reaches the
 * queue, it just carries no `jd:` segment.
 *
 * @returns {{path:string|null, reused:boolean}}
 */
export function saveAdvert(record, { jdsDir = DEFAULT_JDS_DIR, reread = false } = {}) {
  const filename = advertFilename(record.company, record.title, record.url);
  const relPath = `${DEFAULT_JDS_DIR}/${filename}`;
  const filepath = join(jdsDir, filename);
  try {
    if (existsSync(filepath)) {
      // storedState, not the raw field: a file the apify plugin wrote has no
      // read_status and is never overwritten by a free re-read.
      const existing = storedState(readFileSync(filepath, 'utf-8'));
      if (!reread || existing.status === 'read') return { path: relPath, reused: true };
      unlinkSync(filepath);
    }
    mkdirSync(jdsDir, { recursive: true });
    const fetchedAt = record.fetchedAt || new Date().toISOString();
    const content = `---
title: ${yamlEscape(record.title)}
company: ${yamlEscape(record.company)}
url: ${yamlEscape(record.url)}
location: ${yamlEscape(record.location)}
scraped: "${fetchedAt.slice(0, 10)}"
source: ${yamlEscape(record.source || 'scan-reader')}
fetched_at: ${yamlEscape(fetchedAt)}
final_url: ${yamlEscape(record.finalUrl || record.url)}
read_rung: ${yamlEscape(record.rung || '')}
read_status: ${yamlEscape(record.status || 'unreadable')}
${record.status !== 'read' && record.failedAs ? `read_failed_as: ${yamlEscape(record.failedAs)}\n` : ''}---

# ${record.title} — ${record.company}

${record.text || ''}
`;
    writeFileSync(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    return { path: relPath, reused: false };
  } catch (err) {
    // Ten workers race on the same posting: EEXIST means the other one won,
    // and its file is the one to use.
    if (err?.code === 'EEXIST' && existsSync(filepath)) return { path: relPath, reused: true };
    return { path: null, reused: false };
  }
}

// ── The default transports ──────────────────────────────────────────
//
// Built here rather than in scan.mjs so the ladder's contract lives in one
// place. Each returns the status code instead of throwing on it, because
// classifyLiveness needs the code to tell a bot wall from a dead posting.

/**
 * How many redirects one read may follow. Enough for an aggregator's apply link
 * to reach an employer's applicant system through a shortener and a locale
 * bounce; short enough that a loop ends.
 */
export const MAX_REDIRECT_HOPS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * One GET, following redirects a hop at a time.
 *
 * `providers/ADDING_A_PROVIDER.md` tells a provider to pass `redirect: 'error'`,
 * because a server-side redirect can point the request at an internal address
 * and `fetch`'s own following happens where no guard can see it. The reader
 * cannot refuse redirects outright: the apply-link rung follows a href the page
 * chose, and an aggregator's apply button is a redirect by design. So it asks
 * for `redirect: 'manual'` and inspects each destination itself — https only,
 * at most MAX_REDIRECT_HOPS of them, and every hop inside providerFetchContext,
 * so the DNS guard validates the address of each one rather than only the first.
 *
 * @returns {Promise<{status:number, body:string, finalUrl:string}>}
 */
export async function httpGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = String(url);
    let last = { status: 0, body: '', finalUrl: current };
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const target = current;
      // Scoped per hop: _dns-cache.mjs patches dns.lookup process-wide, and this
      // marks the request as provider traffic so the resolved address of THIS
      // destination is validated, not just the one the caller asked for.
      const res = await providerFetchContext.run({ url: target }, async () => {
        const r = await fetch(target, {
          headers: { 'user-agent': DEFAULT_USER_AGENT, accept: '*/*', ...headers },
          redirect: 'manual',
          signal: controller.signal,
        });
        const body = REDIRECT_STATUSES.has(r.status) ? '' : await r.text();
        return { status: r.status, body, location: r.headers?.get?.('location') ?? null };
      });
      last = { status: res.status, body: res.body, finalUrl: target };
      if (!REDIRECT_STATUSES.has(res.status) || !res.location) return last;

      let next;
      try {
        next = new URL(res.location, target);
      } catch {
        return last;  // an unparseable Location is the end of the road
      }
      // Anything but https is refused rather than followed: file:, javascript:,
      // ftp: and plain http are all ways to leave the guard behind.
      if (next.protocol !== 'https:') return last;
      current = next.href;
    }
    return last;  // the hop budget ran out; the caller sees the last 3xx
  } finally {
    clearTimeout(timer);
  }
}

/** The transports a real run uses. `browser` is supplied by the caller. */
export function defaultTransports({ browser } = {}) {
  return {
    fetchText: (url) => httpGet(url),
    fetchJson: async (url) => {
      const res = await httpGet(url, { headers: { accept: 'application/json' } });
      let json = null;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = null;
      }
      return { status: res.status, json, finalUrl: res.finalUrl };
    },
    browser,
  };
}
