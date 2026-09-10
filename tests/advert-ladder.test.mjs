/**
 * tests/advert-ladder.test.mjs — seam 2 of ticket B1.
 *
 * `readAdvert(url, transports)` walks five rungs and stops at the first that
 * returns real text. Every transport is injected, so the suite drives the whole
 * ladder from fixtures and no test here touches the network. The assertions are
 * about what the reader concluded — status, rung, final URL — never about how a
 * fetch was made.
 *
 * Run: node test-all.mjs --only advert-ladder
 */

import { readAdvert, mapLivenessToReadStatus, MIN_ADVERT_CHARS, ADVERT_TEXT_CAP } from '../providers/_advert-reader.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\n_advert-reader.mjs — the ladder (seam 2)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A body comfortably over the minimum, with none of the expired or bot-challenge
// wording, so classification turns on the fetch outcome and not on the prose.
const REAL_ADVERT = `We are hiring a Programme Manager to run delivery across three teams. ${'You will own the roadmap, the reporting line and the weekly review. '.repeat(8)}`;
ok('fixture advert is over the minimum', REAL_ADVERT.length > MIN_ADVERT_CHARS);

const SHELL_PAGE = '<html><body><div id="root"></div></body></html>';
const BOT_PAGE = '<html><body><h1>Just a moment...</h1><p>Ray ID: 8ab</p></body></html>';
const EXPIRED_PAGE = `<html><body><p>This job is no longer available.</p>${'Filler text to clear the length floor. '.repeat(12)}</body></html>`;

function pageBody(text, { apply = true } = {}) {
  const button = apply ? '<a href="/apply/1">Apply now</a>' : '';
  return `<html><body><h1>Role</h1><p>${text}</p>${button}</body></html>`;
}

/** A transport set that fails everything unless a case overrides a member. */
function transports(overrides = {}) {
  return {
    fetchText: async () => { throw new Error('fetchText not stubbed for this case'); },
    fetchJson: async () => { throw new Error('fetchJson not stubbed for this case'); },
    browser: async () => { throw new Error('browser not stubbed for this case'); },
    ...overrides,
  };
}

// ── The status mapping is the spec's table, and it is pure ──────────
{
  eq('apply_control_visible maps to read', mapLivenessToReadStatus('apply_control_visible'), 'read');
  for (const code of ['access_blocked', 'bot_challenge', 'server_error']) {
    eq(`${code} maps to blocked`, mapLivenessToReadStatus(code), 'blocked');
  }
  for (const code of ['insufficient_content', 'listing_page', 'redirected_off_posting', 'no_apply_control']) {
    eq(`${code} maps to shell`, mapLivenessToReadStatus(code), 'shell');
  }
  for (const code of ['expired_body', 'expired_url', 'http_gone']) {
    eq(`${code} maps to expired`, mapLivenessToReadStatus(code), 'expired');
  }
  eq('an unknown code maps to shell rather than throwing', mapLivenessToReadStatus('something_new'), 'shell');
}

// ── Rung 1: a page that returns text stops there ────────────────────
{
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 200, body: pageBody(REAL_ADVERT), finalUrl: url }),
  }));
  eq('page: status read', r.status, 'read');
  eq('page: rung recorded as page', r.rung, 'page');
  ok('page: the advert text came back', r.text.includes('Programme Manager'));
  eq('page: final URL recorded', r.finalUrl, 'https://careers.example.com/roles/42');
  eq('page: nothing reached the paid rung', r.reachedFirecrawl, false);
}

// ── Rung 1: a known host reads its feed and records `feed` ──────────
{
  let pageFetched = false;
  const r = await readAdvert('https://boards.greenhouse.io/stripe/jobs/5551234', transports({
    fetchJson: async () => ({ status: 200, json: { id: 5551234, content: `<p>${REAL_ADVERT}</p>` }, finalUrl: 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs/5551234' }),
    fetchText: async (url) => { pageFetched = true; return { status: 200, body: pageBody(REAL_ADVERT), finalUrl: url }; },
  }));
  eq('feed: status read', r.status, 'read');
  eq('feed: rung recorded as feed', r.rung, 'feed');
  ok('feed: the advert text came back', r.text.includes('Programme Manager'));
  ok('feed: the plain page was never fetched', pageFetched === false);
  eq('feed: the final URL is the posting the user applies through', r.finalUrl, 'https://boards.greenhouse.io/stripe/jobs/5551234');
}

// ── Rung 1: the Ashby board feed is a whole board, and the right job is picked
{
  const wanted = '8f5b1c2d-1111-2222-3333-444455556666';
  const r = await readAdvert(`https://jobs.ashbyhq.com/openai/${wanted}`, transports({
    fetchJson: async () => ({
      status: 200,
      finalUrl: 'https://api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true',
      json: {
        jobs: [
          { id: 'other-id', descriptionPlain: 'A different role entirely, and long enough to pass. '.repeat(12) },
          { id: wanted, descriptionPlain: REAL_ADVERT },
        ],
      },
    }),
  }));
  eq('ashby feed: status read', r.status, 'read');
  ok('ashby feed: the requested job was picked out of the board', r.text.includes('Programme Manager'));
}

// ── Rung 1 → 2: a 403 on the page, and the apply link pays ─────────
// A blocked page carries no markup to read a control out of, so the apply
// destination here is the one the board's own feed named.
{
  const calls = [];
  const r = await readAdvert('https://jobs.lever.co/coalfire/1a2b3c4d-5e6f-7788-99aa-bbccddeeff00', transports({
    fetchJson: async (url) => ({
      status: 200,
      finalUrl: url,
      json: { descriptionPlain: 'too short', applyUrl: 'https://ats.example.net/posting/42' },
    }),
    fetchText: async (url) => {
      calls.push(url);
      if (url.includes('jobs.lever.co')) {
        return { status: 403, body: 'Forbidden', finalUrl: url };
      }
      return { status: 200, body: pageBody(REAL_ADVERT), finalUrl: 'https://ats.example.net/posting/42' };
    },
  }));
  eq('apply link: status read', r.status, 'read');
  eq('apply link: rung recorded', r.rung, 'apply-link');
  ok('apply link: the page was tried first', calls[0].includes('jobs.lever.co'));
  ok('apply link: the blocked page was named as a failure', r.failures.some(f => f.rung === 'page' && f.status === 'blocked'));
  ok('apply link: the thin feed was named as a failure too', r.failures.some(f => f.rung === 'feed' && f.status === 'shell'));
  eq('apply link: the final URL is where the advert was read', r.finalUrl, 'https://ats.example.net/posting/42');
}
{
  // The apply href is read out of the page the reader already has, and resolved
  // against it, so a relative href reaches the right host.
  const seen = [];
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => {
      seen.push(url);
      if (url === 'https://careers.example.com/roles/42') {
        return { status: 200, body: `<html><body><p>short</p><a href="/apply/42">Apply for this job</a></body></html>`, finalUrl: url };
      }
      return { status: 200, body: pageBody(REAL_ADVERT), finalUrl: 'https://ats.example.net/posting/42' };
    },
  }));
  eq('apply link: a shell page falls through to its apply destination', r.status, 'read');
  eq('apply link: relative href resolved against the page', seen[1], 'https://careers.example.com/apply/42');
  eq('apply link: the final URL is the destination after redirects', r.finalUrl, 'https://ats.example.net/posting/42');
}

// ── A 200 that is a shell never yields `read` ───────────────────────
{
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 200, body: SHELL_PAGE, finalUrl: url }),
    browser: async () => { throw new Error('browser unavailable'); },
  }));
  ok('shell: never read', r.status !== 'read');
  eq('shell: ends unreadable when no later rung pays', r.status, 'unreadable');
  ok('shell: the shell was named as a failure', r.failures.some(f => f.rung === 'page' && f.status === 'shell'));
}

// ── A bot challenge records `blocked` and moves on ──────────────────
{
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 200, body: BOT_PAGE, finalUrl: url }),
    browser: async (url) => ({ status: 200, text: REAL_ADVERT, finalUrl: url }),
  }));
  ok('bot challenge: recorded as blocked', r.failures.some(f => f.rung === 'page' && f.status === 'blocked'));
  eq('bot challenge: the browser rung then read it', r.status, 'read');
  eq('bot challenge: rung recorded as browser', r.rung, 'browser');
}

// ── An expired body on the board's own page ends the ladder ─────────
{
  let laterRung = false;
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 200, body: EXPIRED_PAGE, finalUrl: url }),
    browser: async () => { laterRung = true; throw new Error('should not be reached'); },
  }));
  eq('expired: status expired', r.status, 'expired');
  eq('expired: the ladder stopped at the page', r.rung, 'page');
  ok('expired: no later rung was tried', laterRung === false);
  eq('expired: nothing reached the paid rung', r.reachedFirecrawl, false);
}

// ── Every rung failing yields `unreadable`, and counts the residue ──
{
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 403, body: 'Forbidden', finalUrl: url }),
    browser: async () => { throw new Error('playwright: navigation timeout'); },
  }));
  eq('exhausted: status unreadable', r.status, 'unreadable');
  eq('exhausted: no rung produced text', r.rung, null);
  eq('exhausted: the last failure is named', r.failedAt, 'browser');
  eq('exhausted: and its kind is named', r.failedAs, 'blocked');
  eq('exhausted: counted against the Firecrawl residue', r.reachedFirecrawl, true);
  ok('exhausted: the text is empty, never a partial page', r.text === '');
}
{
  // The paid rung is a switch and a count in B1. Nothing calls Firecrawl, and
  // no transport for it exists to call.
  let firecrawlCalled = false;
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 403, body: 'Forbidden', finalUrl: url }),
    browser: async () => { throw new Error('blocked'); },
    firecrawl: async () => { firecrawlCalled = true; return { status: 200, text: REAL_ADVERT }; },
  }), { firecrawlEnabled: true });
  ok('firecrawl: never called even when the switch is on', firecrawlCalled === false);
  eq('firecrawl: the row is still unreadable', r.status, 'unreadable');
  eq('firecrawl: and still counted as residue', r.reachedFirecrawl, true);
}

// ── One row failing is one row, never the run ───────────────────────
{
  let threw = false;
  let r;
  try {
    r = await readAdvert('https://careers.example.com/roles/42', transports({
      fetchText: async () => { throw new Error('fetch failed'); },
      browser: async () => { throw new Error('fetch failed'); },
    }));
  } catch {
    threw = true;
  }
  ok('a network failure on every rung is returned, not thrown', threw === false);
  eq('a network failure ends as unreadable', r?.status, 'unreadable');
}

// ── A long advert is kept whole, not cut at the scan-payload cap ────
// A years clause or a visa line often sits well past 4 KB. The shared
// html-to-text helper caps a scan payload there; the reader passes its own,
// larger cap, and a filter phrase at 9 KB has to survive.
{
  const filler = 'This paragraph exists only to push the requirements section further down the page. '.repeat(120);
  const html = `<html><body><p>${filler}</p><p>You will need 7+ years of experience in this field.</p><a href="/apply">Apply</a></body></html>`;
  ok('the fixture is longer than the scan-payload cap', html.length > 4000);
  const r = await readAdvert('https://careers.example.com/roles/42', transports({
    fetchText: async (url) => ({ status: 200, body: html, finalUrl: url }),
  }));
  eq('long advert: status read', r.status, 'read');
  ok('the clause past 4 KB survived into the stored text', r.text.includes('7+ years of experience'));
  ok('and the text is still capped somewhere sane', r.text.length <= ADVERT_TEXT_CAP);
}

// ── LinkedIn has no apply destination to follow ─────────────────────
{
  const seen = [];
  await readAdvert('https://www.linkedin.com/jobs/view/3901234567/', transports({
    fetchText: async (url) => {
      seen.push(url);
      return { status: 200, body: `<html><body><p>short</p><a href="/apply/x">Easy Apply</a></body></html>`, finalUrl: url };
    },
    browser: async () => { throw new Error('blocked'); },
  }));
  ok('linkedin: the Easy Apply control is not followed', seen.every(u => !u.includes('/apply/x')));
}
