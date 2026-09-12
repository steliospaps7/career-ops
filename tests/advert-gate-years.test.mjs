/**
 * tests/advert-gate-years.test.mjs — C1 of ticket C, the gate on the extractor.
 *
 * `experience-clause` asks what a sentence says. This file asks what the gate
 * does about it, which is the 12 September decision table in
 * `projects/career/General Role Criteria v1.md`:
 *
 *   no years, or a minimum of three or fewer  → kept, scored normally
 *   a minimum of four                         → kept, and the row says so
 *   a minimum of five or more                 → dropped, naming the sentence
 *   a range                                   → counts by its lower bound
 *   "preferred", "ideally", "nice to have"    → never a cut on its own
 *   a sentence about the company              → not about him
 *
 * Audit findings F01 and F03, acceptance A01 to A04, A08 and A16.
 *
 * Nothing here touches the network.
 *
 * Run: node test-all.mjs --only advert-gate-years
 */

import {
  buildAdvertGate,
  buildContentFilter,
  buildDropExplainer,
  judgeExperienceYears,
  YEARS_FLOOR,
  YEARS_STRETCH,
  ADVERT_DROP_REASONS,
  ADVERT_DROP_LABELS,
  formatAdvertDropRow,
  formatGateSummary,
  emptyAdvertDropTally,
  countAdvertDrop,
  formatPipelineOffer,
  extractYearsSegment,
  insertYearsSegment,
} from '../scan.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nscan.mjs — the gate reads the years clause (C1)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// The years rule needs no configuration: the floor is policy, not a portals.yml
// entry, which is the whole point of taking the phrases out of the file. The
// content filter below carries one non-years entry to prove C1 left the rest of
// `content_filter` alone.
const CONFIG = { content_filter: { negative: ['unpaid internship'] } };

function makeGate(config = CONFIG) {
  return buildAdvertGate({
    contentFilter: buildContentFilter(config.content_filter),
    explain: buildDropExplainer(config, 'United Kingdom'),
  });
}

const gate = makeGate();

// ── 1. The floor, and what it drops ──────────────────────────────────

{
  eq('the floor is five, as it was on 3 September', YEARS_FLOOR, 5);
  eq('and four is the long shot', YEARS_STRETCH, 4);
}

{
  const drops = [
    ['T07', 'You must have 5+ years of product management experience.'],
    ['T08', 'You must have 5 years of product management experience.'],
    ['T09', 'You must have 5–7 years of product management experience.'],
    ['T10', 'You must have at least five years of product management experience.'],
    ['a six-year bar', 'A minimum of 6 years of experience is required.'],
    ['an eight-year bar', 'You need 8+ years of experience.'],
    ['a bare requirement with no cue', '5+ years of product management experience.'],
  ];
  for (const [label, description] of drops) {
    const verdict = gate({ description, readStatus: 'read' });
    if (verdict.drop && verdict.reason === 'years') {
      pass(`${label} is dropped on years`);
      ok(`${label} names the sentence it was dropped on`, /years/.test(verdict.phrase || ''));
    } else {
      fail(`${label} was not dropped on years: ${JSON.stringify(verdict)}`);
    }
  }
}

{
  // Point 8 of the criteria file: a cut needs a sentence in the advert, quoted.
  const verdict = gate({ description: 'You must have 5+ years of product management experience.', readStatus: 'read' });
  eq(
    'the quoted sentence is the advert\'s own words',
    verdict.phrase,
    'You must have 5+ years of product management experience.',
  );
}

// ── 2. What the old filter got wrong, and now keeps ──────────────────
// Each of these was rejected or accepted wrongly on 11 September. The audit's
// acceptance column asks for the opposite.

{
  const kept = [
    ['T11 a range with a low bound', 'You need 2–5 years of relevant experience.'],
    ['T12 a preference, not a requirement', 'You need two years of experience; 5+ years is preferred, not required.'],
    ['T13 company history', 'We have served customers for 5+ years. You need two years of experience.'],
    ['a company sentence that says "experience"', 'We have over 5 years of experience building payments infrastructure.'],
    ['Super Payments', "We'd love it if you have 3–5+ years of product management experience, and the stated "
      + 'experience does not preclude applications from candidates with more or less experience.'],
    ['a three-year bar', 'You need 3 years of experience.'],
    ['an advert with no years at all', 'You will own the roadmap and ship weekly.'],
    ['Greenhouse boilerplate', 'People can become disabled, so we need to ask this question at least every five years.'],
  ];
  for (const [label, description] of kept) {
    const verdict = gate({ description, readStatus: 'read' });
    if (verdict.drop) fail(`${label} was dropped: ${JSON.stringify(verdict)}`);
    else pass(`${label} is kept`);
  }
}

// ── 3. The long shot: four is kept and the row says four ─────────────

{
  const verdict = gate({ description: 'You must have at least four years of experience.', readStatus: 'read' });
  eq('a four-year bar is not dropped', verdict.drop, false);
  eq('and the row carries years: 4 so triage sees the long shot', verdict.years, 4);
}

{
  const verdict = gate({ description: 'You need 4–6 years of experience.', readStatus: 'read' });
  eq('a 4-to-6 range counts as four', verdict.years, 4);
  eq('and is kept', verdict.drop, false);
}

{
  const verdict = gate({ description: 'You need 3 years of experience.', readStatus: 'read' });
  eq('a three-year bar carries no years segment', verdict.years, undefined);
}

{
  const verdict = gate({ description: 'Four years of experience preferred.', readStatus: 'read' });
  eq('a preferred four-year bar is not a long shot either', verdict.years, undefined);
}

// ── 4. What C1 did not change ────────────────────────────────────────

{
  // An advert nobody could read still costs the row nothing. A08.
  for (const readStatus of ['unreadable', 'expired', 'blocked']) {
    const verdict = gate({ description: 'You must have 8+ years of experience.', readStatus });
    eq(`a ${readStatus} row is not dropped on a years clause it never read`, verdict.drop, false);
    eq(`and carries no years segment`, verdict.years, undefined);
  }
}

{
  // The non-years half of content_filter still bites, and still first.
  const verdict = gate({ description: 'An unpaid internship requiring 8+ years of experience.', readStatus: 'read' });
  eq('a non-years content entry still drops the row', verdict.drop, true);
  eq('and is named as content, not years', verdict.reason, 'content');
  eq('with the phrase it matched', verdict.phrase, 'unpaid internship');
}

{
  eq('an empty description is kept — T14', gate({ description: '', readStatus: 'read' }).drop, false);
  eq('an absent description is kept', gate({ readStatus: 'read' }).drop, false);
  eq('a row with no read status at all is filtered as it always was', gate({ description: 'You must have 8+ years of experience.' }).drop, true);
}

// ── 5. judgeExperienceYears, the rule on its own ─────────────────────

{
  const bad = judgeExperienceYears('You must have 7 years of experience.');
  eq('the rule drops a seven-year bar', bad.drop, true);
  ok('naming the sentence', (bad.sentence || '').includes('7 years'));
  eq('and reports no stretch', bad.years, undefined);

  const stretch = judgeExperienceYears('You must have 4 years of experience.');
  eq('the rule keeps a four-year bar', stretch.drop, false);
  eq('and reports it as a stretch', stretch.years, 4);

  const clean = judgeExperienceYears('You will own the roadmap.');
  eq('an advert with no clause is clean', clean.drop, false);
  eq('with no stretch', clean.years, undefined);
}

{
  // The extractor is injectable, so the rule can be tested without the reader
  // and a future policy change has one place to go.
  const fake = () => [{ minimum: 9, mandatory: true, subject: 'candidate', sentence: 'nine years of experience' }];
  const verdict = judgeExperienceYears('anything', fake);
  eq('the rule reads whatever extractor it is given', verdict.drop, true);
  eq('and quotes that extractor\'s sentence', verdict.sentence, 'nine years of experience');
}

{
  // Two binding clauses: the row is dropped on the highest, and the stretch
  // reports the highest stretch rather than the first one seen.
  const two = () => [
    { minimum: 4, mandatory: true, subject: 'candidate', sentence: 'four years' },
    { minimum: 4, mandatory: null, subject: 'unknown', sentence: 'four years again' },
  ];
  eq('two four-year clauses still read as one long shot', judgeExperienceYears('x', two).years, 4);
}

// ── 6. The run's own output ──────────────────────────────────────────

{
  eq('the ledger tries content first, then years', ADVERT_DROP_REASONS.indexOf('years'), ADVERT_DROP_REASONS.indexOf('content') + 1);
  ok('country eligibility still comes after', ADVERT_DROP_REASONS.indexOf('countryEligibility') > ADVERT_DROP_REASONS.indexOf('years'));
  eq('and the label Stelios reads is "years"', ADVERT_DROP_LABELS.years, 'years');
}

{
  const row = {
    company: 'Navan',
    title: 'Business Operations Manager',
    jdPath: 'jds/navan-business-operations-manager.md',
    reason: 'years',
    phrase: 'You must have 5+ years of experience.',
  };
  eq(
    'the DROP line carries the sentence and the stored advert',
    formatAdvertDropRow(row),
    'DROP | Navan | Business Operations Manager | years: "You must have 5+ years of experience." '
    + '| jd: local:jds/navan-business-operations-manager.md',
  );
}

{
  const tally = emptyAdvertDropTally();
  countAdvertDrop(tally, { reason: 'years', company: 'A', title: 'B' });
  countAdvertDrop(tally, { reason: 'years', company: 'C', title: 'D' });
  countAdvertDrop(tally, { reason: 'content', company: 'E', title: 'F' });
  const lines = formatGateSummary(tally, null);
  ok('the summary counts the years drops on their own', /years 2/.test(lines[0]));
  ok('beside the content ones', /content 1/.test(lines[0]));
  ok('and gives the total', /Dropped on advert:     3/.test(lines[0]));
}

// ── 7. The years segment on a queue line ─────────────────────────────

{
  const line = formatPipelineOffer({
    url: 'https://example.com/jobs/1', company: 'Acme', title: 'Product Manager',
    jdPath: 'jds/acme-product-manager.md', years: 4, route: 'standard', note: 'from a list',
  });
  eq(
    'formatPipelineOffer writes years: after jd: and before route:',
    line,
    '- [ ] https://example.com/jobs/1 | Acme | Product Manager | jd: local:jds/acme-product-manager.md '
    + '| years: 4 | route: standard | note: from a list',
  );
  eq('and it reads back', extractYearsSegment(line), 4);
}

{
  const plain = formatPipelineOffer({ url: 'https://example.com/jobs/2', company: 'Acme', title: 'Product Owner' });
  eq('a row with no long shot writes no segment', plain, '- [ ] https://example.com/jobs/2 | Acme | Product Owner');
  eq('and reads back as nothing', extractYearsSegment(plain), null);
}

{
  const line = '- [ ] https://example.com/jobs/3 | Acme | PM | jd: local:jds/acme-pm.md | route: score | note: x';
  const labelled = insertYearsSegment(line, 4);
  eq(
    'the segment goes in before route: on a line written on an earlier day',
    labelled,
    '- [ ] https://example.com/jobs/3 | Acme | PM | jd: local:jds/acme-pm.md | years: 4 | route: score | note: x',
  );
  eq('a second pass changes nothing', insertYearsSegment(labelled, 4), labelled);
  eq('and re-labelling replaces rather than appends', insertYearsSegment(labelled, 5), labelled.replace('years: 4', 'years: 5'));
  eq('a row that is no longer a long shot loses the segment', insertYearsSegment(labelled, null), line);
}

{
  const bare = '- [ ] https://example.com/jobs/4 | Acme | PM';
  eq('a bare line gets the segment appended', insertYearsSegment(bare, 4), `${bare} | years: 4`);
  eq('and nothing happens when there is nothing to say', insertYearsSegment(bare, null), bare);
}

{
  const noted = '- [ ] https://example.com/jobs/5 | Acme | PM | note: x';
  eq('with a note but no route, the segment goes before the note', insertYearsSegment(noted, 4), '- [ ] https://example.com/jobs/5 | Acme | PM | years: 4 | note: x');
}
