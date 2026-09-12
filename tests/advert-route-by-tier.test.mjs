/**
 * tests/advert-route-by-tier.test.mjs — seam 4 of ticket B2.
 *
 * `routeByTier()` is pure: a company name, a tier table and a note in, a route
 * out. Nothing here touches the filesystem beyond one fixture string, and
 * nothing asserts how the table was read — only which effort a role is routed
 * to, which is what decides whether an evaluation is ever spent on it.
 *
 * Run: node test-all.mjs --only advert-route-by-tier
 */

import {
  parseTiersTable,
  routeByTier,
  routeDetail,
  canonicalTierName,
  noteCarriesRouteMarker,
} from '../providers/_role-route.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\n_role-route.mjs — the route decision (seam 4)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// The real file's header, including the columns this module does not read, so a
// positional reader would be caught here rather than in production.
const TSV = [
  'name\tlinkedin\tsize\tindustry\thq\twebsite\tats_board\treaction\tdoor\tstatus\tnotes\ttier',
  'Lupa\tlupapets\t77\tSoftware\tLondon\thttps://lupapets.com\t\tyes\tThe meeting\tnew\tVet operating system\t1',
  'Form Nutrition\tform\t40\tConsumer\tLondon\thttps://form.com\t\tyes\tnone\tnew\tSupplements brand\t2',
  'Sift\tsift\t120\tSoftware\tLondon\thttps://sift.com\t\tno\tnone\tnew\tPayments risk\t3',
  '  Wide   Load  \twide\t12\tSoftware\tLondon\thttps://wide.com\t\tno\tnone\tnew\tSpacing test\t2',
  'Anthropic\tanthropic\t1200\tAI\tSan Francisco\thttps://anthropic.com\t\tyes\tnone\tnew\tWish list\tdream',
  // The real Zego row, verbatim from data/companies.tsv. The word "flag" in an
  // ordinary note must route nothing; before the build review it routed this
  // company, marked `out`, to scoring.
  'Zego\tzego\t348\tInsurance\tLondon\thttps://zego.com\t\tno\tnone\tout\tToo big; the size was already the flag\tout',
  // A Siyada clause 13.1 note, the shape nine real rows carry.
  'Heights\theights\t40\tConsumer\tLondon\thttps://heights.com\t\tyes\tnone\tnew\tSiyada clause 13.1 flag: a supplement brand\t3',
  // The marker a human writes when they mean it.
  'Marked Co\tmarked\t20\tSoftware\tLondon\thttps://marked.com\t\tno\tnone\tnew\troute: score — worth the full evaluation\t3',
  'Blank Tier\tblank\t20\tSoftware\tLondon\thttps://blank.com\t\tno\tnone\tnew\tNo tier yet\t',
  'Quiet Co\tquiet\t20\tSoftware\tLondon\thttps://quiet.com\t\tno\tnone\tnew\tNothing special\t3',
].join('\n');

const tiers = parseTiersTable(TSV);

// ── The table itself ────────────────────────────────────────────────
{
  eq('every named row is in the table', tiers.size, 10);
  eq('the tier column is read by header, not by position', tiers.get('lupa')?.tier, '1');
  eq('the notes column is read by header too', tiers.get('sift')?.notes, 'Payments risk');
  ok('a header-only file yields an empty table', parseTiersTable('name\ttier').size === 0);
  ok('an empty string yields an empty table', parseTiersTable('').size === 0);
  ok('a file with no name column yields an empty table', parseTiersTable('company\ttier\nLupa\t1').size === 0);
}

// ── Tier 1 and 2 score ──────────────────────────────────────────────
{
  eq('tier 1 scores', routeByTier('Lupa', tiers), 'score');
  eq('tier 2 scores', routeByTier('Form Nutrition', tiers), 'score');
  eq('tier 1 is bucketed as tier1', routeDetail('Lupa', tiers).bucket, 'tier1');
  eq('tier 2 is bucketed as tier2', routeDetail('Form Nutrition', tiers).bucket, 'tier2');
}

// ── Tier 3, an empty tier and a name not found go standard ──────────
{
  eq('tier 3 goes standard', routeByTier('Quiet Co', tiers), 'standard');
  eq('tier 3 is bucketed as tier3', routeDetail('Quiet Co', tiers).bucket, 'tier3');
  eq('an empty tier goes standard', routeByTier('Blank Tier', tiers), 'standard');
  eq('an empty tier is untiered', routeDetail('Blank Tier', tiers).bucket, 'untiered');
  eq('a name not in the table goes standard', routeByTier('Never Heard Of', tiers), 'standard');
  eq('a name not in the table is untiered, not an error', routeDetail('Never Heard Of', tiers).bucket, 'untiered');
  eq('an empty name goes standard', routeByTier('', tiers), 'standard');
  eq('an absent table goes standard', routeByTier('Lupa', null), 'standard');
}

// ── `dream` is the Tiers chat's wish list and scores ────────────────
// The spec's rule names tiers 1, 2 and 3 only; the column also carries `dream`
// for Google, Anthropic, OpenAI and eight more. Routing those to standard would
// send the standard pack with no evaluation to the companies Stelios most
// wants, which is the opposite of what the rule exists for.
{
  eq('a dream company scores', routeByTier('Anthropic', tiers), 'score');
  eq('a dream company is bucketed as dream', routeDetail('Anthropic', tiers).bucket, 'dream');
}

// ── The `route: score` marker beats the tier ────────────────────────
//
// The marker is a literal that no ordinary note writes by chance. It was the
// bare word "flag" until the build review of 11 September 2026, and every
// occurrence of that word in the real tier table is a Siyada clause 13.1
// compliance note rather than a routing instruction.
{
  eq('the marker in the queue line note scores over tier 3', routeByTier('Quiet Co', tiers, 'route: score, worth a look'), 'score');
  eq('the marker in the line note is bucketed as flagged', routeDetail('Quiet Co', tiers, 'route: score').bucket, 'flagged');
  eq('the marker in the company notes scores over a tier that would not', routeByTier('Marked Co', tiers), 'score');
  eq('case and spacing do not matter', routeByTier('Quiet Co', tiers, 'ROUTE:   SCORE'), 'score');

  // The word that used to route, and no longer does.
  eq('the bare word flag routes nothing', routeByTier('Quiet Co', tiers, 'flag this one'), 'standard');
  eq('nor does "flagged"', routeByTier('Quiet Co', tiers, 'flagged by me'), 'standard');
  eq('a Siyada compliance note routes nothing', routeByTier('Heights', tiers), 'standard');
  eq('and neither does the real Zego note, on a company marked out', routeByTier('Zego', tiers), 'standard');
  eq('nor does flagship', routeByTier('Quiet Co', tiers, 'their flagship product'), 'standard');

  ok('noteCarriesRouteMarker reads the literal', noteCarriesRouteMarker('route: score'));
  ok('noteCarriesRouteMarker refuses the other route', !noteCarriesRouteMarker('route: standard'));
  ok('noteCarriesRouteMarker refuses a longer word', !noteCarriesRouteMarker('route: scorecard'));
  ok('noteCarriesRouteMarker on nothing is false', !noteCarriesRouteMarker(undefined));
  // A tier that already scores keeps its own bucket, so no row is counted twice.
  eq('a marked tier 1 is still counted as tier 1', routeDetail('Lupa', tiers, 'route: score').bucket, 'tier1');
}

// ── Names match across case and whitespace, and nothing fuzzier ─────
{
  eq('case does not matter', routeByTier('lUPa', tiers), 'score');
  eq('leading and trailing space does not matter', routeByTier('  Lupa  ', tiers), 'score');
  eq('inner whitespace is collapsed', routeByTier('Wide     Load', tiers), 'score');
  eq('a tab reads as whitespace', canonicalTierName('Wide\tLoad'), 'wide load');
  // Nothing fuzzier: a wrong match routes a role to the wrong effort.
  eq('a prefix is not a match', routeByTier('Lupa Pets', tiers), 'standard');
  eq('a substring is not a match', routeByTier('Lup', tiers), 'standard');
  eq('punctuation is not folded away', routeByTier('Lupa.', tiers), 'standard');
}

// ── The first row wins a duplicate name ─────────────────────────────
{
  const dup = parseTiersTable([
    'name\tnotes\ttier',
    'Twice\tfirst\t1',
    'Twice\tsecond\t3',
  ].join('\n'));
  eq('a duplicate name keeps the first row', routeByTier('Twice', dup), 'score');
}
