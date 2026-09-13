/**
 * tests/advert-route-review.test.mjs — an unread advert has its own route (ticket C, C2).
 *
 * A row whose stored advert is not `read` used to be labelled `route: standard`,
 * which sends the standard pack on an advert nobody read. It is now
 * `route: review`: a person reads it before anything is sent. On both paths,
 * the sweep and the standalone pass, and counted on its own summary line.
 *
 * `ROUTE_SEGMENT_RE` matched only `score|standard`, so a `review` line was never
 * recognised as routed and every recheck appended a second segment. One case
 * here proves a `review` line survives a second run byte-identical.
 *
 * Nothing here touches the network and nothing touches the real queue.
 *
 * Run: node test-all.mjs --only advert-route-review
 */

import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readPipelineAdverts,
  buildAdvertGate,
  buildAdvertReader,
  fillJobAdvert,
  formatPipelineOffer,
  formatGateSummary,
  emptyRouteTally,
  emptyAdvertDropTally,
  countRoute,
  extractRouteSegment,
  insertRouteSegment,
  extractJdSegment,
} from '../scan.mjs';
import { parseTiersTable, routeDetail } from '../providers/_role-route.mjs';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — an unread advert is routed to review (ticket C, C2)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'co-route-review-'));
  dirs.push(d);
  return d;
}

const CLEAN = 'A delivery product role. You need 3 years of product management experience. '.repeat(6);

const gate = buildAdvertGate({});

const TIERS = parseTiersTable([
  'name\tnotes\ttier',
  'Lupa\tVet operating system\t1',
  'Quiet Co\tNothing special\t3',
].join('\n'));

function pipelineFile(pending) {
  const p = join(tempDir(), 'pipeline.md');
  writeFileSync(p, ['# Pipeline — Pending URLs', '', '## Pending', '', ...pending, '', '## Processed', '', ''].join('\n'));
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

function unreadable() {
  return async () => ({ status: 'unreadable', jdPath: 'jds/quiet-co-analyst-0000000000.md', failedAs: 'blocked', failedAt: 'route', reachedFirecrawl: true });
}

// ── The rule: read status first, then the tier ──────────────────────
{
  const unread = routeDetail('Lupa', TIERS, '', 'unreadable');
  eq('an unreadable advert is routed to review', unread.route, 'review');
  eq('under its own bucket', unread.bucket, 'unread');
  eq('even for a tier 1 company', unread.tier, '1');
  eq('an expired read is review too', routeDetail('Quiet Co', TIERS, '', 'expired').route, 'review');
  eq('a route marker in the note does not score an unread advert', routeDetail('Quiet Co', TIERS, 'route: score', 'shell').route, 'review');

  // Retention: a read advert, and a board description with no read status, route as before.
  eq('a read advert still routes on its tier', routeDetail('Lupa', TIERS, '', 'read').route, 'score');
  eq('a read tier 3 advert is still standard', routeDetail('Quiet Co', TIERS, '', 'read').route, 'standard');
  eq('a board description with no read status routes as before', routeDetail('Quiet Co', TIERS, '', null).route, 'standard');
  eq('and so does a call with no read status at all', routeDetail('Lupa', TIERS).route, 'score');
}

// ── The segment: recognised, replaced, never duplicated ─────────────
{
  const line = '- [ ] https://jobs.quiet.example/1 | Quiet Co | Analyst | London | jd: local:jds/a.md | route: review | note: x';
  eq('a review line is recognised as routed', extractRouteSegment(line), 'review');
  eq('rerouting it replaces the segment in place', insertRouteSegment(line, 'standard'),
    '- [ ] https://jobs.quiet.example/1 | Quiet Co | Analyst | London | jd: local:jds/a.md | route: standard | note: x');
  eq('writing review over review changes nothing', insertRouteSegment(line, 'review'), line);
  eq('a standard line can become review', extractRouteSegment(insertRouteSegment(line.replace('review', 'standard'), 'review')), 'review');
  eq('formatPipelineOffer writes the review route', formatPipelineOffer({ url: 'https://a.example/1', company: 'A', title: 'B', route: 'review' }),
    '- [ ] https://a.example/1 | A | B | route: review');
}

// ── The summary counts review on its own line ───────────────────────
{
  const routes = emptyRouteTally();
  countRoute(routes, routeDetail('Lupa', TIERS, '', 'read'));
  countRoute(routes, routeDetail('Quiet Co', TIERS, '', 'read'));
  countRoute(routes, routeDetail('Quiet Co', TIERS, '', 'unreadable'));
  countRoute(routes, routeDetail('Lupa', TIERS, '', 'shell'));
  eq('review is counted apart', routes.review, 2);
  eq('and not inside standard', routes.standard, 1);
  const lines = formatGateSummary(emptyAdvertDropTally(), routes);
  eq('two lines: routes, then review', lines.length, 2);
  ok('the routes line keeps score and standard', lines[0].includes('score 1') && lines[0].includes('standard 1'));
  ok('and does not mention review', !lines[0].includes('review'));
  ok('the review line counts the unread rows', /^Review:\s+2\b/.test(lines[1]));

  const readOnly = emptyRouteTally();
  countRoute(readOnly, routeDetail('Quiet Co', TIERS, '', 'read'));
  eq('a run with no unread row prints no review line', formatGateSummary(emptyAdvertDropTally(), readOnly).length, 1);
  const unreadOnly = emptyRouteTally();
  countRoute(unreadOnly, routeDetail('Quiet Co', TIERS, '', 'unreadable'));
  eq('a run whose only rows are unread still prints the review line', formatGateSummary(emptyAdvertDropTally(), unreadOnly).length, 1);
}

// ── The standalone pass: an unreadable row is review, and stays so ──
{
  const p = pipelineFile([
    '- [ ] https://jobs.quiet.example/9 | Quiet Co | Analyst | London',
    '- [ ] https://jobs.lupa.example/1 | Lupa | Operations Associate | London',
  ]);
  const readEntry = async (entry) => (entry.url.includes('quiet')
    ? unreadable()()
    : { status: 'read', rung: 'page', jdPath: 'jds/lupa-operations-associate-1111111111.md', text: CLEAN, reachedFirecrawl: false });
  const counts = await readPipelineAdverts({ pipelinePath: p, gate, tiersTable: TIERS, readEntry });
  const first = readFileSync(p, 'utf-8');
  const out = sections(first);
  eq('both rows stay pending', out.pending.length, 2);
  eq('the unreadable row prints route: review', extractRouteSegment(out.pending[0]), 'review');
  eq('it is not dropped', counts.drops.total, 0);
  eq('it is counted as review', counts.routed.review, 1);
  eq('the read row keeps its tier route', extractRouteSegment(out.pending[1]), 'score');

  // The second run: the stored stub is loaded, not re-read.
  const stored = { 'jds/quiet-co-analyst-0000000000.md': 'unreadable', 'jds/lupa-operations-associate-1111111111.md': 'read' };
  const again = await readPipelineAdverts({
    pipelinePath: p, gate, tiersTable: TIERS,
    storedStatus: (rel) => stored[rel] ?? null,
    storedText: () => CLEAN,
    readEntry: async () => { throw new Error('should not be read'); },
  });
  eq('a second run leaves the file byte-identical', readFileSync(p, 'utf-8'), first);
  eq('with one review segment, not two', (sections(readFileSync(p, 'utf-8')).pending[0].match(/route:/g) || []).length, 1);
  eq('and counts it as review again', again.routed.review, 1);
}

// ── A stub on disk from an earlier day is review on the recheck ─────
{
  const line = '- [ ] https://jobs.quiet.example/5 | Quiet Co | Analyst | London | jd: local:jds/stub.md | route: standard';
  const p = pipelineFile([line]);
  await readPipelineAdverts({
    pipelinePath: p, gate, tiersTable: TIERS,
    storedStatus: () => 'shell',
    storedText: () => '',
    readEntry: async () => { throw new Error('should not be read'); },
  });
  const pending = sections(readFileSync(p, 'utf-8')).pending;
  eq('a standard label on an unread stub becomes review', pending[0], line.replace('route: standard', 'route: review'));
}

// ── A local: row whose stored file is missing is review, not routed on nothing ──
{
  const line = '- [ ] local:jds/gone-co-analyst-2222222222.md | Gone Co | Analyst | London';
  const p = pipelineFile([line]);
  const counts = await readPipelineAdverts({
    pipelinePath: p, gate, tiersTable: TIERS,
    storedStatus: () => null,
    storedText: () => '',
    readEntry: async () => { throw new Error('should not be read'); },
  });
  eq('a missing file is an advert nobody read', extractRouteSegment(sections(readFileSync(p, 'utf-8')).pending[0]), 'review');
  eq('and is not dropped', counts.drops.total, 0);
}

// ── A read repaired by --reread re-routes the same line ─────────────
{
  const stub = 'jds/lupa-operations-associate-3333333333.md';
  const line = `- [ ] https://jobs.lupa.example/7 | Lupa | Operations Associate | London | jd: local:${stub} | route: review`;
  const p = pipelineFile([line]);
  let reads = 0;
  const counts = await readPipelineAdverts({
    pipelinePath: p, gate, tiersTable: TIERS, reread: true,
    storedStatus: () => 'unreadable',
    storedText: () => '',
    readEntry: async ({ url }) => {
      reads++;
      return { status: 'read', rung: 'browser', jdPath: stub, text: CLEAN, url, reachedFirecrawl: false };
    },
  });
  const out = sections(readFileSync(p, 'utf-8'));
  eq('the repaired row is read once', reads, 1);
  eq('it stays one pending line, never duplicated', out.pending.length, 1);
  eq('re-routed on its tier', extractRouteSegment(out.pending[0]), 'score');
  eq('the jd: file is untouched', extractJdSegment(out.pending[0]), stub);
  eq('the URL cell is untouched', urlCell(out.pending[0]), 'https://jobs.lupa.example/7');
  eq('the line is the same line with the new route', out.pending[0], line.replace('route: review', 'route: score'));
  eq('and nothing is counted as review', counts.routed.review, 0);
}

// ── The sweep: the same rule on the sweep's own steps ───────────────
{
  const jdsDir = join(tempDir(), 'jds');
  const refuse = async () => { throw new Error('blocked'); };
  const reader = buildAdvertReader({ jdsDir, transports: { fetchText: refuse, fetchJson: refuse, browser: refuse } });
  const job = { title: 'Operations Associate', url: 'https://jobs.lupa.example/11', company: 'Lupa', location: 'London' };
  await fillJobAdvert(job, reader, 'Lupa');
  const verdict = gate({ description: job.description, matchedKeywords: [], readStatus: job.readStatus ?? null });
  eq('the sweep keeps a row nobody could read', verdict.drop, false);
  const routing = routeDetail(job.company, TIERS, job.note || '', job.readStatus ?? null);
  eq('and routes it to review, tier 1 or not', routing.route, 'review');
  ok('the queue line carries route: review', formatPipelineOffer({ ...job, route: routing.route }).endsWith('| route: review'));

  const described = { title: 'Analyst', url: 'https://boards.greenhouse.io/quiet/jobs/2', company: 'Quiet Co', location: 'London', description: CLEAN };
  await fillJobAdvert(described, reader, 'Quiet Co');
  eq('a board description is not review', routeDetail(described.company, TIERS, '', described.readStatus ?? null).route, 'standard');

  // The sweep hands the row's read status to the route. Read from the source,
  // because the sweep is one long function with no seam of its own.
  const source = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  ok('the sweep passes job.readStatus to routeDetail',
    /routeDetail\(job\.company \|\| company\.name \|\| '', tiersTable, job\.note \|\| '', job\.readStatus \?\? null\)/.test(source));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
