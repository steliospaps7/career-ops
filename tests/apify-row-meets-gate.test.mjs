/**
 * tests/apify-row-meets-gate.test.mjs — a paid-reader row meets the advert gate.
 *
 * Found on 13 September from the BCG Global Product Manager row: the apify
 * plugin saved the full advert under `jds/` and swapped the URL cell for
 * `local:jds/<file>`, the free reader then stored a second, empty file for that
 * `local:` "URL" marked unreadable, and the gate read the empty file. Every
 * paid-reader row passed the years rule without being judged.
 *
 * Two halves. At scan time, a row that arrives with its advert (the plugin now
 * keeps the posting URL and puts the text on `description`) is pointed at the
 * plugin's own file and fetched never. On the recheck, a line queued in the old
 * shape is judged on the plugin's file, not on the empty stub, and `--reread`
 * agrees with the plain run.
 *
 * The plugin's own fetch writes the stored advert, with the global fetch
 * stubbed for Apify's three calls, so the filename under test is the shipped
 * one. Nothing touches the network and nothing touches the real queue.
 *
 * Run: node test-all.mjs --only apify-row-meets-gate
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import {
  readPipelineAdverts,
  buildAdvertGate,
  buildDropExplainer,
  buildContentFilter,
  extractJdSegment,
  extractRouteSegment,
  extractYearsSegment,
  pipelineLineIdentity,
  buildAdvertReader,
  fillJobAdvert,
  formatAdvertDropRow,
  formatPipelineOffer,
} from '../scan.mjs';
import { saveAdvert, advertStatusAt, loadAdvertText } from '../providers/_advert-reader.mjs';
import { parseTiersTable, routeDetail } from '../providers/_role-route.mjs';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — a paid-reader row meets the advert gate (B3 into the fork)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dirs = [];
function tempDir(prefix = 'co-apify-gate-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const plugin = (await import(pathToFileURL(join(ROOT, 'plugins', 'apify', 'index.mjs')).href)).default.provider;

const COMPANY = 'Boston Consulting Group (BCG)';
const TITLE = 'Global Product Manager';
const POSTING_URL = 'https://www.linkedin.com/jobs/view/4000000001';
const YEARS_SENTENCE = 'You must have 5–7 years of product management experience.';
const LONG_BAR = `<p>Own the global roadmap for a data product used by consultants.</p><p>${YEARS_SENTENCE}</p><p>Work with engineering and design across three regions.</p>`;
const THREE_YEARS = '<p>Own the global roadmap for a data product used by consultants.</p><p>You need 3 years of product management experience.</p><p>Work with engineering and design across three regions.</p>';

const gate = buildAdvertGate({
  contentFilter: buildContentFilter({ negative: ['unpaid internship'] }),
  explain: buildDropExplainer({ content_filter: { negative: ['unpaid internship'] } }, 'United Kingdom'),
});

// BCG is in no tier on purpose: a tier would route it however the note read,
// and the note is what one case below checks.
const TIERS = parseTiersTable(['name\tnotes\ttier', 'Quiet Co\tNothing special\t3'].join('\n'));

// Stub the three requests the plugin's runActor makes.
function stubApify(items) {
  return async (url) => {
    const u = String(url);
    let body;
    if (u.endsWith('/runs')) body = { data: { id: 'run1' } };
    else if (u.endsWith('/actor-runs/run1')) body = { data: { status: 'SUCCEEDED' } };
    else if (u.endsWith('/actor-runs/run1/dataset/items')) body = items;
    else return new Response('unexpected request', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/**
 * Run the plugin over one item inside a fresh data root. The plugin writes
 * `jds/` relative to the working directory, so the root is the cwd for the call.
 * Returns the root, its jds/ directory and the one Job.
 */
async function apifyJob(description, { url = POSTING_URL, company = COMPANY, title = TITLE } = {}) {
  const root = tempDir();
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = stubApify([{ title, url, company, location: 'London', description }]);
  process.chdir(root);
  try {
    const jobs = await plugin.fetch(
      {
        name: 'LinkedIn Jobs (London, last 24 hours)',
        actor: 'fixture/actor',
        field_map: { title: 'title', url: 'url', company: 'company', location: 'location', description: 'description' },
      },
      { env: { APIFY_TOKEN: 'test-token' } },
    );
    return { root, jdsDir: join(root, 'jds'), job: jobs[0] };
  } finally {
    process.chdir(prevCwd);
    globalThis.fetch = prevFetch;
  }
}

function pipelineFile(root, pending, processed = []) {
  const p = join(root, 'pipeline.md');
  writeFileSync(p, [
    '# Pipeline — Pending URLs',
    '',
    '## Pending',
    '',
    ...pending,
    '',
    '## Processed',
    '',
    ...processed,
    '',
  ].join('\n'));
  return p;
}

function sections(text) {
  const lines = text.split('\n');
  const pendAt = lines.findIndex(l => l.trim() === '## Pending');
  const procAt = lines.findIndex(l => l.trim() === '## Processed');
  return {
    pending: lines.slice(pendAt + 1, procAt).filter(l => l.trim()),
    processed: lines.slice(procAt + 1).filter(l => l.trim()),
  };
}

function urlCell(line) {
  return line.replace(/^\s*- \[[ x]\]\s+/, '').split('|')[0].trim();
}

/**
 * The line the queue carried before this ticket: the plugin's file in the URL
 * cell, and a `jd:` segment naming the empty stub the free reader stored when it
 * was handed that `local:` cell as a URL.
 */
function oldShape(jdsDir, apifyRel) {
  const stub = saveAdvert({
    company: COMPANY,
    title: TITLE,
    url: `local:${apifyRel}`,
    location: 'London',
    text: '',
    status: 'unreadable',
    rung: '',
  }, { jdsDir });
  return {
    stubRel: stub.path,
    line: `- [ ] local:${apifyRel} | ${COMPANY} | ${TITLE} | London | jd: local:${stub.path}`,
  };
}

/** Run the recheck with --gate over `pipelinePath`, counting any read it asks for. */
async function recheck(pipelinePath, jdsDir, { reread = false } = {}) {
  let reads = 0;
  const counts = await readPipelineAdverts({
    pipelinePath,
    reread,
    gate,
    tiersTable: TIERS,
    storedStatus: (rel) => advertStatusAt(rel, { jdsDir }),
    storedText: (rel) => loadAdvertText(rel, { jdsDir }),
    readEntry: async () => {
      reads++;
      return { status: 'unreadable', jdPath: null, failedAs: 'blocked', failedAt: 'route', reachedFirecrawl: true };
    },
    today: '2026-09-13',
  });
  return { counts, reads, text: readFileSync(pipelinePath, 'utf-8') };
}

// ── The recheck: an old-shape line with a years bar is dropped on the plugin's file ──
{
  const { root, jdsDir, job } = await apifyJob(LONG_BAR);
  const apifyRel = job.note.slice('local:'.length);
  ok('the plugin stored the advert under jds/', existsSync(join(root, apifyRel)));
  const { stubRel, line } = oldShape(jdsDir, apifyRel);
  eq('the stub reads unreadable, as the real queue\'s do', advertStatusAt(stubRel, { jdsDir }), 'unreadable');

  const plain = await recheck(pipelineFile(tempDir(), [line]), jdsDir);
  eq('the plain recheck fetches nothing', plain.reads, 0);
  eq('the plain recheck drops the row', plain.counts.drops.rows.length, 1);
  eq('on the years rule', plain.counts.drops.rows[0]?.reason, 'years');
  eq('naming the advert\'s own sentence', plain.counts.drops.rows[0]?.phrase, YEARS_SENTENCE);
  eq('and the file it read, which is the plugin\'s', plain.counts.drops.rows[0]?.jdPath, apifyRel);
  const out = sections(plain.text);
  eq('the row leaves Pending', out.pending.length, 0);
  eq('and lands in Processed', out.processed.length, 1);

  const again = await recheck(pipelineFile(tempDir(), [line]), jdsDir, { reread: true });
  eq('--reread fetches nothing either', again.reads, 0);
  eq('--reread drops the same row on the same sentence', again.counts.drops.rows[0]?.phrase, YEARS_SENTENCE);
  eq('the two runs write the same file', again.text, plain.text);
}

// ── The recheck keeps an old-shape line whose advert clears the bar ──
{
  const { jdsDir, job } = await apifyJob(THREE_YEARS);
  const apifyRel = job.note.slice('local:'.length);
  const { line } = oldShape(jdsDir, apifyRel);

  const root = tempDir();
  const p = pipelineFile(root, [line]);
  const first = await recheck(p, jdsDir);
  eq('nothing is fetched', first.reads, 0);
  eq('nothing is dropped', first.counts.drops.rows.length, 0);
  const kept = sections(first.text).pending;
  eq('the row stays pending', kept.length, 1);
  eq('it is routed', extractRouteSegment(kept[0]), 'standard');
  eq('its jd: segment now names the file the gate read', extractJdSegment(kept[0]), apifyRel);
  eq('its URL cell is left as it was', urlCell(kept[0]), `local:${apifyRel}`);
  eq('no years label for a three-year bar', extractYearsSegment(kept[0]), null);

  const second = await recheck(p, jdsDir);
  eq('a second recheck over the same file changes nothing', second.text, first.text);
  eq('and fetches nothing', second.reads, 0);

  const reread = await recheck(pipelineFile(tempDir(), [line]), jdsDir, { reread: true });
  eq('--reread keeps it the same way', reread.text, first.text);
}

// ── A four-year bar is kept and labelled, on both runs ───────────────
{
  const FOUR = '<p>Own the global roadmap for a data product used by consultants.</p><p>You need 4 years of product management experience.</p>';
  const { jdsDir, job } = await apifyJob(FOUR);
  const { line } = oldShape(jdsDir, job.note.slice('local:'.length));
  const plain = await recheck(pipelineFile(tempDir(), [line]), jdsDir);
  const reread = await recheck(pipelineFile(tempDir(), [line]), jdsDir, { reread: true });
  eq('a four-year bar is kept with its label', extractYearsSegment(sections(plain.text).pending[0] || ''), 4);
  eq('and --reread agrees', reread.text, plain.text);
}

// ── A local: cell whose file is missing stays unreadable ─────────────
{
  const jdsDir = join(tempDir(), 'jds');
  mkdirSync(jdsDir, { recursive: true });
  const missingRel = 'jds/boston-consulting-group-bcg-global-product-manager-0000000000.md';
  const { stubRel, line } = oldShape(jdsDir, missingRel);

  const p = pipelineFile(tempDir(), [line]);
  const first = await recheck(p, jdsDir);
  eq('nothing is fetched', first.reads, 0);
  eq('nothing is dropped on an advert nobody read', first.counts.drops.rows.length, 0);
  const kept = sections(first.text).pending;
  eq('the row stays pending', kept.length, 1);
  eq('its jd: segment still names the stub', extractJdSegment(kept[0]), stubRel);
  eq('no years label is invented', extractYearsSegment(kept[0]), null);
  const second = await recheck(p, jdsDir);
  eq('a second recheck changes nothing', second.text, first.text);

  const reread = await recheck(pipelineFile(tempDir(), [line]), jdsDir, { reread: true });
  eq('--reread has no URL to fetch and leaves the line alone', sections(reread.text).pending[0], line);
}

// ── A missing plugin file never replaces a jd: segment that was read ──
{
  const jdsDir = join(tempDir(), 'jds');
  const real = saveAdvert({
    company: COMPANY, title: TITLE, url: POSTING_URL, location: 'London',
    text: `Own the roadmap. ${YEARS_SENTENCE} `.repeat(12), status: 'read', rung: 'page',
  }, { jdsDir });
  const line = `- [ ] local:jds/gone-0000000000.md | ${COMPANY} | ${TITLE} | London | jd: local:${real.path}`;
  const { counts, reads } = await recheck(pipelineFile(tempDir(), [line]), jdsDir);
  eq('a read jd: segment still wins', counts.drops.rows[0]?.jdPath, real.path);
  eq('and nothing is fetched', reads, 0);
}

// ── Scan time: a row that arrives with its advert is never fetched ───
//
// The sweep's own step, `fillJobAdvert`, with a reader whose transports count
// every call. Then the same gate, route and queue-line writer the sweep uses.

function countingReader(jdsDir) {
  const calls = { n: 0 };
  const refuse = async () => {
    calls.n++;
    throw new Error('no fetch expected');
  };
  const reader = buildAdvertReader({ jdsDir, transports: { fetchText: refuse, fetchJson: refuse, browser: refuse } });
  return { reader, calls };
}

/** What the sweep does with one job after the free filters, as far as the queue line. */
async function sweep(job, reader, boardName = 'LinkedIn Jobs (London, last 24 hours)') {
  await fillJobAdvert(job, reader, boardName);
  const verdict = gate({
    description: job.description,
    matchedKeywords: [],
    readStatus: job.readStatus ?? null,
  });
  if (verdict.drop) {
    return {
      verdict,
      dropLine: formatAdvertDropRow({ company: job.company, title: job.title, url: job.url, jdPath: job.jdPath || '', reason: verdict.reason, phrase: verdict.phrase }),
    };
  }
  const routing = routeDetail(job.company, TIERS, job.note || '');
  return { verdict, routing, line: formatPipelineOffer({ ...job, years: verdict.years, route: routing.route }) };
}

{
  const { jdsDir, job } = await apifyJob(THREE_YEARS);
  const apifyRel = job.note.slice('local:'.length);
  const { reader, calls } = countingReader(jdsDir);
  const out = await sweep(job, reader);

  eq('the plugin kept the posting URL', job.url, POSTING_URL);
  eq('the sweep fetches nothing for a row that carries its advert', calls.n, 0);
  eq('it points the row at the plugin\'s file', job.jdPath, apifyRel);
  eq('and counts it as read by apify', reader.tally.rungs.apify, 1);
  eq('the gate keeps a three-year bar', out.verdict.drop, false);
  eq('the route is decided on the company, not on the note', out.routing?.bucket, 'untiered');
  const identity = pipelineLineIdentity(out.line || '');
  eq('the queue line keeps the posting URL', identity?.url, POSTING_URL);
  eq('it carries the file as its jd: segment', extractJdSegment(out.line || ''), apifyRel);
  ok('and the plugin\'s reference as a note cell', (out.line || '').endsWith(`| note: local:${apifyRel}`));
  eq('the line reads as no local: row', identity?.localPath, '');

  // The note the plugin writes, read by the recheck: not a route marker, and
  // the line is already judged on the plugin's file, so nothing moves.
  const p = pipelineFile(tempDir(), [out.line]);
  const before = readFileSync(p, 'utf-8');
  const again = await recheck(p, jdsDir, { reread: true });
  eq('the recheck of that line fetches nothing', again.reads, 0);
  eq('and routes it the same way', extractRouteSegment(sections(again.text).pending[0] || ''), 'standard');
  eq('and changes nothing else', again.text, before);
}

{
  const { jdsDir, job } = await apifyJob(LONG_BAR);
  const apifyRel = job.note.slice('local:'.length);
  const { reader, calls } = countingReader(jdsDir);
  const out = await sweep(job, reader);
  eq('a row with a 5-year clause fetches nothing', calls.n, 0);
  eq('and is dropped on the years rule', out.verdict.reason, 'years');
  eq('naming the sentence', out.verdict.phrase, YEARS_SENTENCE);
  eq('the DROP line names the plugin\'s file', out.dropLine, `DROP | ${COMPANY} | ${TITLE} | years: "${YEARS_SENTENCE}" | jd: local:${apifyRel}`);
}

{
  // A board that hands over its own description and has no stored file: no
  // fetch, no jd: segment, nothing counted, exactly as before.
  const jdsDir = join(tempDir(), 'jds');
  const { reader, calls } = countingReader(jdsDir);
  const job = { title: 'Product Manager', url: 'https://boards.greenhouse.io/quiet/jobs/1', company: 'Quiet Co', location: 'London', description: 'You need 3 years of product management experience.' };
  const out = await sweep(job, reader, 'Quiet Co');
  eq('a board description with no stored file fetches nothing', calls.n, 0);
  eq('and gets no jd: segment', extractJdSegment(out.line || ''), null);
  eq('and is not counted as a read', reader.tally.considered, 0);
  eq('and is still routed', out.routing?.route, 'standard');
}

{
  // A stored file for the posting that is not `read` is not pinned on a row
  // that brought its own advert: the gate reads the description, and jd: must
  // not point at a stub.
  const { jdsDir, job } = await apifyJob(THREE_YEARS);
  const apifyRel = job.note.slice('local:'.length);
  writeFileSync(join(jdsDir, apifyRel.split('/').pop()), readFileSync(join(jdsDir, apifyRel.split('/').pop()), 'utf-8').replace('---\n\n', 'read_status: "shell"\n---\n\n'));
  const { reader, calls } = countingReader(jdsDir);
  const out = await sweep(job, reader);
  eq('a stored stub for a described row fetches nothing', calls.n, 0);
  eq('and is not named as its jd: segment', extractJdSegment(out.line || ''), null);
}

{
  // An empty description still goes down the ladder: the reuse path above is
  // only for a row that already carries its advert.
  const jdsDir = join(tempDir(), 'jds');
  const { reader, calls } = countingReader(jdsDir);
  const job = { title: 'Product Manager', url: 'https://example.com/jobs/1', company: 'Quiet Co', location: 'London' };
  await fillJobAdvert(job, reader, 'Quiet Co');
  ok('a row with no description is still read through the ladder', calls.n > 0);
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
