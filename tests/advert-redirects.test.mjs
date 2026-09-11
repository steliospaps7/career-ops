/**
 * tests/advert-redirects.test.mjs — the fetch guard on the reader's transport.
 *
 * `providers/ADDING_A_PROVIDER.md` says a provider passes `redirect: 'error'`,
 * because a server-side redirect can point a request at an internal address.
 * The reader cannot refuse redirects outright — an aggregator's apply link is a
 * redirect by design, and story 5 asks for the URL it lands on — so it follows
 * them one hop at a time and inspects each destination instead.
 *
 * `globalThis.fetch` is stubbed here; nothing in this file touches the network.
 *
 * Run: node test-all.mjs --only advert-redirects
 */

import { httpGet, MAX_REDIRECT_HOPS } from '../providers/_advert-reader.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\n_advert-reader.mjs — the redirect guard');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const realFetch = globalThis.fetch;

/** Stub fetch with a map of url → {status, location, body}. Records every call. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), redirect: opts?.redirect });
    const hit = routes[String(url)] || { status: 404, body: 'not found' };
    const headers = new Headers();
    if (hit.location) headers.set('location', hit.location);
    return {
      status: hit.status,
      url: String(url),
      headers,
      text: async () => hit.body ?? '',
    };
  };
  return calls;
}

try {
  // ── A plain 200 is one hop ────────────────────────────────────────
  {
    const calls = stubFetch({ 'https://a.example/1': { status: 200, body: 'hello' } });
    const res = await httpGet('https://a.example/1');
    eq('one hop for a 200', calls.length, 1);
    eq('the transport never asks fetch to follow for it', calls[0].redirect, 'manual');
    eq('status', res.status, 200);
    eq('body', res.body, 'hello');
    eq('final URL is the URL asked for', res.finalUrl, 'https://a.example/1');
  }

  // ── A redirect is followed, and the final URL is the landing page ─
  {
    const calls = stubFetch({
      'https://a.example/1': { status: 302, location: 'https://b.example/2' },
      'https://b.example/2': { status: 200, body: 'the advert' },
    });
    const res = await httpGet('https://a.example/1');
    eq('two hops', calls.length, 2);
    eq('the second hop is the destination', calls[1].url, 'https://b.example/2');
    eq('the body is the destination\'s', res.body, 'the advert');
    eq('the final URL is where it landed', res.finalUrl, 'https://b.example/2');
  }

  // ── A relative Location is resolved against the hop it came from ──
  {
    const calls = stubFetch({
      'https://a.example/jobs/1': { status: 301, location: '/postings/9' },
      'https://a.example/postings/9': { status: 200, body: 'the advert' },
    });
    await httpGet('https://a.example/jobs/1');
    eq('a relative Location resolves against the current hop', calls[1].url, 'https://a.example/postings/9');
  }

  // ── A redirect to http is refused, not followed ───────────────────
  {
    const calls = stubFetch({
      'https://a.example/1': { status: 302, location: 'http://internal.example/admin' },
    });
    const res = await httpGet('https://a.example/1');
    eq('the plain-http destination is never fetched', calls.length, 1);
    ok('and the result is not a success', res.status !== 200);
    eq('the final URL stays the last https hop', res.finalUrl, 'https://a.example/1');
  }
  for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://internal.example/x']) {
    const calls = stubFetch({ 'https://a.example/1': { status: 302, location: target } });
    await httpGet('https://a.example/1');
    eq(`a redirect to ${target.split(':')[0]}: is refused`, calls.length, 1);
  }

  // ── A redirect chain is bounded ───────────────────────────────────
  {
    const routes = {};
    for (let i = 0; i < 20; i++) routes[`https://a.example/${i}`] = { status: 302, location: `https://a.example/${i + 1}` };
    const calls = stubFetch(routes);
    const res = await httpGet('https://a.example/0');
    ok(`at most ${MAX_REDIRECT_HOPS} redirects are followed`, calls.length <= MAX_REDIRECT_HOPS + 1);
    ok('and the caller gets a result rather than an endless loop', typeof res.status === 'number');
  }

  // ── A redirect loop ends ──────────────────────────────────────────
  {
    const calls = stubFetch({
      'https://a.example/1': { status: 302, location: 'https://a.example/2' },
      'https://a.example/2': { status: 302, location: 'https://a.example/1' },
    });
    const res = await httpGet('https://a.example/1');
    ok('a loop is bounded too', calls.length <= MAX_REDIRECT_HOPS + 1);
    ok('and it returns rather than hanging', res != null);
  }

  // ── A 3xx with no Location is the end of the road ─────────────────
  {
    const calls = stubFetch({ 'https://a.example/1': { status: 302, body: '' } });
    const res = await httpGet('https://a.example/1');
    eq('nothing further is fetched', calls.length, 1);
    eq('the status comes back as it was', res.status, 302);
  }
} finally {
  globalThis.fetch = realFetch;
}
