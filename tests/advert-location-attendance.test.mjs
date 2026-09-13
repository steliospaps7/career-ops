/**
 * tests/advert-location-attendance.test.mjs — location reads attendance, not the
 * country word (ticket C, C4).
 *
 * A listing in a UK town outside London used to pass because its location
 * string ends in "United Kingdom". The gate now keeps it only when the advert
 * says remote, work from home, hybrid from anywhere, or names London, and labels
 * it `location: remote-uk`; otherwise it drops it as `location` with the town
 * named. Stelios's word of 12 September: a UK town outside London with no remote
 * wording is removed; a UK-remote advert that allows London stays.
 *
 * No town list: the town is read from the listing's own location cell. An
 * advert nobody read is `review` under C2 and this rule does not fire.
 *
 * Nothing here touches the network and nothing touches the real queue.
 *
 * Run: node test-all.mjs --only advert-location-attendance
 */

import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readPipelineAdverts,
  buildAdvertGate,
  judgeAttendance,
  formatPipelineOffer,
  formatAdvertDropRow,
  formatGateSummary,
  emptyAdvertDropTally,
  countAdvertDrop,
  ADVERT_DROP_REASONS,
  extractLocationSegment,
  insertLocationSegment,
  extractRouteSegment,
  pipelineLineIdentity,
} from '../scan.mjs';
import { parseTiersTable, routeDetail } from '../providers/_role-route.mjs';
import { pass, fail, ROOT, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — location reads attendance, not the country word (ticket C, C4)');

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
  const d = mkdtempSync(join(tmpdir(), 'co-location-'));
  dirs.push(d);
  return d;
}

const AMERSHAM = 'Amersham, England, United Kingdom';
const OFFICE = 'Join our life sciences team. You need 3 years of product experience. This is a hybrid role, three days a week in our Amersham office. '.repeat(3);
const REMOTE = 'Join our life sciences team. You need 3 years of product experience. The role is fully remote within the UK. '.repeat(3);
const WFH = 'Join our team. You need 3 years of product experience. You can work from home most of the week. ';
const ANYWHERE = 'Join our team. You need 3 years of product experience. Hybrid from anywhere in the UK, with a monthly meet-up. ';
const NAMES_LONDON = 'Join our team. You need 3 years of product experience. You can base yourself at our London office or at Amersham. ';

// ── The rule on its own ─────────────────────────────────────────────
{
  const office = judgeAttendance(AMERSHAM, OFFICE);
  eq('Amersham with no remote wording is dropped', office.drop, true);
  eq('naming the town', office.town, 'Amersham');

  const remote = judgeAttendance(AMERSHAM, REMOTE);
  eq('Amersham with remote wording is kept', remote.drop, false);
  eq('and labelled remote-uk', remote.label, 'remote-uk');
  eq('work from home keeps it', judgeAttendance(AMERSHAM, WFH).label, 'remote-uk');
  eq('hybrid from anywhere keeps it', judgeAttendance(AMERSHAM, ANYWHERE).label, 'remote-uk');
  eq('an advert that names London keeps it', judgeAttendance(AMERSHAM, NAMES_LONDON).label, 'remote-uk');
  eq('hybrid tied to the town office does not', judgeAttendance(AMERSHAM, OFFICE).drop, true);
  eq('a remote word in the location cell itself keeps it', judgeAttendance('Amersham, England, United Kingdom (Remote)', OFFICE).label, 'remote-uk');
  eq('another town and country form is read the same way', judgeAttendance('Welwyn Garden City, England, United Kingdom', OFFICE).town, 'Welwyn Garden City');
  eq('GB counts as the UK', judgeAttendance('Manchester, GB', OFFICE).town, 'Manchester');

  // Retention: the rule does not fire on anything that is not a UK town outside London.
  for (const loc of [
    'London, England, United Kingdom',
    'London Area, United Kingdom',
    'Greater London, England, United Kingdom',
    'City Of London, England, United Kingdom',
    'London SW6 2UB',
    'United Kingdom, Remote',
    'United Kingdom',
    'New York, USA, Remote, London, UK',
    'Ireland, Spain, Netherlands, Germany, Portugal, United Kingdom',
    'Berlin, Germany',
    'Amersham',
    '',
  ]) {
    const v = judgeAttendance(loc, OFFICE);
    ok(`"${loc}" is left alone, with no label`, v.drop === false && v.label === undefined);
  }
}

// ── A London borough is London (build review of Cb, fix 1) ──────────
{
  // Rainbow Fostering's real listing and the shape of its advert: no place, no
  // way of working, only an apply address. Harrow is a London borough.
  const HARROW = 'Harrow, England, United Kingdom';
  const RAINBOW = 'Growth & Operations Associate. You will support our foster carers and grow our referrals. Apply now: jobs@rainbowfostering.co.uk';
  const harrow = judgeAttendance(HARROW, RAINBOW);
  eq('Rainbow Fostering in Harrow is kept', harrow.drop, false);
  eq('as London, not remote-uk', harrow.label, undefined);
  eq('the gate keeps it with no location label', buildAdvertGate({})({ description: RAINBOW, location: HARROW, readStatus: 'read' }).location, undefined);
  for (const loc of ['Kingston upon Thames, England, United Kingdom', 'Hammersmith & Fulham, United Kingdom', 'westminster, GB']) {
    const v = judgeAttendance(loc, OFFICE);
    ok(`"${loc}" is a borough, kept with no label`, v.drop === false && v.label === undefined);
  }
  // Retention of the rule itself: a town outside the boroughs is still read.
  eq('a town outside the boroughs is still dropped without remote wording', judgeAttendance(AMERSHAM, RAINBOW).drop, true);
}

// ── A town, a county, then the country (build review of Cb, fix 2) ──
{
  const READING = 'Reading, Berkshire, United Kingdom';
  const office = judgeAttendance(READING, OFFICE);
  eq('Reading, Berkshire, with no remote wording is dropped', office.drop, true);
  eq('naming the town, not the county', office.town, 'Reading');
  eq('Reading, Berkshire, with remote wording is kept', judgeAttendance(READING, REMOTE).drop, false);
  eq('and labelled remote-uk', judgeAttendance(READING, REMOTE).label, 'remote-uk');
  eq('a county before two UK words is read the same way', judgeAttendance('Reading, Berkshire, England, United Kingdom', OFFICE).town, 'Reading');
  eq('a borough with its old county is still London', judgeAttendance('Harrow, Middlesex, United Kingdom', OFFICE).label, undefined);
  eq('and not dropped', judgeAttendance('Harrow, Middlesex, United Kingdom', OFFICE).drop, false);
  // Retention: two parts before the country are not a town and a county.
  for (const loc of ['Reading, Berkshire, South East, United Kingdom', 'Reading, Remote, United Kingdom', 'Berkshire, United Kingdom, Remote']) {
    const v = judgeAttendance(loc, OFFICE);
    ok(`"${loc}" is left alone, with no label`, v.drop === false && v.label === undefined);
  }
}

// ── The gate: after the read, never on an unread advert ─────────────
{
  const gate = buildAdvertGate({});
  const drop = gate({ description: OFFICE, location: AMERSHAM, readStatus: 'read' });
  eq('the gate drops it as location', drop.reason, 'location');
  eq('with the town as the phrase', drop.phrase, 'Amersham');
  const kept = gate({ description: REMOTE, location: AMERSHAM, readStatus: 'read' });
  eq('the gate keeps the remote advert', kept.drop, false);
  eq('carrying the label', kept.location, 'remote-uk');
  const unread = gate({ description: '', location: AMERSHAM, readStatus: 'unreadable' });
  eq('an unread Amersham advert is not dropped', unread.drop, false);
  eq('and carries no label', unread.location, undefined);
  eq('a London row carries no label', gate({ description: OFFICE, location: 'London', readStatus: 'read' }).location, undefined);
  eq('a board description with no read status still meets the rule', gate({ description: OFFICE, location: AMERSHAM }).reason, 'location');
  ok('location is a drop reason the ledger knows', ADVERT_DROP_REASONS.includes('location'));

  const tally = emptyAdvertDropTally();
  countAdvertDrop(tally, { reason: 'location', phrase: 'Amersham' });
  ok('the summary names it', formatGateSummary(tally, null)[0].includes('(location 1)'));
  eq('the DROP line names the town and the file',
    formatAdvertDropRow({ company: 'Cytiva', title: 'Product Manager', reason: 'location', phrase: 'Amersham', jdPath: 'jds/cytiva-product-manager-1234567890.md' }),
    'DROP | Cytiva | Product Manager | location: "Amersham" | jd: local:jds/cytiva-product-manager-1234567890.md');
}

// ── The segment ─────────────────────────────────────────────────────
{
  const line = '- [ ] https://a.example/1 | A | B | Amersham, England, United Kingdom | jd: local:jds/a.md | years: 4 | route: standard | note: x';
  const labelled = insertLocationSegment(line, 'remote-uk');
  eq('the label goes in before route:', labelled,
    '- [ ] https://a.example/1 | A | B | Amersham, England, United Kingdom | jd: local:jds/a.md | years: 4 | location: remote-uk | route: standard | note: x');
  eq('it reads back', extractLocationSegment(labelled), 'remote-uk');
  eq('writing it twice changes nothing', insertLocationSegment(labelled, 'remote-uk'), labelled);
  eq('a null removes it', insertLocationSegment(labelled, null), line);
  eq('a null on a line without one changes nothing', insertLocationSegment(line, null), line);
  eq('the positional location cell is not the label', extractLocationSegment(line), null);
  eq('formatPipelineOffer writes it after years: and before route:',
    formatPipelineOffer({ url: 'https://a.example/1', company: 'A', title: 'B', location: AMERSHAM, jdPath: 'jds/a.md', years: 4, locationLabel: 'remote-uk', route: 'standard' }),
    '- [ ] https://a.example/1 | A | B | Amersham, England, United Kingdom | jd: local:jds/a.md | years: 4 | location: remote-uk | route: standard');
  eq('an offer with no label writes the line it always wrote',
    formatPipelineOffer({ url: 'https://a.example/1', company: 'A', title: 'B', location: 'London', route: 'standard' }),
    '- [ ] https://a.example/1 | A | B | London | route: standard');
  eq('the queue line gives the gate its location cell', pipelineLineIdentity(line)?.location, AMERSHAM);
  eq('a line with no location cell gives none', pipelineLineIdentity('- [ ] https://a.example/2 | A | B | jd: local:jds/a.md')?.location, '');
}

// ── The recheck ─────────────────────────────────────────────────────
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

const TIERS = parseTiersTable('name\tnotes\ttier\nQuiet Co\t\t3');

{
  const officeLine = '- [ ] https://jobs.cytiva.example/1 | Cytiva | Product Manager | Amersham, England, United Kingdom | jd: local:jds/office.md | route: standard';
  const remoteLine = '- [ ] https://jobs.cytiva.example/2 | Cytiva | Product Owner | Amersham, England, United Kingdom | jd: local:jds/remote.md | route: standard';
  const londonLine = '- [ ] https://jobs.quiet.example/3 | Quiet Co | Analyst | London, England, United Kingdom | jd: local:jds/london.md | route: standard';
  const texts = { 'jds/office.md': OFFICE, 'jds/remote.md': REMOTE, 'jds/london.md': OFFICE };
  const p = pipelineFile([officeLine, remoteLine, londonLine]);
  const run = () => readPipelineAdverts({
    pipelinePath: p,
    gate: buildAdvertGate({}),
    tiersTable: TIERS,
    storedStatus: () => 'read',
    storedText: (rel) => texts[rel],
    readEntry: async () => { throw new Error('should not be read'); },
    today: '2026-09-13',
  });
  const counts = await run();
  const first = readFileSync(p, 'utf-8');
  const out = sections(first);
  eq('Amersham without remote wording is dropped', counts.drops.rows.length, 1);
  eq('on the location rule', counts.drops.rows[0]?.reason, 'location');
  eq('the moved line names the town', out.processed[0], `${officeLine.replace('- [ ]', '- [x]')} | skipped (location: "Amersham", 2026-09-13)`);
  eq('Amersham with remote wording stays pending, labelled', out.pending[0], remoteLine.replace('| route: standard', '| location: remote-uk | route: standard'));
  eq('the London line is kept with no label', out.pending[1], londonLine);
  eq('and the kept rows are still routed', extractRouteSegment(out.pending[0]), 'standard');

  await run();
  eq('a second run changes nothing', readFileSync(p, 'utf-8'), first);
}

// ── The sweep: the same gate and writer ─────────────────────────────
{
  const gate = buildAdvertGate({});
  const job = { url: 'https://jobs.cytiva.example/9', company: 'Cytiva', title: 'Product Owner', location: AMERSHAM, description: REMOTE };
  const verdict = gate({ description: job.description, matchedKeywords: [], readStatus: null, location: job.location });
  const routing = routeDetail(job.company, TIERS, '', null);
  ok('the sweep writes the label on the queue line',
    formatPipelineOffer({ ...job, locationLabel: verdict.location, route: routing.route }).endsWith('| location: remote-uk | route: standard'));

  const source = readFileSync(join(ROOT, 'scan.mjs'), 'utf-8');
  ok('the sweep hands the gate the listing location', /readStatus: job\.readStatus \?\? null,\s*location: job\.location,/.test(source));
  ok('and keeps the label on the job', /job\.locationLabel = verdict\.location/.test(source));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
