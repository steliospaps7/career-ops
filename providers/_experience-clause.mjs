/**
 * providers/_experience-clause.mjs — what an advert says about years.
 *
 * Ticket C, C1. The scanner used to match years phrases as substrings, and the
 * 11 September audit (F01, A01 to A04) showed what that costs: "5+ years is
 * preferred, not required" was rejected, "we have served customers for
 * 5+ years" was rejected, "5 years" and "5 to 7 years" were kept, and Super
 * Payments' Product Manager was dropped on the substring "5+ years" while its
 * advert reads "3–5+ years … does not preclude applications from candidates
 * with less". A list of phrases cannot tell a requirement from a wish, or the
 * employer's age from the reader's career.
 *
 * So this module reads instead of matching. It is pure: text in, clauses out,
 * no configuration, no file, no network, no clock. The policy — which minimum
 * is out, which is a long shot — is not here; it is the gate's, in `scan.mjs`,
 * from the 12 September decision table in
 * `projects/career/General Role Criteria v1.md`.
 *
 * A clause is `{ minimum, mandatory, subject, sentence }`:
 *
 *   minimum    the lower bound, in years. "3 to 5+ years" is a three.
 *   mandatory  true on "must", "required", "at least", "minimum", "need",
 *              "essential"; false on "preferred", "ideally", "nice to have",
 *              "bonus", "we'd love it if", "would be a plus", and on a later
 *              sentence saying less experience does not preclude; null when the
 *              advert says neither, which is the ordinary requirements-list
 *              shape and which the gate treats as a bar.
 *   subject    `company` when the sentence is about the employer or the product,
 *              `candidate` when it is about the reader, `unknown` otherwise.
 *   sentence   the advert's own words, so a cut can be quoted back.
 *
 * There is deliberately no `maximum`: the gate never reads one, and a field
 * nothing reads is a field that drifts.
 */

/** Digits or the words one to ten. Past ten an advert writes the number. */
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const NUMBER = `(?:\\d{1,2}|${Object.keys(NUMBER_WORDS).join('|')})`;

/** The hyphen, the en dash, the em dash, the slash and the word, all of them
 * ranges — Pivot's real advert reads "6/8 years of experience".
 * "up to" is absent on purpose: "up to 5 years" is a ceiling, and this module
 * reads lower bounds only. */
const RANGE = '(?:-|–|—|/|to)';

/** "5 or more years" puts its filler between the number and the word. It says
 * nothing the lower bound does not already say, so it is skipped rather than
 * read. */
const OR_MORE = '(?:\\s*or\\s+(?:more|above|greater|over))?';

/**
 * One years phrase: a number, an optional "+", an optional range to a second
 * number, then "year", "years", "yr" or "yrs", and an optional trailing "+"
 * for the "5 years+" form. "or more" and "more than" need no pattern of their
 * own — they change nothing about the lower bound this reads.
 *
 * The leading `\b` stops the number starting inside a word or a longer number:
 * without it "everyone years of experience" read a minimum of one, from the
 * "one" in "everyone", and "founded in 1995 years of experience" read
 * ninety-five and dropped the row.
 */
const CLAUSE_RE = new RegExp(
  `\\b(${NUMBER})\\s*\\+?\\s*(?:${RANGE}\\s*(?:${NUMBER})\\s*\\+?\\s*)?${OR_MORE}\\s*(?:years?|yrs?)\\b\\s*\\+?`,
  'gi',
);

/**
 * A years number only counts when the sentence is about experience. Without
 * this the Greenhouse disability form costs a row: Super Payments' own page
 * carries "People can become disabled, so we need to ask this question at least
 * every five years", which has "at least", "need" and "five years" in it and
 * nothing whatever to do with the job.
 */
const EXPERIENCE_RE = /experien|background|track record|in a similar role|tenure|seniority/i;

/**
 * The other half of the same test, for the shape that names the domain instead
 * of the word: "5+ years in revenue operations", "5 years as a product
 * manager". Cresta's real advert reads "Qualifications 5+ years in revenue
 * operations, sales operations, GTM strategy" with no "experience" anywhere
 * near it, and the first build kept the row — a false keep the phrase list it
 * replaced did not have. Anchored at the match, so it reads what directly
 * follows the number and not the rest of the page: "at least every five years.
 * Completing this form…" does not qualify, and neither does "growing 4x YOY
 * for 5 years."
 *
 * "of" is deliberately absent. It is how an advert states its own age — "Build
 * on 50+ Years of Success", "Building on 21 years of continuous growth", "over
 * 60 years of attitude and heritage" — and admitting it dropped three real
 * stored adverts on the employer's history, which is the very thing finding A04
 * is about. "5 years of experience" still reads, through the word cue above.
 *
 * Three more shapes, since relevance reads only the clause's own sentence and
 * a bar can no longer borrow "experience" from a neighbour. Each is from a
 * stored advert that lost its bar without it: "5+ years in a senior management
 * role" and "5+ years as a Programme Manager" (an article, but not "in a row"),
 * "Five or more years driving product" and "8+ years shipping complex
 * software" (a verb in -ing, but not "5 years running"), and "6-10 years post
 * undergrad".
 */
const DOMAIN_RE = /^\s*(?:(?:in|within|as|working)\s+(?!the\b|a\b|an\b|this\b|that\b|these\b|our\b|their\b|its\b|last\b|past\b|recent\b|order\b)[a-z]|(?:in|as)\s+an?\s+(?!row\b)[a-z]|(?!running\b)[a-z]+ing\b|post[\s-]+[a-z])/i;

/**
 * Sentences that carry a years number and are plainly not about the reader's
 * experience, whatever else is near them. All four shapes are from real stored
 * adverts: Gopuff's "Must be 18 years old", SuperAwesome's "30 day sabbatical
 * for employees who have reached 7 years tenure", the UK Health Security
 * Agency's "resident in the United Kingdom for the last 5 years", and Zava's
 * "Gift vouchers after 3, 5, 10 years". Each was dropped by the first build,
 * and each is a role the old phrase list kept — so a wrong cut here is a
 * regression, and an invisible one.
 */
const NOT_EXPERIENCE_RE = /\byears?\s+(?:old\b|or older\b|of age\b)|sabbatical|\btenure\b|\bresident\b|gift voucher|anniversary|long.service/i;

/** Windows, in characters, either side of the phrase. Bounded so one enormous
 * bullet block does not read as one sentence. A stored advert really is one
 * line: the bullets carry no full stops. */
const WINDOW_BEFORE = 110;
const WINDOW_AFTER = 130;

/** A sentence ends at a full stop, a question mark, an exclamation mark or a
 * semicolon. A statement ignores the semicolon. The cues and the exclusion
 * read the sentence, because a preference in one half of a semicolon does not
 * answer for the other. Relevance reads the statement, because the audit's own
 * T12 is "You need two years of experience; 5+ years is preferred, not
 * required", and the second half carries the bar without carrying the word. */
const SENTENCE_END = /[.!?;]/;
const STATEMENT_END = /[.!?]/;

/** The quoted sentence is read by a person on a DROP line, so it is capped. */
const SENTENCE_CAP = 240;

/**
 * How close a cue has to sit to the number before it is read as describing it.
 *
 * Cresta's real advert reads "Qualifications 5+ years in revenue operations,
 * sales operations, GTM strategy, management consulting, or corporate strategy,
 * ideally supporting a B2B SaaS company". The "ideally" is about the company
 * being B2B, not about the five years, and without this cap it withdrew a bar
 * the advert plainly states. A cue further away than this is ignored, which
 * leaves `mandatory` null — and null binds, so the safe direction.
 */
const CUE_REACH = 70;

/**
 * How far *after* the clause a preference word is still read as describing it.
 *
 * A preference before the clause governs it: "Preferred Qualifications - 7+
 * years", "We'd love it if you have 3–5+ years", "Nice to have: 6+ years".
 * After the clause and past a comma it almost always modifies what follows
 * instead — Frontify's "5+ years of experience in software product management,
 * ideally working with…" and LSEG's "5+ years' experience in product
 * management, preferably in an Agile/SAFe environment" are both plain bars, and
 * reading them as wishes kept two roles the old phrase list cut. The forms that
 * really do trail the number sit right against it: "5+ years is preferred, not
 * required", "5+ years of experience would be a plus".
 */
const TRAILING_WISH_REACH = 25;

/**
 * A wish that is the last word of the clause's sentence governs the years,
 * however far from the number it sits. Hogan Lovells' "7+ years of relevant
 * experience within legal / professional services preferred." ends on the
 * wish, so nothing follows for it to describe. A wish that carries on ("ideally
 * in SaaS", Cresta's "ideally supporting a B2B SaaS company") keeps the reach
 * above. Only a real sentence end counts, never the window's edge.
 */
const ENDING_WISH_RE = /\b(?:preferred|desirable|nice[\s-]to[\s-]have)[^a-z0-9]*$/;

const MANDATORY_CUES = [
  'must have', 'must', 'required', 'requires', 'require', 'requirement',
  'at least', 'minimum', 'a minimum of', 'need', 'needs', 'essential',
  'proven', 'demonstrable',
];

const PREFERENCE_CUES = [
  'preferred', 'preferable', 'preferably', 'ideally', 'nice to have',
  'nice-to-have', 'bonus', "we'd love it if", 'we would love it if',
  'would be a plus', 'is a plus', 'desirable', 'not required', 'not essential',
  'not a must', 'advantageous',
];

/** A sentence withdrawing the bar outright, which is Super Payments' footnote
 * and is common in UK adverts. */
const NOT_PRECLUDE_RE = /does not preclude|do not preclude|not preclude applications|less experience (?:is|are) (?:fine|welcome)/i;

const CANDIDATE_CUES = [
  'you', 'your', "you'll", "you're", 'the candidate', 'candidates',
  'applicants', 'the successful candidate', 'the ideal candidate',
  'the right person', 'we are looking for someone', 'looking for someone',
];

const COMPANY_CUES = [
  'we have', "we've", 'we had', 'our platform has', 'our product has',
  'our company has', 'our team has', 'the company has', 'we serve',
  'we have served', 'founded', 'we were established',
  'has been trading',
  // The shapes a company uses for its own age with no pronoun in front of it,
  // each from a real stored advert that the first build cut: Indra's "Drawing
  // on over 30 years of experience in urban public transport", Clear Drains'
  // "built its reputation over 50+ years", TAIT's "legacy of innovation
  // spanning over 45 years", the IRC's "Over the past 90 years", Monzo's "our
  // product offering has grown a lot in the last 10 years", and Paloma's "their
  // 25 years of combined NHS experience", which is the founders' and not his.
  'legacy of', 'spanning', 'over the past', 'drawing on', 'built its reputation',
  'our partner has', 'has grown', 'combined', 'was established', 'has been operating',
  // "Our client is a highly respected bespoke joinery specialist with more than
  // 30 years of experience delivering…" — an agency describing the employer.
  'our client',
  // Spelled out rather than a bare "in business": Navan's real advert says
  // "5+ years experience in business operations", and the short form read that
  // requirement as the employer's own age and would have kept the row.
  'been in business', 'in business for', 'in business since',
  // A company spending its years doing something, which the -ing shape in
  // DOMAIN_RE would otherwise read as a bar: Kraken's "has spent the last 15
  // years building" and Reynolds' "we’ve spent over 80 years sourcing", whose
  // curly apostrophe the straight "we've" above does not match. "has spent"
  // and not "spent": "You've spent 2 to 3 years" is the reader.
  'has spent', 'we’ve',
];

function toNumber(token) {
  const word = token.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, word)) return NUMBER_WORDS[word];
  const n = Number.parseInt(word, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every occurrence of every cue, with where it sits. Word-bounded on the short
 * ones ("you", "need") so "your" does not answer for "you" and "engineer" does
 * not answer for "need"; plain substring on the phrases, where a boundary adds
 * nothing and an apostrophe form would break it.
 */
function cueHits(haystack, cues) {
  const hits = [];
  for (const cue of cues) {
    const needsBoundary = !cue.includes(' ') && !cue.includes("'");
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(cue, from);
      if (at === -1) break;
      from = at + 1;
      if (needsBoundary) {
        const before = at === 0 ? '' : haystack[at - 1];
        const after = haystack[at + cue.length] || '';
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      }
      hits.push({ cue, at });
    }
  }
  return hits;
}

/** The nearest cue to the phrase wins, and only if it is within reach. A
 * sentence carrying both a bar and a wish ("5+ years required, and we'd love it
 * if you also …") means whichever word sits next to the number. */
function nearest(hits, at, end = at, trailingReach = CUE_REACH) {
  let best = null;
  for (const hit of hits) {
    // Measured from whichever edge of the clause the cue sits beyond, so the
    // reach means the same thing for "5+ years" and "at least five years".
    const trailing = hit.at > end;
    const distance = trailing ? hit.at - end : Math.abs(hit.at - at);
    if (distance > (trailing ? trailingReach : CUE_REACH)) continue;
    if (!best || distance < best.distance) best = { ...hit, distance };
  }
  return best;
}

/** A true cue preceded by a negation is a preference: "not required" is the
 * form the audit's own T12 uses. */
function isNegated(haystack, at) {
  const before = haystack.slice(Math.max(0, at - 8), at);
  return /\b(?:not|never|n't)\s+$/.test(before);
}

function readMandatory(window, at, end) {
  const bars = cueHits(window, MANDATORY_CUES)
    .map(hit => ({ ...hit, value: isNegated(window, hit.at) ? false : true }));
  const wishes = cueHits(window, PREFERENCE_CUES).map(hit => ({ ...hit, value: false }));
  // A tie goes to the preference: the cost of reading a wish as a bar is a role
  // he never sees, and the cost the other way is one row he reads and discards.
  const wish = nearest([...bars, ...wishes].filter(h => h.value === false), at, end, TRAILING_WISH_REACH);
  const bar = nearest(bars.filter(h => h.value === true), at, end);
  // Neither word within reach: the advert has not said, and the gate reads an
  // unstated bar as a bar. A plain requirements list is the common shape.
  if (!wish && !bar) return null;
  if (wish && bar) return wish.distance <= bar.distance ? false : true;
  return wish ? false : true;
}

function readSubject(window, at, end) {
  const candidate = nearest(cueHits(window, CANDIDATE_CUES), at, end);
  const company = nearest(cueHits(window, COMPANY_CUES), at, end);
  if (candidate && company) return candidate.distance <= company.distance ? 'candidate' : 'company';
  if (candidate) return 'candidate';
  if (company) return 'company';
  return 'unknown';
}

/**
 * The advert's own words around the clause, for the DROP line.
 *
 * Clipped to the clause's sentence, then to the window, then to the cap, and
 * marked with an ellipsis on whichever side was actually cut — a sentence that
 * fits is quoted whole, with no ellipsis at all. The clause itself is always
 * inside what comes back: a cut needs its sentence quoted, and a quote that
 * had lost the number would prove nothing.
 */
function quote(text, bounds, matchStart, matchEnd) {
  let from = Math.max(bounds.start, matchStart - WINDOW_BEFORE);
  let to = Math.min(bounds.end, matchEnd + WINDOW_AFTER);
  if (to - from > SENTENCE_CAP) {
    const slack = Math.max(0, SENTENCE_CAP - (matchEnd - matchStart));
    from = Math.max(from, matchStart - Math.floor(slack * 0.45));
    to = Math.min(to, from + SENTENCE_CAP);
  }
  // A scan that stopped at the window's edge cut the sentence there, even
  // though `from` sits exactly on that edge.
  const cutBefore = from > bounds.start || bounds.clippedStart;
  const cutAfter = to < bounds.end || bounds.clippedEnd;
  // Snap inwards to a word boundary so the quote never starts or ends mid-word.
  if (cutBefore) {
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < matchStart) from = space + 1;
  }
  if (cutAfter) {
    const space = text.lastIndexOf(' ', to);
    if (space > matchEnd) to = space;
  }
  let quoted = text.slice(from, to).trim();
  if (cutBefore) quoted = `\u2026${quoted}`;
  if (cutAfter) quoted = `${quoted}\u2026`;
  return quoted;
}

/** Sentence boundaries in the collapsed text: a full stop, a question mark, an
 * exclamation mark or a semicolon followed by a space. A bullet block has none
 * of these, which is why the window above exists as well.
 *
 * The scan goes no further than `floor` and `ceiling`. Unbounded, it ran to
 * both ends of a punctuation-free advert once per clause, so the time grew with
 * the square of the length: 915 seconds on the build review's 152 KB advert.
 * Every caller clips to the window anyway, so the scan stops there too, and
 * `clippedStart` / `clippedEnd` say an edge is the window's and not a real
 * boundary. */
function sentenceBounds(text, at, floor = 0, ceiling = text.length, ends = SENTENCE_END) {
  let start = floor;
  let clippedStart = floor > 0;
  for (let i = at; i > 0 && i >= floor; i--) {
    if (ends.test(text[i - 1]) && (i >= text.length || /\s/.test(text[i]))) {
      start = i;
      clippedStart = false;
      break;
    }
  }
  let end = ceiling;
  let clippedEnd = ceiling < text.length;
  for (let i = at; i < ceiling; i++) {
    if (ends.test(text[i]) && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      end = i + 1;
      clippedEnd = false;
      break;
    }
  }
  return { start, end, clippedStart, clippedEnd };
}

/**
 * Every experience clause the text carries, in the order the advert writes them.
 *
 * @param {string} text - the advert, as stored. Anything else yields `[]`.
 * @returns {Array<{minimum: number, mandatory: (boolean|null), subject: string, sentence: string}>}
 */
export function extractExperienceClauses(text) {
  if (typeof text !== 'string') return [];
  // One line: the stored file's newlines and tabs are layout, not meaning, and
  // collapsing them first keeps every offset below in one coordinate system.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const lower = flat.toLowerCase();

  // A withdrawal applies to the clauses before it and to its own sentence, so
  // the earliest one is the only position that matters. Its sentence's end is
  // found once, unclipped, so a withdrawal further back than the window in the
  // same unpunctuated block still reaches the clause.
  const withdrawal = lower.search(NOT_PRECLUDE_RE);
  const withdrawalEnd = withdrawal === -1 ? -1 : sentenceBounds(flat, withdrawal).end;

  const clauses = [];
  const re = new RegExp(CLAUSE_RE.source, CLAUSE_RE.flags);
  for (let m = re.exec(flat); m; m = re.exec(flat)) {
    const minimum = toNumber(m[1]);
    if (minimum == null) continue;

    // Everything below reads the clause's own sentence, never the text around
    // it: a window that crossed a full stop let 9fin's sabbatical line suppress
    // a real bar beside it, and let a company's growth figure borrow
    // "experience" from the next sentence.
    const floor = Math.max(0, m.index - WINDOW_BEFORE);
    const ceiling = Math.min(flat.length, m.index + m[0].length + WINDOW_AFTER);
    const bounds = sentenceBounds(flat, m.index, floor, ceiling);
    const from = Math.max(bounds.start, m.index - WINDOW_BEFORE);
    const to = Math.min(bounds.end, m.index + m[0].length + WINDOW_AFTER);
    const window = lower.slice(from, to);

    // Is this a years number about experience at all?
    const statement = sentenceBounds(flat, m.index, floor, ceiling, STATEMENT_END);
    const relevant = lower.slice(statement.start, statement.end);
    const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (!EXPERIENCE_RE.test(relevant) && !DOMAIN_RE.test(after)) continue;
    if (NOT_EXPERIENCE_RE.test(window)) continue;

    const at = m.index - from;
    const end = at + m[0].trimEnd().length;
    let mandatory = readMandatory(window, at, end);
    if (!bounds.clippedEnd && ENDING_WISH_RE.test(lower.slice(m.index + m[0].length, bounds.end))) mandatory = false;
    // The clause's sentence starts at or before the withdrawal exactly when no
    // sentence ends between the two.
    if (withdrawal !== -1 && m.index < withdrawalEnd) mandatory = false;

    clauses.push({
      minimum,
      mandatory,
      subject: readSubject(window, at, end),
      sentence: quote(flat, bounds, m.index, m.index + m[0].length),
    });
  }
  return clauses;
}
