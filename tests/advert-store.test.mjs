/**
 * tests/advert-store.test.mjs — seam 3 of ticket B1.
 *
 * The store is one Markdown file per advert under `jds/`, in the same filename
 * shape the apify plugin writes, so the two writers never collide and
 * `jd-capture.mjs` resolves both. This seam asserts what was written and what a
 * second call did, against a temporary directory.
 *
 * Run: node test-all.mjs --only advert-store
 */

import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { saveAdvert, findAdvert, loadAdvertText, advertFilename } from '../providers/_advert-reader.mjs';
import { pass, fail, rmSync } from './helpers.mjs';

console.log('\n_advert-reader.mjs — the store (seam 3)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dirs = [];
function tempJds() {
  const d = mkdtempSync(join(tmpdir(), 'co-advert-store-'));
  dirs.push(d);
  return join(d, 'jds');
}

const BODY = 'We are hiring a Programme Manager. '.repeat(20);

function record(overrides = {}) {
  return {
    url: 'https://careers.example.com/roles/42',
    company: 'Example Ltd',
    title: 'Programme Manager',
    location: 'London, UK',
    text: BODY,
    rung: 'page',
    status: 'read',
    finalUrl: 'https://ats.example.net/posting/42',
    fetchedAt: '2026-09-10T09:30:00.000Z',
    ...overrides,
  };
}

// ── The four new frontmatter fields ─────────────────────────────────
{
  const jdsDir = tempJds();
  const first = saveAdvert(record(), { jdsDir });
  ok('a path came back', typeof first.path === 'string' && first.path.endsWith('.md'));
  eq('the first write is not a reuse', first.reused, false);

  const raw = readFileSync(join(jdsDir, first.path.split('/').pop()), 'utf-8');
  ok('fetched_at is present and is the time it was fetched', raw.includes('fetched_at: "2026-09-10T09:30:00.000Z"'));
  ok('final_url is present and is the URL after redirects', raw.includes('final_url: "https://ats.example.net/posting/42"'));
  ok('read_rung is present and names the rung', raw.includes('read_rung: "page"'));
  ok('read_status is present', raw.includes('read_status: "read"'));

  // The six fields the apify plugin already writes stay, so one reader serves both.
  for (const field of ['title:', 'company:', 'url:', 'location:', 'scraped:', 'source:']) {
    ok(`the plugin's ${field.replace(':', '')} field is kept`, raw.includes(`\n${field}`));
  }
  ok('the posting URL in the frontmatter is the real one, not the final one', raw.includes('url: "https://careers.example.com/roles/42"'));
  ok('the advert body is in the file', raw.includes('Programme Manager'));
  ok('the path is relative to the repo, not absolute', first.path.startsWith('jds/'));
}

// ── Idempotent: a second call reuses, and re-reads nothing ──────────
{
  const jdsDir = tempJds();
  const first = saveAdvert(record(), { jdsDir });
  const before = readFileSync(join(jdsDir, first.path.split('/').pop()), 'utf-8');

  const second = saveAdvert(record({ text: 'DIFFERENT TEXT '.repeat(30), fetchedAt: '2027-01-01T00:00:00.000Z' }), { jdsDir });
  eq('the second call returns the same path', second.path, first.path);
  eq('the second call says it reused', second.reused, true);
  const after = readFileSync(join(jdsDir, first.path.split('/').pop()), 'utf-8');
  eq('the file on disk is untouched', after, before);
  eq('only one file exists', readdirSync(jdsDir).length, 1);
}

// ── findAdvert is what lets the caller skip the ladder ──────────────
{
  const jdsDir = tempJds();
  eq('nothing stored yet', findAdvert(record(), { jdsDir }), null);
  const saved = saveAdvert(record(), { jdsDir });
  const found = findAdvert(record(), { jdsDir });
  eq('a stored advert is found by its URL', found?.path, saved.path);
  eq('and its status comes back with it', found?.status, 'read');
  ok('and its text can be loaded without a fetch', loadAdvertText(found.path, { jdsDir }).includes('Programme Manager'));
}

// ── --reread refetches a non-read file and leaves a read one alone ──
{
  const jdsDir = tempJds();
  const blocked = saveAdvert(record({ status: 'unreadable', text: '', rung: null }), { jdsDir });
  eq('an unreadable advert is stored too, never dropped', blocked.reused, false);
  eq('and its status says so', findAdvert(record(), { jdsDir })?.status, 'unreadable');

  const rewritten = saveAdvert(record({ status: 'read', text: BODY }), { jdsDir, reread: true });
  eq('--reread replaces a non-read file', rewritten.reused, false);
  eq('at the same path', rewritten.path, blocked.path);
  eq('and the status is now read', findAdvert(record(), { jdsDir })?.status, 'read');

  const again = saveAdvert(record({ text: 'SOMETHING ELSE '.repeat(30) }), { jdsDir, reread: true });
  eq('--reread leaves an already-read file alone', again.reused, true);
  ok('its text is unchanged', loadAdvertText(again.path, { jdsDir }).includes('Programme Manager'));
}

// ── The filename shape is the apify plugin's ────────────────────────
{
  const name = advertFilename('Example Ltd', 'Programme Manager', 'https://careers.example.com/roles/42');
  ok('company and title are slugged into the name', name.startsWith('example-ltd-programme-manager-'));
  ok('a ten-character URL hash keeps two postings apart', /-[0-9a-f]{10}\.md$/.test(name));
  const other = advertFilename('Example Ltd', 'Programme Manager', 'https://careers.example.com/roles/43');
  ok('two postings sharing a company and title get different files', name !== other);
}

// ── A write that cannot happen is a null, never a crash ─────────────
{
  const jdsDir = tempJds();
  // A file where the directory should be: mkdir fails, and the reader carries on.
  writeFileSync(jdsDir, 'not a directory');
  let threw = false;
  let out;
  try {
    out = saveAdvert(record(), { jdsDir });
  } catch {
    threw = true;
  }
  ok('a store failure does not throw', threw === false);
  eq('it returns no path', out?.path, null);
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
