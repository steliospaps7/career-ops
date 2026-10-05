// @ts-check
// ── Reference seed ── This bundled plugin is a stable, reviewed example. To
// extend it, publish career-ops-plugin-<id> with "supersedesBundled": true and
// your version takes precedence once installed (see docs/PLUGINS.md). Bundled
// seeds take only security/compat fixes — feature work happens in the successor repo.
//
// Apify provider plugin — runs any Apify actor and maps its dataset items to
// the {title, url, company, location} Job shape the scanner expects, plus
// description, note (the local:jds/ cache reference) and postedAt when the
// field_map asks for them. All variation (which actor, what input, how to read fields) lives in portals.yml.
//
// Ported from the generic Apify provider contributed by @ageem23 in #693 (with
// thanks); it also homes the LinkedIn-via-Apify use case from #791/#1202. As a
// KEYED provider it lives here in plugins/ (not the zero-key providers/ dir):
// enable it in config/plugins.yml and put APIFY_TOKEN in .env. It fires ONLY on
// a portals.yml entry that sets `provider: apify` — never via auto-detection.
//
//   tracked_companies:
//     - name: "Indeed — VP Engineering (Chicago)"
//       provider: apify
//       actor: misceres/indeed-scraper
//       input: { position: "VP of Engineering", location: "Chicago, IL", maxItems: 25 }
//       field_map:
//         title:    [positionName, title]    # array = first non-empty wins
//         url:      url
//         company:  [company, companyName]
//         location: [location, formattedLocation]

import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { hasToken, runActor, readRunStatus, readRunItems } from './_apify.mjs';

const JDS_DIR = 'jds';
const MIN_JD_BODY_CHARS = 50;

// Runs this plugin gave up on (the Mac slept through the wait, or the dataset
// read failed) and reads at the next scan of the same entry. One line per run:
// entry name, actor, run id, time recorded (ISO UTC), tab-separated. Resolved
// against the same folder as jds/, so data/ and jds/ are siblings.
const UNREAD_RUNS_FILE = join('data', 'apify-unread-runs.tsv');
// Apify keeps an unnamed dataset for 7 days.
const UNREAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNREAD_DROP_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT']);

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// A valid field_map entry is a single key ('positionName') or an ordered list
// of fallback keys (['positionName', 'title']). Reject any other shape at
// config-load time with a clear error instead of crashing mid-scan.
export function isFieldSpec(spec) {
  if (typeof spec === 'string') return true;
  if (Array.isArray(spec) && spec.length > 0 && spec.every(s => typeof s === 'string')) return true;
  return false;
}

function pickField(item, spec) {
  const keys = Array.isArray(spec) ? spec : [spec];
  for (const k of keys) {
    const v = getPath(item, k);
    if (v != null && v !== '') return v;
  }
  return '';
}

const ALLOWED_DEFAULT_KEYS = new Set(['title', 'url', 'company', 'location']);

const MIN_POSTED_AT_MS = Date.UTC(2000, 0, 1);
const MAX_POSTED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
// Below this a number is epoch seconds (1e11 s is the year 5138); at or above
// it, epoch milliseconds (1e11 ms is March 1973).
const EPOCH_SECONDS_LIMIT = 1e11;

// Job.postedAt is epoch ms. Accept a finite number (epoch seconds or ms, told
// apart by magnitude) or an absolute date string. Return null for anything
// else, before 2000, or more than a day ahead: an omitted date is better than a
// wrong one. Date.parse reads loose text ("not a date 5" is May 2001), so a
// string must carry a four-digit year and at least one other number; relative
// English ("3 days ago") is not read.
export function parsePostedAt(value, now = Date.now()) {
  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = Math.abs(value) < EPOCH_SECONDS_LIMIT ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (/\b(?:19|20)\d{2}\b/.test(s) && (s.match(/\d+/g) || []).length >= 2) ms = Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  if (ms < MIN_POSTED_AT_MS || ms > now + MAX_POSTED_AT_SKEW_MS) return null;
  return ms;
}

// Actors return URLs from arbitrary external sites — treat them as untrusted.
// Reject anything that isn't https so javascript:/data:/file:/http: URLs can't
// end up clickable in pipeline.md or in the JD-cache filename hash.
export function isHttpsUrl(value) {
  try {
    return new URL(String(value)).protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (slug) return slug;
  const hash = createHash('sha1').update(String(text || '')).digest('hex').slice(0, 10);
  return `jd-${hash}`;
}

function yamlEscape(str) {
  const s = String(str ?? '').replace(/\n/g, ' ').trim();
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Lightweight HTML → text for actor description fields (enough for downstream
// snippet extraction and full evaluation, not a full parser).
export function htmlToText(s) {
  const raw = String(s || '');
  if (!raw || !/[<&]/.test(raw)) return raw.trim();
  let cleaned = raw
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n');
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/<[^>]+>/g, '');
  } while (cleaned !== prev);
  return cleaned
    // Decode &amp; LAST so `&amp;#60;` round-trips to `&#60;` not `<`.
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Write jds/{slug}-{hash}.md and return its relative path. The URL-derived hash
// keeps two distinct postings sharing a company+title from colliding. Atomic
// (flag:'wx') against the 10-worker TOCTOU race; any FS failure returns null, and
// the Job keeps its URL and description and gets no note.
function saveJd(normalized, descriptionBody, sourceLabel) {
  let relPath = null;
  try {
    mkdirSync(JDS_DIR, { recursive: true });
    const baseSlug = slugify(`${normalized.company}-${normalized.title}`);
    const urlHash = createHash('sha1')
      .update(String(normalized.url || `${normalized.company}-${normalized.title}`))
      .digest('hex')
      .slice(0, 10);
    const filename = `${baseSlug}-${urlHash}.md`;
    const filepath = join(JDS_DIR, filename);
    relPath = `${JDS_DIR}/${filename}`;
    if (existsSync(filepath)) return relPath;
    const today = new Date().toISOString().slice(0, 10);
    const content = `---
title: ${yamlEscape(normalized.title)}
company: ${yamlEscape(normalized.company)}
url: ${yamlEscape(normalized.url)}
location: ${yamlEscape(normalized.location)}
scraped: "${today}"
source: ${sourceLabel}
---

# ${normalized.title} — ${normalized.company}

${descriptionBody}
`;
    writeFileSync(filepath, content, { encoding: 'utf-8', flag: 'wx' });
    return relPath;
  } catch (err) {
    if (err?.code === 'EEXIST' && relPath) return relPath;
    console.warn(`apify: JD cache write failed for ${normalized.title} (${err.code || err.name}: ${err.message}); keeping the URL and description, no local:jds note`);
    return null;
  }
}

export function normalizeItem(item, fieldMap, defaults) {
  const out = {
    title: String(pickField(item, fieldMap.title) || ''),
    url: String(pickField(item, fieldMap.url) || ''),
    company: fieldMap.company ? String(pickField(item, fieldMap.company) || '') : '',
    location: fieldMap.location ? String(pickField(item, fieldMap.location) || '') : '',
  };
  for (const [k, v] of Object.entries(defaults || {})) {
    if (!ALLOWED_DEFAULT_KEYS.has(k)) continue;
    if (!out[k]) out[k] = String(v);
  }
  if (fieldMap.posted_at != null) {
    const postedAt = parsePostedAt(pickField(item, fieldMap.posted_at));
    if (postedAt !== null) out.postedAt = postedAt;
  }
  return out;
}

function tsvField(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function parseUnreadLine(line) {
  const [name = '', actor = '', runId = '', recordedAt = ''] = line.split('\t');
  return { name, actor, runId, recordedAt };
}

function isStaleUnread(recordedAt, now) {
  const t = Date.parse(recordedAt);
  return Number.isFinite(t) && now - t >= UNREAD_MAX_AGE_MS;
}

function readUnreadText() {
  try {
    return readFileSync(UNREAD_RUNS_FILE, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  }
}

// One synchronous step with no await inside, so two feeds fetching at the same
// time can never interleave here: re-read the file, drop every line 7 days old
// or more whatever its entry, apply only this fetch's own additions and
// removals by run id, then write a temp file and rename it over the old one.
// Writes only when a line changes.
function updateUnreadRuns(additions, removeIds) {
  if (additions.length === 0 && removeIds.size === 0) return;
  const before = readUnreadText();
  const now = Date.now();
  const lines = before.split('\n').filter(l => l.trim() !== '').filter(l => {
    const r = parseUnreadLine(l);
    return !isStaleUnread(r.recordedAt, now) && !removeIds.has(r.runId);
  });
  const ids = new Set(lines.map(l => parseUnreadLine(l).runId));
  for (const r of additions) {
    if (ids.has(r.runId)) continue;
    lines.push([r.name, r.actor, r.runId, r.recordedAt].map(tsvField).join('\t'));
    ids.add(r.runId);
  }
  const after = lines.length ? `${lines.join('\n')}\n` : '';
  if (after === before) return;
  mkdirSync(dirname(UNREAD_RUNS_FILE), { recursive: true });
  const tmp = `${UNREAD_RUNS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, after, 'utf-8');
  renameSync(tmp, UNREAD_RUNS_FILE);
}

// Read this entry's earlier runs. Returns their items and the run ids whose
// lines can go. Never throws: an error on an earlier run is one log line, and
// the line stays for the next scan unless the run is gone for good.
async function readEarlierRuns(entry, token) {
  const items = [];
  const removeIds = new Set();
  let lines;
  try {
    const name = tsvField(entry.name);
    lines = readUnreadText().split('\n').filter(l => l.trim() !== '').map(parseUnreadLine).filter(r => r.name === name);
  } catch (err) {
    console.warn(`apify: ${entry.name}: could not read ${UNREAD_RUNS_FILE} (${err.code || err.name}: ${err.message}); earlier runs not read`);
    return { items, removeIds };
  }
  const now = Date.now();
  for (const r of lines) {
    if (r.actor !== String(entry.actor)) {
      removeIds.add(r.runId);
      console.log(`apify: ${entry.name}: dropped earlier run ${r.runId} (actor ${r.actor}, the entry now uses ${entry.actor})`);
      continue;
    }
    if (isStaleUnread(r.recordedAt, now)) {
      removeIds.add(r.runId);
      console.log(`apify: ${entry.name}: dropped earlier run ${r.runId} (recorded ${r.recordedAt}, 7 days or more ago)`);
      continue;
    }
    try {
      const run = await readRunStatus(r.runId, token);
      if (run.status === 'SUCCEEDED') {
        const runItems = await readRunItems(r.runId, token);
        items.push(...runItems);
        removeIds.add(r.runId);
        console.log(`apify: ${entry.name}: read ${runItems.length} items from earlier run ${r.runId} (recorded ${r.recordedAt})`);
      } else if (UNREAD_DROP_STATUSES.has(run.status)) {
        removeIds.add(r.runId);
        console.log(`apify: ${entry.name}: dropped earlier run ${r.runId} (status ${run.status})`);
      } else {
        console.log(`apify: ${entry.name}: earlier run ${r.runId} not read (status ${run.status}); kept for the next scan`);
      }
    } catch (err) {
      if (err?.status === 404) {
        removeIds.add(r.runId);
        console.warn(`apify: ${entry.name}: dropped earlier run ${r.runId} (${err.message})`);
      } else {
        console.warn(`apify: ${entry.name}: earlier run ${r.runId} not read (${err?.message}); kept for the next scan`);
      }
    }
  }
  return { items, removeIds };
}

/** The keyed provider hook. Reads APIFY_TOKEN from the plugin's scoped ctx.env. */
export default {
  provider: {
    id: 'apify',
    // Keyed providers never auto-detect (the engine also forces this to null).
    detect() { return null; },

    async fetch(entry, ctx) {
      const token = ctx?.env?.APIFY_TOKEN || process.env.APIFY_TOKEN;
      if (!hasToken(token)) {
        throw new Error('APIFY_TOKEN not set — enable apify in config/plugins.yml and add the token to .env');
      }
      if (!entry.actor) {
        throw new Error(`apify: entry ${entry.name} missing 'actor' (e.g. misceres/indeed-scraper)`);
      }
      if (
        !entry.field_map ||
        !isFieldSpec(entry.field_map.title) ||
        !isFieldSpec(entry.field_map.url) ||
        (entry.field_map.company != null && !isFieldSpec(entry.field_map.company)) ||
        (entry.field_map.location != null && !isFieldSpec(entry.field_map.location)) ||
        (entry.field_map.description != null && !isFieldSpec(entry.field_map.description)) ||
        (entry.field_map.posted_at != null && !isFieldSpec(entry.field_map.posted_at))
      ) {
        throw new Error(
          `apify: entry ${entry.name} has invalid field_map. Each of title, url, company, ` +
          `location, description, posted_at must be a string or a non-empty array of strings. title and url are required.`
        );
      }

      const opts = { token };
      if (entry.timeout_ms != null) opts.timeoutMs = entry.timeout_ms;
      // A dry run reads earlier runs but never adds or removes a line.
      const dryRun = ctx?.dryRun === true;
      let items;
      try {
        items = await runActor(entry.actor, entry.input || {}, opts);
      } catch (err) {
        // A run given up on, or finished with its items unread: record it so the
        // next scan of this entry reads it. The feed still reports this error.
        if (err?.runId && !dryRun) {
          try {
            updateUnreadRuns(
              [{ name: entry.name, actor: entry.actor, runId: err.runId, recordedAt: new Date().toISOString() }],
              new Set(),
            );
          } catch (recordErr) {
            console.warn(`apify: ${entry.name}: could not record run ${err.runId} in ${UNREAD_RUNS_FILE} (${recordErr.code || recordErr.name}: ${recordErr.message})`);
          }
        }
        throw err;
      }

      const earlier = await readEarlierRuns(entry, token);
      if (earlier.items.length) items = items.concat(earlier.items);
      if (earlier.removeIds.size && !dryRun) {
        try {
          updateUnreadRuns([], earlier.removeIds);
        } catch (err) {
          console.warn(`apify: ${entry.name}: could not update ${UNREAD_RUNS_FILE} (${err.code || err.name}: ${err.message})`);
        }
      }

      const useLocalJd = entry.field_map.description != null;
      const sourceLabel = String(entry.actor || 'apify').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

      return items
        .map(item => {
          const normalized = normalizeItem(item, entry.field_map, entry.defaults);
          if (!normalized.title || !normalized.url) return null;
          if (!isHttpsUrl(normalized.url)) return null;
          if (!useLocalJd) return normalized;
          const descriptionBody = htmlToText(pickField(item, entry.field_map.description));
          if (!descriptionBody || descriptionBody.length < MIN_JD_BODY_CHARS) {
            return normalized;
          }
          // Job.url is the dedup key and must stay the posting URL; the text goes
          // in Job.description (read by content_filter) and the cache reference
          // rides as a note, in the `local:jds/` form the modes already read.
          normalized.description = descriptionBody;
          const jdPath = saveJd(normalized, descriptionBody, sourceLabel);
          if (jdPath !== null) normalized.note = `local:${jdPath}`;
          return normalized;
        })
        .filter(j => j && j.title && j.url);
    },
  },
};
