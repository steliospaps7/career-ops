/**
 * tests/experience-clause.test.mjs — C1 of ticket C, the extractor alone.
 *
 * The audit (`General Career Ops Search Audit and Repair Plan v1.md`, F01,
 * acceptance A01 to A04) ran fifteen inputs against the substring filter and
 * found it rejecting "5+ years is preferred, not required" and "we have served
 * customers for 5+ years" while keeping "5 years" and "5 to 7 years". T07 to
 * T13 below are its exact inputs, copied character for character — the en dash
 * in T09 and T11 is the audit's own and substituting a hyphen would change the
 * test.
 *
 * The gate's half of the rule is `advert-gate-years`. This file only asks what
 * the extractor reads out of a sentence.
 *
 * Nothing here touches the network.
 *
 * Run: node test-all.mjs --only experience-clause
 */

import { extractExperienceClauses } from '../providers/_experience-clause.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nproviders/_experience-clause.mjs — the years clause is read, not matched (C1)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The clauses that would bind him: about the reader, and not a preference. */
function binding(text) {
  return extractExperienceClauses(text).filter(c => c.subject !== 'company' && c.mandatory !== false);
}

function only(label, text) {
  const clauses = extractExperienceClauses(text);
  if (clauses.length !== 1) {
    fail(`${label} — expected one clause, got ${clauses.length}: ${JSON.stringify(clauses)}`);
    return null;
  }
  return clauses[0];
}

// ── 1. The audit's own inputs, T07 to T13 ────────────────────────────
// Each is quoted from the report's "Observed filter results" table. The
// "Observed result" column is what the substring filter did; the assertion
// below is what the acceptance column asks for instead.

{
  // T07 — the phrase the old list actually carried.
  const c = only('T07', 'You must have 5+ years of product management experience.');
  if (c) {
    eq('T07 minimum is five', c.minimum, 5);
    eq('T07 is mandatory', c.mandatory, true);
    eq('T07 is about the candidate', c.subject, 'candidate');
    ok('T07 names the sentence it read', c.sentence.includes('5+ years'));
  }
}

{
  // T08 — kept by the old filter because no entry spelled it this way. A01.
  const c = only('T08', 'You must have 5 years of product management experience.');
  if (c) {
    eq('T08 minimum is five, the equivalent form the old list missed', c.minimum, 5);
    eq('T08 is mandatory', c.mandatory, true);
    eq('T08 is about the candidate', c.subject, 'candidate');
  }
}

{
  // T09 — an en dash range. The character is the audit's; do not normalize it.
  const text = 'You must have 5–7 years of product management experience.';
  ok('T09 still carries the en dash', text.includes('–'));
  const c = only('T09', text);
  if (c) {
    eq('T09 counts by its lower bound', c.minimum, 5);
    eq('T09 is mandatory', c.mandatory, true);
    eq('T09 is about the candidate', c.subject, 'candidate');
  }
}

{
  // T10 — the written-out form the old list already covered.
  const c = only('T10', 'You must have at least five years of product management experience.');
  if (c) {
    eq('T10 reads the number word', c.minimum, 5);
    eq('T10 is mandatory', c.mandatory, true);
  }
}

{
  // T11 — A02: the lower bound is two, so nothing here binds at five.
  const text = 'You need 2–5 years of relevant experience.';
  ok('T11 still carries the en dash', text.includes('–'));
  const c = only('T11', text);
  if (c) {
    eq('T11 minimum is its lower bound, not the five in the string', c.minimum, 2);
    eq('T11 is mandatory', c.mandatory, true);
  }
  eq('T11 binds at two', binding(text).map(c2 => c2.minimum).join(), '2');
}

{
  // T12 — A03: the requirement and the preference stay two different things.
  const text = 'You need two years of experience; 5+ years is preferred, not required.';
  const clauses = extractExperienceClauses(text);
  eq('T12 yields two clauses', clauses.length, 2);
  if (clauses.length === 2) {
    eq('T12 the requirement is two years', clauses[0].minimum, 2);
    eq('T12 the requirement is mandatory', clauses[0].mandatory, true);
    eq('T12 the preference is five years', clauses[1].minimum, 5);
    eq('T12 the preference is not a bar', clauses[1].mandatory, false);
  }
  eq('T12 has no binding clause at five', binding(text).filter(c => c.minimum >= 5).length, 0);
}

{
  // T13 — A04: company history is not candidate experience.
  // "We have served customers for 5+ years." says nothing about experience in
  // its own sentence, so since the build review's fix 3 it is not read as a
  // clause at all; it used to borrow "experience" from the next sentence and
  // was saved only by its company subject. The audit asks that T13 is not
  // rejected on the five and that company age is not his experience; both
  // hold. The company subject is proved in section 2, on a company sentence
  // that does carry the word.
  const text = 'We have served customers for 5+ years. You need two years of experience.';
  const clauses = extractExperienceClauses(text);
  eq('T13 reads only the candidate sentence', clauses.length, 1);
  if (clauses.length === 1) {
    eq('T13 the two-year requirement is his', clauses[0].minimum, 2);
    eq('T13 and is about the candidate', clauses[0].subject, 'candidate');
  }
  eq('T13 has no binding clause at five', binding(text).filter(c => c.minimum >= 5).length, 0);
}

{
  // T14 — an empty description yields nothing to read. The gate, not this
  // module, decides that nothing read is not a reason to drop.
  eq('T14 an empty description yields no clause', extractExperienceClauses('').length, 0);
  eq('a description of only whitespace yields no clause', extractExperienceClauses('   \n  ').length, 0);
}

// ── 2. A company sentence that would otherwise cost the row ──────────
// T13's is company history beside a candidate requirement. These are the same
// finding without the neighbour: a company sentence carrying a five-year
// number and the word "experience", where only the subject saves the row.

{
  const c = only('company subject', 'We have over 5 years of experience building payments infrastructure.');
  if (c) {
    eq('a company-history clause is read', c.minimum, 5);
    eq('and attributed to the company', c.subject, 'company');
  }
  eq(
    'so it binds nothing',
    binding('We have over 5 years of experience building payments infrastructure.').length,
    0,
  );
}

{
  const c = only('our platform', 'Our platform has been in business for ten years of continuous operating experience.');
  if (c) eq('"our platform has" is the company too', c.subject, 'company');
}

{
  // Navan's real advert, which read as company history on the first build:
  // a bare "in business" cue matched "experience in business operations".
  const c = only('in business operations', '5+ years experience in business operations and finance operations.');
  if (c) {
    eq('"experience in business operations" is not the employer\'s age', c.subject !== 'company', true);
    eq('and the minimum is still five', c.minimum, 5);
  }
}

{
  // The false negative to guard against: a company pronoun in front of a
  // requirement aimed at the reader is still a requirement.
  const c = only('we require', 'We require 8 years of experience in a similar role.');
  if (c) {
    eq('"we require" is not company history', c.subject !== 'company', true);
    eq('and it is mandatory', c.mandatory, true);
    eq('at eight years', c.minimum, 8);
  }
}

// ── 3. Super Payments, the row this ticket exists for ────────────────
// The stored advert reads "We'd love it if you have 3–5+ years …" and, further
// down the same block, "does not preclude applications from candidates with
// more or less experience". The old filter dropped it on the substring
// "5+ years" while triage passed the same role at 3.9. Quoted from
// jds/super-payments-product-manager-2a61ec1148.md.

{
  const text = "We'd love it if you have 3–5+ years of product management experience "
    + 'working on consumer focused features with a track record of taking features from zero to one '
    + 'Nice to have: experience in e-commerce/retail *The stated experience and background is a guide '
    + 'and does not preclude applications from candidates with more or less experience, provided the '
    + 'requisite skills can be demonstrated.';
  const clauses = extractExperienceClauses(text);
  const five = clauses.filter(c => c.minimum >= 5);
  eq('Super Payments: nothing is read at five', five.length, 0);
  const three = clauses.find(c => c.minimum === 3);
  if (three) {
    eq('Super Payments: minimum three, its lower bound', three.minimum, 3);
    eq('Super Payments: preferred, not required', three.mandatory, false);
    eq('Super Payments: about the candidate', three.subject, 'candidate');
    ok('Super Payments: the sentence is quoted from the advert', three.sentence.includes('3–5+ years'));
  } else {
    fail(`Super Payments: no three-year clause in ${JSON.stringify(clauses)}`);
  }
  eq('Super Payments: nothing binds at five', binding(text).filter(c => c.minimum >= 5).length, 0);
}

// ── 4. The forms the old list spelled out one by one ─────────────────
// Every entry removed from portals.yml has a case here, so the change loses
// no coverage. Each is read as a minimum instead of matched as a string.

{
  const cases = [
    ['5+ years', 'You must have 5+ years of experience.', 5],
    ['5+ yrs', 'You must have 5+ yrs of experience.', 5],
    ['five+ years', 'You must have five+ years of experience.', 5],
    ['at least 5 years', 'At least 5 years of experience is required.', 5],
    ['minimum of 5 years', 'A minimum of 5 years of experience.', 5],
    ['minimum 5 years', 'Minimum 5 years of experience.', 5],
    ['5 or more years', 'You need 5 or more years of experience.', 5],
    ['5 years or more', 'You need 5 years or more of relevant experience.', 5],
    ['at least five years', 'At least five years of experience is essential.', 5],
    ['minimum of five years', 'A minimum of five years of experience.', 5],
    ['five or more years', 'Five or more years of experience is required.', 5],
    ['5-7 years hyphen', 'You must have 5-7 years of experience.', 5],
    ['5 - 7 years spaced hyphen', 'You must have 5 - 7 years of experience.', 5],
    ['5 to 7 years', 'You must have 5 to 7 years of experience.', 5],
    ['6+ years', 'You must have 6+ years of experience.', 6],
    ['at least six years', 'At least six years of experience.', 6],
    ['7+ years', 'You must have 7+ years of experience.', 7],
    ['8+ years', 'You must have 8+ years of experience.', 8],
    ['10+ years', 'You must have 10+ years of experience.', 10],
    ['15+ years', 'You must have 15+ years of experience.', 15],
    ['20+ years', 'You must have 20+ years of experience.', 20],
    ['5 years+', 'You must have 5 years+ of experience.', 5],
    ['over 5 years', 'Over 5 years of experience is required.', 5],
    ['over ten years', 'Over ten years of experience is required.', 10],
    ['more than 5 years', 'More than 5 years of experience is required.', 5],
    ['more than ten years', 'More than ten years of experience is required.', 10],
    ['8 - 12 years', 'You must have 8 - 12 years of experience.', 8],
    ['10 - 15 years', 'You must have 10 - 15 years of experience.', 10],
  ];
  let wrong = 0;
  for (const [label, text, expected] of cases) {
    const clauses = extractExperienceClauses(text);
    const got = clauses.length === 1 ? clauses[0].minimum : `${clauses.length} clauses`;
    if (got !== expected) {
      wrong++;
      fail(`removed phrase "${label}" reads ${JSON.stringify(got)}, expected ${expected}`);
    }
  }
  if (wrong === 0) pass(`all ${cases.length} phrases removed from content_filter are read as minimums`);
}

// ── 5. Retention: the ranges and the low bars he clears ──────────────
// A suite that only proves rejections proves nothing. Every case here must
// come back with a minimum below five, which is what keeps the row.

{
  const kept = [
    ['2-5 years', 'You need 2-5 years of experience.', 2],
    ['3–5 years en dash', 'You need 3–5 years of experience.', 3],
    ['3 to 5 years', 'You need 3 to 5 years of experience.', 3],
    ['2 to 4 years', 'You need 2 to 4 years of experience.', 2],
    ['three years', 'You need three years of experience.', 3],
    ['1+ years', 'You need 1+ years of experience.', 1],
    ['two years', 'Two years of experience is required.', 2],
  ];
  let wrong = 0;
  for (const [label, text, expected] of kept) {
    const clauses = binding(text);
    const got = clauses.length === 1 ? clauses[0].minimum : `${clauses.length} clauses`;
    if (got !== expected) {
      wrong++;
      fail(`retained case "${label}" reads ${JSON.stringify(got)}, expected ${expected}`);
    }
  }
  if (wrong === 0) pass(`all ${kept.length} ranges and low bars read below the floor of five`);
}

{
  // The long shot: four is read as four, kept, and named. The scan keeps it;
  // triage decides, which is the 12 September decision table.
  const c = only('four years', 'You must have at least four years of experience.');
  if (c) {
    eq('a minimum of four is read as four', c.minimum, 4);
    eq('and it is mandatory', c.mandatory, true);
  }
}

// ── 6. Preference wording, each form the decision table names ────────

{
  const preferences = [
    ['preferred', '5+ years of experience preferred.'],
    ['ideally', 'Ideally you have 5+ years of experience.'],
    ['nice to have', 'Nice to have: 6+ years of experience.'],
    ['bonus', 'A bonus if you have 7+ years of experience.'],
    ["we'd love it if", "We'd love it if you have 8+ years of experience."],
    ['would be a plus', '5+ years of experience would be a plus.'],
    ['not required', '5+ years of experience is preferred, not required.'],
    ['not essential', '10+ years of experience is not essential.'],
  ];
  let wrong = 0;
  for (const [label, text] of preferences) {
    const clauses = extractExperienceClauses(text);
    const got = clauses.length === 1 ? clauses[0].mandatory : `${clauses.length} clauses`;
    if (got !== false) {
      wrong++;
      fail(`preference "${label}" read mandatory ${JSON.stringify(got)}, expected false`);
    }
  }
  if (wrong === 0) pass(`all ${preferences.length} preference forms are read as not a bar`);
}

{
  const bars = [
    ['must', 'You must have 5 years of experience.'],
    ['required', '5 years of experience is required.'],
    ['at least', 'At least 5 years of experience.'],
    ['minimum', 'Minimum 5 years of experience.'],
    ['need', 'You need 5 years of experience.'],
    ['essential', '5 years of experience is essential.'],
  ];
  let wrong = 0;
  for (const [label, text] of bars) {
    const clauses = extractExperienceClauses(text);
    const got = clauses.length === 1 ? clauses[0].mandatory : `${clauses.length} clauses`;
    if (got !== true) {
      wrong++;
      fail(`bar "${label}" read mandatory ${JSON.stringify(got)}, expected true`);
    }
  }
  if (wrong === 0) pass(`all ${bars.length} mandatory forms are read as a bar`);
}

{
  // Neither word present: the module says it does not know rather than
  // guessing. The gate treats `null` as binding, because a bare requirement
  // list is the common shape.
  const c = only('no cue', '5+ years of product management experience.');
  if (c) eq('with no cue either way, mandatory is null', c.mandatory, null);
}

{
  // A later sentence withdrawing the bar. The decision table's own case.
  const text = 'You must have 5+ years of experience. The stated experience does not preclude '
    + 'applications from candidates with less experience.';
  const c = only('does not preclude', text);
  if (c) {
    eq('a later "does not preclude" withdraws the bar', c.mandatory, false);
    eq('the minimum is still read', c.minimum, 5);
  }
}

{
  // The other direction: an earlier withdrawal does not excuse a later bar.
  const text = 'Our last posting did not preclude applications from candidates with less experience. '
    + 'This one requires at least 8 years of experience.';
  const clauses = extractExperienceClauses(text).filter(c => c.minimum === 8);
  eq('an earlier withdrawal does not soften a later bar', clauses.length === 1 && clauses[0].mandatory, true);
}

// ── 7. What is not an experience clause ──────────────────────────────
// The years number has to be about experience, or Greenhouse's own boilerplate
// costs the row. The Super Payments page carries "we need to ask this question
// at least every five years" inside the disability form: "at least", "need",
// "five years", and nothing to do with the job.

{
  const boilerplate = [
    'People can become disabled, so we need to ask this question at least every five years.',
    'Super has raised $66M from leading investors and was founded by Samir Desai CBE.',
    'Comprehensive PMI & x4 Life Insurance.',
    'The company has been growing 4x YOY for 5 years.',
  ];
  let leaked = 0;
  for (const text of boilerplate) {
    const clauses = binding(text);
    if (clauses.length > 0) {
      leaked++;
      fail(`boilerplate read as a binding clause: ${text} → ${JSON.stringify(clauses)}`);
    }
  }
  if (leaked === 0) pass(`none of the ${boilerplate.length} boilerplate sentences binds the row`);
}

{
  // A number only starts at a word boundary. Without one the reader took the
  // "one" out of "everyone" as a minimum of one, and the "95" out of 1995 as a
  // minimum of ninety-five, which drops the row. The build review's two cases;
  // its comma form of the second is kept as well, and it reads nothing either.
  eq('the "one" inside "everyone" is not a number', extractExperienceClauses('everyone years of experience').length, 0);
  eq('the "95" inside 1995 is not a number', extractExperienceClauses('founded in 1995 years of experience').length, 0);
  eq('nor with a comma after the year', extractExperienceClauses('founded in 1995, years of experience').length, 0);
  const c = only('a real number after a year', 'Founded in 1995, we need 3 years of experience.');
  if (c) eq('a real number beside a year is still read', c.minimum, 3);
}

// ── 8. The module is pure, and survives what a real page hands it ────

{
  const text = 'You must have 5+ years of experience.';
  const first = JSON.stringify(extractExperienceClauses(text));
  const second = JSON.stringify(extractExperienceClauses(text));
  eq('two calls on the same text give the same answer', first, second);
}

{
  eq('a non-string input yields no clause', extractExperienceClauses(null).length, 0);
  eq('a number yields no clause', extractExperienceClauses(42).length, 0);
  eq('an object yields no clause', extractExperienceClauses({}).length, 0);
}

{
  // A real stored advert is one enormous line: the bullets carry no full stops,
  // so a sentence split alone would quote three hundred words into the DROP
  // line. The quoted sentence has to stay readable.
  const long = `${'Shaping the roadmap and obsessing over the right problems. '.repeat(20)}`
    + 'You must have 8+ years of product management experience '
    + `${'and a track record of taking features from zero to one. '.repeat(20)}`;
  const c = extractExperienceClauses(long).find(x => x.minimum === 8);
  if (!c) {
    fail('the clause inside a very long block was not read');
  } else {
    ok('the quoted sentence stays under 260 characters', c.sentence.length <= 260);
    ok('and still contains the clause', c.sentence.includes('8+ years'));
  }
}

{
  // An advert with no full stop, question mark or semicolon anywhere. The
  // sentence scan used to walk to both ends of the text for every clause, so
  // the time grew with the square of the length: 11 seconds on this 152 KB
  // string before the fix, and 915 seconds on the build review's real one.
  // Every reader of the scan clips to the window anyway, so the scan now stops
  // there too. The bound is generous; the fixed reader takes a fraction of it.
  const long = '5 years of experience '.repeat(7000);
  const started = Date.now();
  const clauses = extractExperienceClauses(long);
  const took = Date.now() - started;
  ok(`a 152 KB advert with no punctuation is read in under 3 seconds (took ${took} ms)`, took < 3000);
  eq('and every clause in it is still read', clauses.length, 7000);
  ok('each quote still stays under the cap', clauses.every(c => c.sentence.length <= 260));
  ok('and is marked as cut on both sides', clauses[3500].sentence.startsWith('…') && clauses[3500].sentence.endsWith('…'));
}

{
  // The clip must not change what a punctuated advert quotes: a full stop just
  // inside the window's edge is still found as the sentence's start.
  const lead = 'x'.repeat(90);
  const text = `${lead}. You must have 6+ years of experience.`;
  const c = only('a boundary at the window edge', text);
  if (c) eq('a sentence starting inside the window is quoted whole, with no ellipsis', c.sentence, 'You must have 6+ years of experience.');
}

{
  // A withdrawal further back than the window, in the same unpunctuated block,
  // still withdraws: it is measured against its own sentence, not the window.
  const text = `The stated experience does not preclude applications from candidates with less ${'and we mean it '.repeat(12)}`
    + 'you will have 6+ years of experience';
  const c = only('a distant withdrawal', text);
  if (c) eq('a withdrawal 180 characters back in the same sentence still applies', c.mandatory, false);
}

{
  // Newlines and tabs are what the stored file actually carries.
  const c = only('across a newline', 'Requirements\n\nYou must have 6+ years\tof experience.\n');
  if (c) {
    eq('whitespace does not hide the clause', c.minimum, 6);
    ok('and the sentence is collapsed to one line', !/[\n\t]/.test(c.sentence));
  }
}

// ── 9. Real stored adverts the first build read wrongly ─────────────
// Each sentence below is quoted from a file under `jds/`, found by running the
// finished reader against all 1,354 stored adverts and comparing it with the
// phrase list it replaces. They are the five classes of mistake that sweep
// found, and every one of them is a decision Stelios never sees: a wrong keep
// costs him a row to read, a wrong cut costs him the role.

{
  // Cresta: the domain named instead of the word. No "experience" anywhere near
  // the number, and "ideally" 130 characters later is about the company being
  // B2B, not about the five years.
  const c = only('Cresta', 'Qualifications 5+ years in revenue operations, sales operations, GTM strategy, '
    + 'management consulting, or corporate strategy, ideally supporting a B2B SaaS company.');
  if (c) {
    eq('Cresta: "5+ years in revenue operations" is an experience clause', c.minimum, 5);
    eq('and a distant "ideally" does not withdraw the bar', c.mandatory !== false, true);
  }
}

{
  // Frontify and LSEG: a preference word after the clause, past a comma,
  // modifying what follows rather than the years.
  const frontify = only('Frontify', 'What you bring - You have 5+ years of experience in software '
    + 'product management, ideally working with enterprise customers.');
  if (frontify) eq('Frontify: a trailing "ideally" past a comma is not about the years', frontify.mandatory !== false, true);

  const lseg = only('LSEG', "Requirements: - 5+ years' experience in product management, preferably in an Agile/SAFe environment.");
  if (lseg) eq('LSEG: nor a trailing "preferably"', lseg.mandatory !== false, true);
}

{
  // Hogan Lovells (build review of Cb, fix 3): the wish is the last word of the
  // sentence, so it can describe nothing but the years, however far away it is.
  const hogan = only('Hogan Lovells', 'What you will bring: 7+ years of relevant experience within legal / professional services preferred. You will manage a team of analysts.');
  if (hogan) {
    eq('Hogan Lovells: minimum seven', hogan.minimum, 7);
    eq('Hogan Lovells: a sentence ending on "preferred" is not a bar', hogan.mandatory, false);
  }
  eq('Hogan Lovells: nothing binds', binding('7+ years of relevant experience within legal / professional services preferred.').length, 0);
  eq('"desirable" ending the sentence is a wish too',
    only('desirable', '5+ years of experience in a regulated financial services environment is desirable.')?.mandatory, false);
  eq('"nice to have" ending the sentence is a wish too',
    only('nice to have', '6 years of experience leading marketplace operations teams across Europe, nice to have!')?.mandatory, false);
  // Retention: a wish that carries on still keeps the 25-character reach.
  eq('a wish that continues past the sentence end does not withdraw the bar',
    only('continuing', '5+ years of experience in revenue operations, ideally in SaaS.')?.mandatory !== false, true);
  eq('nor does a wish in the next sentence',
    only('next sentence', 'You need 5+ years of experience in legal operations. A law degree is preferred.')?.mandatory, true);
  eq('nor a wish ending the other half of a semicolon',
    only('semicolon', '5+ years of experience in legal operations is required; a law degree is preferred.')?.mandatory, true);
}

{
  // Amazon: the same word before the clause, where it does govern it.
  const c = only('Amazon', 'Preferred Qualifications - 7+ years of product or program management experience.');
  if (c) eq('Amazon: a "Preferred Qualifications" header is a wish, not a bar', c.mandatory, false);
}

{
  // Company age with no pronoun in front of it. Five real sentences, each of
  // which the first build cut — including Monzo's Chief of Staff, a role he
  // wants. None may bind.
  const history = [
    ['Clear Drains', 'Clear Drains UK has built its reputation over 50+ years by delivering specialist commercial and domestic drainage experience.'],
    ['Indra', 'Drawing on over 30 years of experience in urban public transport solutions, Indra will manage the programme.'],
    ['TAIT', "With a legacy of innovation spanning over 45 years, TAIT has grown from pioneering in rock 'n' roll staging experience."],
    ['the IRC', 'BACKGROUND Over the past 90 years, the International Rescue Committee has developed unparalleled experience.'],
    ['Monzo', 'After starting as a prepaid card, our product offering has grown a lot in the last 10 years in ways that shape the experience.'],
    ['Paloma', 'Mark and Darshak, with their 25 years of combined NHS experience, including building services that reach millions.'],
    ['UBT', 'Our client is a joinery specialist with more than 30 years of experience delivering premium interior solutions.'],
  ];
  // UBT's real sentence is longer than this one, and its "Our client" sits 75
  // characters from the number — beyond the cue's reach, so the real advert
  // still reads `unknown` and still binds. Named in the build log as a residual
  // rather than fixed with a cue close enough to the number to be unsafe:
  // "experience delivering" is what a candidate requirement says too.
  let bound = 0;
  for (const [label, text] of history) {
    const clauses = binding(text);
    if (clauses.length > 0) { bound++; fail(`${label}'s own history binds the row: ${JSON.stringify(clauses)}`); }
  }
  if (bound === 0) pass(`none of the ${history.length} company-history sentences binds the row`);
}

{
  // An age bar, a sabbatical, a residency rule and a loyalty gift are not
  // experience, however many years they name.
  const notExperience = [
    ['Gopuff', 'You Have: - Must be 18 years or older - Experience working in a restaurant, retail or warehouse environment.'],
    ['SuperAwesome', '- 30 day sabbatical for employees who have reached 7 years tenure - AXA Private Medical Insurance and experience days.'],
    ['UKHSA', 'You should normally have been resident in the United Kingdom for the last 5 years as the role requires security experience clearance.'],
    ['Zava', '* Gift vouchers after 3, 5, 10 years of service with us, plus experience days.'],
    ['9fin', 'Work abroad for up to 3 months a year, 1 month paid sabbatical after 5 years of service, and experience days.'],
  ];
  let bound = 0;
  for (const [label, text] of notExperience) {
    const clauses = binding(text).filter(c => c.minimum >= 5);
    if (clauses.length > 0) { bound++; fail(`${label}: a non-experience sentence binds the row: ${JSON.stringify(clauses)}`); }
  }
  if (bound === 0) pass(`none of the ${notExperience.length} age, tenure, residency or loyalty sentences binds the row`);
}

{
  // A real bar and a benefits line inside the same 150 characters. The
  // relevance test and the exclusion used to read that whole window, so 9fin's
  // sabbatical sentence suppressed a six-year bar beside it and a role the
  // decision table puts out survived. Both now read the clause's own sentence.
  // Both orders, and in each the bar binds while the benefit does not.
  const bar = 'You must have 6+ years of experience in operations.';
  const benefit = 'Work abroad for up to 3 months a year, 1 month paid sabbatical after 5 years of service, and experience days.';
  for (const [label, text] of [['bar first', `${bar} ${benefit}`], ['benefit first', `${benefit} ${bar}`]]) {
    eq(`${label}: the six-year bar binds and the sabbatical does not`, binding(text).map(c => c.minimum).join(), '6');
  }
}

{
  // The relevance half on its own: a company sentence with no experience word
  // used to borrow "experience" from the next sentence, and with "you" close
  // enough it bound the row at five.
  const text = 'Revenue doubled every year for 5 years. You will need 2 years of experience.';
  eq('a neighbouring sentence does not make a growth figure an experience clause', binding(text).map(c => c.minimum).join(), '2');
}

{
  // The price of reading only the clause's own sentence: five stored adverts
  // whose bar carries no "experience" of its own and had been borrowing it
  // from a neighbour. Each shape is now read inside the sentence. Quoted from
  // the files under `jds/`.
  const shapes = [
    ['Jonas, "in a" and a role', 'JOB QUALIFICATIONS: - 5+ years in a senior management or business leadership role within software.', 5],
    ['Moneybox, "as a" and a role', 'This likely looks like 5+ years as a Programme Manager and 10+ years overall in change, transformation, data, AI, or engineering delivery.', 5],
    ['SeedLegals, a verb in -ing', 'Five or more years driving product with engineers and designers.', 5],
    ['Toast, a verb in -ing', '(Requirements) - ~8+ years shipping complex software products with demonstrated ownership of multi-team programs.', 8],
    ['Entain, years after a degree', 'Ability to lead a team, ideally at a top tier consultancy (such as McKinsey, BCG, Bain, OW, Kearney) with 6-10 years post undergrad or more than 2-3 years post MBA.', 6],
  ];
  for (const [label, text, expected] of shapes) {
    ok(`${label} is read as a bar at ${expected}`, binding(text).some(c => c.minimum === expected));
  }
  // And the look-alikes those shapes must not take in.
  const notShapes = [
    'Recognised as a Best Place to Work in Technology 3 years in a row.',
    'Voted top employer for 5 years running.',
  ];
  for (const text of notShapes) eq(`not an experience clause: ${text}`, extractExperienceClauses(text).length, 0);
  // The -ing shape also fits a company's own history, so these must stay the
  // company's. Kraken's is in four stored adverts; Reynolds' uses a curly
  // apostrophe, which the straight "we've" cue did not match.
  const history = [
    ['Kraken', 'Payward Services and CF Benchmarks - has spent the last 15 years building one of the most modern financial infrastructure platforms in the industry.'],
    ['Reynolds', 'At Reynolds Food Group, we’ve spent over 80 years sourcing and supplying the freshest ingredients to the UK’s food service industry.'],
  ];
  for (const [label, text] of history) eq(`${label}: a company spending years doing something binds nothing`, binding(text).length, 0);
}

{
  // And the catches the phrase list could never have made, because no entry
  // spelled them: Welcome to the Jungle's metadata line, a slashed pair, and
  // an apostrophe form.
  const caught = [
    ['WTTJ metadata', 'Job summary Permanent contract London Occasional remote Experience: > 5 years Skills & expertise Analytical thinking.', 5],
    ['a slashed pair', 'You have 6/8 years of experience in project management within a scale-up.', 6],
    ["an apostrophe form", "Key Requirements • 8–15 years' experience in biotech, pharma or another regulated environment.", 8],
    ['a two-digit range', 'Job Title: OSS Designer Experience Level: 08-15 Years of relevant experience.', 8],
  ];
  for (const [label, text, expected] of caught) {
    const clauses = binding(text).filter(c => c.minimum >= 5);
    if (clauses.some(c => c.minimum === expected)) pass(`${label} is now read as a minimum of ${expected}`);
    else fail(`${label} read ${JSON.stringify(clauses)}, expected a clause at ${expected}`);
  }
}
