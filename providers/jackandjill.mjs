// @ts-check
import { decodeEntities } from './_html-entities.mjs';
import { htmlToText } from './_html-to-text.mjs';

/** @typedef {import('./_types.js').Provider} Provider */

// Jack & Jill provider — the board-wide public XML feed at
// https://www.jackandjill.ai/jobs/feed.xml (an AI recruiter's in-house board;
// ~340 live roles, roughly a third of them London). The feed is public,
// no-auth, advertised in the site's own sitemap.xml, and NOT disallowed by
// robots.txt — unlike /jobs and /api/, which are, so the browsable board is
// never read here.
//
// Format is the standard `<source><job>` aggregator feed that LinkedIn and
// Indeed consume, not RSS, so the RSS providers (larajobs, nodesk, jobspresso)
// cannot read it. It is parsed in-process with the same tiny tag extractor
// larajobs.mjs uses rather than adding an XML dependency.
//
// Each <job> carries title, date, referencenumber, url, applyurl, company,
// city, location, country, workplaceTypes, description (CDATA HTML), salary,
// jobtype and expirationdate. `<date>` is the real posting date and spans
// nine months, so max_posting_age_days does the cutting — a reader that
// omitted it would silently disable the age filter for everything it returns.
//
// Wire in via an entry with `provider: jackandjill`.

const FEED_URL = 'https://www.jackandjill.ai/jobs/feed.xml';
const TRUSTED_HOST = 'www.jackandjill.ai';

/** @param {string} url */
function assertJackandjillUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jackandjill: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jackandjill: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`jackandjill: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry) {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Jack & Jill';
}

/** @type {Provider} */
export default {
  id: 'jackandjill',

  detect(entry) {
    return entry?.provider === 'jackandjill' ? { url: FEED_URL } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertJackandjillUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertJackandjillUrl above it keeps the request pinned to the feed host.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseJackandjillFeed(text, fallbackCompany(entry));
  },
};

// Resolve a tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

// Extract the text of the first <tag>...</tag> in a block. Returns '' when absent.
function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

// Keep only absolute HTTPS links hosted on the trusted board domain.
function cleanUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === TRUSTED_HOST
      ? parsed.href
      : '';
  } catch {
    return '';
  }
}

/**
 * Drop a trailing " at <company>" from a feed title. Every title in this feed
 * carries it ("Referral Partnerships Manager at DOSS"), and the company is
 * already its own field, so the suffix is pure duplication — and it defeats
 * the company+role dedup key against the same role reaching the pipeline from
 * LinkedIn or Indeed under its bare title.
 *
 * Matched EXACTLY against the feed's own company value, never by splitting on
 * " at ": a heuristic split would maul a title that legitimately contains it.
 *
 * @param {string} title
 * @param {string} company
 */
export function stripCompanySuffix(title, company) {
  if (!title || !company) return title;
  const suffix = ` at ${company}`;
  if (title.length <= suffix.length) return title;
  if (title.slice(-suffix.length).toLowerCase() !== suffix.toLowerCase()) return title;
  return title.slice(0, -suffix.length).trim() || title;
}

/**
 * Parse Jack & Jill's public jobs feed. Exported for unit tests.
 *
 * Shape: `<source><job>...</job>...</source>`. Field mapping → the normalized
 * Job shape:
 *   - title:       `<title>`, with the trailing " at <company>" removed
 *                  (postings without a title are dropped).
 *   - url:         `<url>`, host-locked to www.jackandjill.ai over HTTPS. An
 *                  off-host or non-https URL drops the posting. `<applyurl>`
 *                  is deliberately unused: it points at the same page.
 *   - company:     `<company>`, falling back to the entry name, then
 *                  "Jack & Jill". Many employers are anonymised in the feed
 *                  ("VC-backed clean energy startup") — that is the feed's
 *                  own masking, not a parse failure.
 *   - location:    `<location>`, with "Remote" appended when
 *                  `<workplaceTypes>` says so.
 *   - postedAt:    `<date>` ISO timestamp → epoch ms (omitted when absent or
 *                  unparseable).
 *   - description: `<description>` CDATA HTML → plain text, so the content
 *                  filter has something to read.
 *
 * @param {string} xml - raw feed body
 * @param {string} [defaultCompany] - fallback company when the feed omits one
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>}
 */
export function parseJackandjillFeed(xml, defaultCompany = 'Jack & Jill') {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim()
    ? defaultCompany.trim()
    : 'Jack & Jill';
  const jobs = [];
  const blocks = xml.match(/<job\b[^>]*>[\s\S]*?<\/job>/gi) || [];

  for (const block of blocks) {
    const url = cleanUrl(tagText(block, 'url'));
    if (!url) continue;

    const rawTitle = tagText(block, 'title');
    if (!rawTitle) continue;

    const company = tagText(block, 'company') || fallback;
    const title = stripCompanySuffix(rawTitle, company);

    const base = tagText(block, 'location');
    const remote = /remote/i.test(tagText(block, 'workplaceTypes'));
    const location = [base, remote ? 'Remote' : ''].filter(Boolean).join(', ');

    const job = { title, url, company, location };
    const description = htmlToText(tagText(block, 'description'));
    if (description) job.description = description;
    const postedAt = toEpochMs(tagText(block, 'date'));
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}
