/**
 * tests/advert-route-table.test.mjs — seam 1 of ticket B1.
 *
 * `resolveReadRoute(url)` is pure: a URL in, a fetch plan out. Nothing here
 * touches the network, and nothing here asserts how a fetch is made — only
 * which endpoint the ladder's first rung would ask, and with which org and id.
 *
 * Run: node test-all.mjs --only advert-route-table
 */

import { resolveReadRoute } from '../providers/_advert-reader.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\n_advert-reader.mjs — the route table (seam 1)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Ashby ───────────────────────────────────────────────────────────
{
  const r = resolveReadRoute('https://jobs.ashbyhq.com/openai/8f5b1c2d-1111-2222-3333-444455556666');
  eq('ashby: host recognised', r?.host, 'ashby');
  eq('ashby: reads the board feed', r?.kind, 'feed');
  eq(
    'ashby: feed URL carries the org',
    r?.url,
    'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true',
  );
  eq('ashby: org captured', r?.org, 'openai');
  eq('ashby: job id captured', r?.jobId, '8f5b1c2d-1111-2222-3333-444455556666');
  eq('ashby: the page URL is kept for the fallback', r?.pageUrl, 'https://jobs.ashbyhq.com/openai/8f5b1c2d-1111-2222-3333-444455556666');
  eq('ashby: feed is JSON', r?.format, 'json');
}

// ── Workable ────────────────────────────────────────────────────────
{
  const r = resolveReadRoute('https://apply.workable.com/acme-ltd/j/A1B2C3D4E5/');
  eq('workable: host recognised', r?.host, 'workable');
  eq(
    'workable: per-job JSON endpoint',
    r?.url,
    'https://apply.workable.com/api/v2/accounts/acme-ltd/jobs/A1B2C3D4E5',
  );
  eq('workable: account captured', r?.org, 'acme-ltd');
  eq('workable: shortcode captured', r?.jobId, 'A1B2C3D4E5');
}

// ── Lever ───────────────────────────────────────────────────────────
{
  const r = resolveReadRoute('https://jobs.lever.co/coalfire/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00');
  eq('lever: host recognised', r?.host, 'lever');
  eq(
    'lever: per-posting JSON endpoint',
    r?.url,
    'https://api.lever.co/v0/postings/coalfire/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00?mode=json',
  );
  eq('lever: org captured', r?.org, 'coalfire');
}

// ── Greenhouse ──────────────────────────────────────────────────────
{
  const r = resolveReadRoute('https://boards.greenhouse.io/stripe/jobs/5551234');
  eq('greenhouse: host recognised', r?.host, 'greenhouse');
  eq(
    'greenhouse: per-job board API endpoint',
    r?.url,
    'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/5551234',
  );
  eq('greenhouse: org captured', r?.org, 'stripe');
  eq('greenhouse: job id captured', r?.jobId, '5551234');
}
{
  // The newer host name serves the same boards and must resolve identically.
  const r = resolveReadRoute('https://job-boards.greenhouse.io/stripe/jobs/5551234');
  eq('greenhouse: job-boards host resolves the same', r?.url, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/5551234');
}

// ── LinkedIn ────────────────────────────────────────────────────────
{
  const r = resolveReadRoute('https://www.linkedin.com/jobs/view/3901234567/');
  eq('linkedin: host recognised', r?.host, 'linkedin');
  eq(
    'linkedin: guest posting endpoint',
    r?.url,
    'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/3901234567',
  );
  eq('linkedin: the guest endpoint returns markup, not JSON', r?.format, 'html');
  eq('linkedin: job id captured', r?.jobId, '3901234567');
}
{
  // Search pages carry the posting id in a query parameter instead of the path.
  const r = resolveReadRoute('https://www.linkedin.com/jobs/search/?currentJobId=3901234567&keywords=analyst');
  eq('linkedin: currentJobId is read from the query', r?.jobId, '3901234567');
}

// ── The EU hosts the ATS resolver already knew about ────────────────
{
  const r = resolveReadRoute('https://jobs.eu.lever.co/coalfire/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00');
  eq('lever EU: host recognised', r?.host, 'lever');
  eq(
    'lever EU: the API host follows the board host',
    r?.url,
    'https://api.eu.lever.co/v0/postings/coalfire/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00?mode=json',
  );
}
{
  const r = resolveReadRoute('https://job-boards.eu.greenhouse.io/stripe/jobs/5551234');
  eq('greenhouse EU: resolves to the same board API', r?.url, 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/5551234');
}

// ── The SSRF guard on every value taken out of the URL ──────────────
// resolveAtsApi's isSafeValue is what stands between a path segment and a URL
// this reader will fetch. A segment outside its charset resolves to a plain
// page fetch of the original URL, never to a feed built from it.
for (const bad of [
  'https://boards.greenhouse.io/..%2f..%2fadmin/jobs/5551234',
  'https://jobs.ashbyhq.com/org%20with%20space/8f5b1c2d-1111-2222-3333-444455556666',
  'https://apply.workable.com/acc$ount/j/A1B2C3D4E5/',
]) {
  const r = resolveReadRoute(bad);
  ok(`an unsafe path segment claims no feed: ${bad}`, r === null || r.kind === 'page');
  if (r) eq('  and the page route fetches the URL it was given, unchanged', r.url, bad);
}

// ── Workday is left to the browser rung ─────────────────────────────
{
  // browser-extract.mjs already reads Workday through its CXS endpoint, so the
  // reader claims no feed here rather than growing a sixth one.
  const r = resolveReadRoute('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/London/Analyst_R123456');
  eq('workday: no feed claimed', r?.kind, 'page');
  eq('workday: no host route', r?.host, null);
}

// ── Unknown host ────────────────────────────────────────────────────
{
  const r = resolveReadRoute('https://careers.example.com/roles/analyst-42');
  eq('unknown host: falls back to a plain page fetch', r?.kind, 'page');
  eq('unknown host: no known feed', r?.host, null);
  eq('unknown host: fetches the URL it was given', r?.url, 'https://careers.example.com/roles/analyst-42');
  eq('unknown host: page format', r?.format, 'html');
}

// ── Known host, wrong shape ─────────────────────────────────────────
{
  // A board landing page, not a posting: no id to ask the feed for.
  const r = resolveReadRoute('https://jobs.lever.co/coalfire');
  eq('lever board root: no feed, plain page', r?.kind, 'page');
  eq('lever board root: no host route claimed', r?.host, null);
}

// ── Malformed ───────────────────────────────────────────────────────
for (const bad of ['', 'not a url', 'javascript:alert(1)', 'local:jds/foo.md', null, undefined, 42, {}]) {
  const label = `malformed input ${JSON.stringify(bad)} returns null and does not throw`;
  let result;
  try {
    result = resolveReadRoute(bad);
  } catch (err) {
    fail(`${label} — threw ${err.message}`);
    continue;
  }
  ok(label, result === null);
}

// A non-https scheme is not a posting the reader may fetch.
eq('http URLs are refused (https only, like the apify guard)', resolveReadRoute('http://careers.example.com/x'), null);
