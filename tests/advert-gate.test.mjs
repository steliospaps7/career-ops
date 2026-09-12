/**
 * tests/advert-gate.test.mjs — seam 5 of ticket B2.
 *
 * The gate is the one rule the sweep and the standalone pass share: what a
 * filled description costs a row, what a row nobody could read costs it
 * (nothing), and what the run prints about both.
 *
 * Nothing here touches the network.
 *
 * Run: node test-all.mjs --only advert-gate
 */

import {
  buildAdvertGate,
  buildDropExplainer,
  buildContentFilter,
  buildCountryEligibilityFilter,
  buildVisaFilter,
  formatAdvertDropRow,
  formatGateSummary,
  emptyAdvertDropTally,
  countAdvertDrop,
  emptyRouteTally,
  countRoute,
  formatPipelineOffer,
  createSourceLedger,
  reconcileSourceLedger,
} from '../scan.mjs';
import { routeDetail, parseTiersTable } from '../providers/_role-route.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nscan.mjs — the gate on the stored advert (seam 5)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const CONFIG = {
  content_filter: {
    negative: ['5+ years', 'at least 8 years'],
  },
  country_eligibility_filter: {
    exclusionary: ['must be located in the united states'],
    inclusive: ['united states or canada'],
  },
  visa_filter: { enabled: true },
  title_filter: { positive: ['product manager'] },
};

function makeGate(config = CONFIG, country = 'United Kingdom') {
  return buildAdvertGate({
    contentFilter: buildContentFilter(config.content_filter),
    countryEligibilityFilter: buildCountryEligibilityFilter(config.country_eligibility_filter, country),
    visaFilter: buildVisaFilter(config.visa_filter),
    explain: buildDropExplainer(config, country),
  });
}

const gate = makeGate();

// ── A read advert with a five-year floor drops, and names the phrase ──
{
  const text = 'We want a Programme Manager with 5+ years of delivery experience.';
  const verdict = gate({ description: text, readStatus: 'read' });
  eq('a five-year floor drops the row', verdict.drop, true);
  eq('the reason is content', verdict.reason, 'content');
  eq('the phrase that dropped it is named', verdict.phrase, '5+ years');
}

// ── A clean advert survives ─────────────────────────────────────────
{
  const text = 'We want a Programme Manager with 2 to 4 years of delivery experience.';
  const verdict = gate({ description: text, readStatus: 'read' });
  eq('a clean advert is kept', verdict.drop, false);
  ok('and it is not marked unread', !verdict.unread);
}

// ── A row nobody could read is never dropped on its advert ──────────
//
// This is the silent pass the whole ticket exists to close, seen from the other
// side: an empty description must not be read as a clean one, and it must not
// be read as a dirty one either.
{
  for (const status of ['unreadable', 'blocked', 'shell']) {
    const verdict = gate({ description: '', readStatus: status });
    eq(`a ${status} row is kept`, verdict.drop, false);
    eq(`a ${status} row is marked unread`, verdict.unread, true);
  }
  // Even when the little text it did get would have dropped it.
  const verdict = gate({ description: 'Sign in to continue. 5+ years', readStatus: 'blocked' });
  eq('an unread row is not dropped on the scraps it returned', verdict.drop, false);
}

// ── A board that hands over its own advert has no read status ───────
{
  const verdict = gate({ description: 'Needs 5+ years.', readStatus: null });
  eq("a board's own description is filtered exactly as before", verdict.drop, true);
  eq('and the reason is unchanged', verdict.reason, 'content');
}

// ── The other two filters name their own phrases ────────────────────
{
  const eligibility = gate({
    description: 'Applicants must be located in the united states to be considered.',
    readStatus: 'read',
  });
  eq('an eligibility bar drops the row', eligibility.reason, 'countryEligibility');
  eq('and names the phrase', eligibility.phrase, 'must be located in the united states');

  const visa = gate({
    description: 'This role offers no sponsorship for work authorisation.',
    readStatus: 'read',
  });
  eq('a refusal to sponsor drops the row', visa.reason, 'visa');
  eq('and names the phrase', visa.phrase, 'no sponsorship');
}

// ── An override keyword's own negative list is what explains it ─────
{
  const config = {
    content_filter: {
      negative: ['5+ years'],
      by_title_keyword: { 'product manager': { negative: ['warehouse'] } },
    },
    title_filter: { positive: ['product manager'] },
  };
  const g = makeGate(config, 'United Kingdom');
  const verdict = g({
    description: 'A warehouse pick-and-pack role.',
    matchedKeywords: ['product manager'],
    readStatus: 'read',
  });
  eq('the override drops the row', verdict.drop, true);
  eq("the override's own phrase is named", verdict.phrase, 'warehouse');
}

// ── An unconfigured filter drops nothing ────────────────────────────
{
  const g = buildAdvertGate({});
  eq('a gate with no filters keeps everything', g({ description: 'anything at all' }).drop, false);
}

// ── The DROP line ───────────────────────────────────────────────────
{
  eq(
    'the drop line names the company, the title, the phrase and the stored advert',
    formatAdvertDropRow({
      company: 'Acme Ltd', title: 'Programme Manager',
      reason: 'content', phrase: '5+ years',
      jdPath: 'jds/acme-ltd-programme-manager-0123456789.md',
      url: 'https://acme.example/jobs/1',
    }),
    'DROP | Acme Ltd | Programme Manager | content: "5+ years" | jd: local:jds/acme-ltd-programme-manager-0123456789.md',
  );
  eq(
    'a row with no stored advert names its URL instead, never nothing',
    formatAdvertDropRow({
      company: 'Acme Ltd', title: 'Programme Manager',
      reason: 'visa', phrase: 'no sponsorship',
      jdPath: '', url: 'https://acme.example/jobs/1',
    }),
    'DROP | Acme Ltd | Programme Manager | visa: "no sponsorship" | https://acme.example/jobs/1',
  );
}

// ── The two summary lines ───────────────────────────────────────────
{
  const drops = emptyAdvertDropTally();
  for (let i = 0; i < 12; i++) countAdvertDrop(drops, { reason: 'content', phrase: '5+ years' });
  countAdvertDrop(drops, { reason: 'visa', phrase: 'no sponsorship' });

  const tiers = parseTiersTable([
    'name\tnotes\ttier',
    'One\t\t1',
    'Two\t\t2',
    'Three\t\t3',
    'Marked Co\troute: score — worth the full evaluation\t3',
  ].join('\n'));
  const routes = emptyRouteTally();
  countRoute(routes, routeDetail('One', tiers));
  countRoute(routes, routeDetail('Two', tiers));
  countRoute(routes, routeDetail('Marked Co', tiers));
  countRoute(routes, routeDetail('Three', tiers));
  countRoute(routes, routeDetail('Not In The Table', tiers));

  const lines = formatGateSummary(drops, routes);
  eq('both lines are printed', lines.length, 2);
  ok('the drop line counts the total', lines[0].includes('Dropped on advert:     13'));
  ok('and breaks it down by reason', lines[0].includes('(content 12, visa 1)'));
  ok('and says the drops are named below', lines[0].includes('each named below'));
  ok('the routes line counts the score route', lines[1].includes('score 3'));
  ok('and breaks it down', lines[1].includes('tier 1: 1, tier 2: 1, flagged: 1'));
  ok('and counts the standard route', lines[1].includes('standard 2'));
  ok('and breaks that down too', lines[1].includes('tier 3: 1, untiered: 1'));

  eq('a run with neither prints nothing', formatGateSummary(emptyAdvertDropTally(), emptyRouteTally()).length, 0);
  eq('a run with routes but no drops prints one line', formatGateSummary(emptyAdvertDropTally(), routes).length, 1);
}

// ── The route rides the queue line ──────────────────────────────────
{
  const base = { url: 'https://acme.example/jobs/1', company: 'Acme', title: 'Analyst' };
  eq(
    'an offer with no route writes the line it always wrote',
    formatPipelineOffer(base),
    '- [ ] https://acme.example/jobs/1 | Acme | Analyst',
  );
  eq(
    'a routed offer carries the segment',
    formatPipelineOffer({ ...base, route: 'score' }),
    '- [ ] https://acme.example/jobs/1 | Acme | Analyst | route: score',
  );
  eq(
    'the route sits after jd: and before note:, like every other labelled segment',
    formatPipelineOffer({ ...base, jdPath: 'jds/acme-analyst-0123456789.md', route: 'standard', note: 'from a list' }),
    '- [ ] https://acme.example/jobs/1 | Acme | Analyst | jd: local:jds/acme-analyst-0123456789.md | route: standard | note: from a list',
  );
}

// ── The per-source ledger still reconciles with the gate's drops ────
//
// The gate reuses the three reasons the ledger already knows, so the breakdown
// must still sum to the run totals. A new reason that nobody added to the
// ledger would show up here as a gap, not as a wrong number in production.
{
  const ledger = createSourceLedger();
  ledger.register('Acme', { kind: 'company' });
  ledger.found('Acme', 4);
  ledger.drop('Acme', 'content');
  ledger.drop('Acme', 'countryEligibility');
  ledger.drop('Acme', 'visa');
  ledger.keep('Acme');
  const record = ledger.record('Acme');
  const issues = reconcileSourceLedger(ledger, {
    found: 4, kept: 1, content: 1, countryEligibility: 1, visa: 1,
  });
  eq('the ledger reconciles after three gate drops', issues.length, 0);
  eq('and counts them all', record.dropped, 3);
}
