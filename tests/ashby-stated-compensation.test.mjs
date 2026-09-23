// tests/ashby-stated-compensation.test.mjs — a band the board states reaches the advert text.
//
// Ashby keeps a posting's pay band in its compensation field, outside the
// description, so the fit gate never saw it: Fyxer AI's Growth Product Manager
// (tracker row 210) states £140K - £180K on the board and nowhere in the
// advert. The band now rides as the advert's last line,
// `Compensation (stated on the job board): <band>`, both in the scan's Ashby
// provider and in the advert reader's Ashby feed rung, so the pay rules can
// quote a written sentence.
//
// The fixture is the Fyxer record as the posting-api returned it on
// 23 September 2026 with includeCompensation=true.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nAshby — the stated pay band reaches the advert text');

const ashbyModule = await import(pathToFileURL(join(ROOT, 'providers/ashby.mjs')).href);
const ashby = ashbyModule.default;
const { statedCompensationLine } = ashbyModule;
const { extractFeedDescription } = await import(pathToFileURL(join(ROOT, 'providers/_advert-reader.mjs')).href);
const { parseFitAnswer } = await import(pathToFileURL(join(ROOT, 'providers/_fit-prompt.mjs')).href);

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'ashby-fyxer-growth-product-manager.json'), 'utf8'));
const JOB = FIXTURE.jobs[0];
const LINE = 'Compensation (stated on the job board): £140K - £180K';
const FYXER = { name: 'Fyxer AI', careers_url: 'https://jobs.ashbyhq.com/fyxer', api: 'https://api.ashbyhq.com/posting-api/job-board/fyxer' };

/** One job's copy with some fields changed, the fixture left untouched. */
const variant = (changes) => ({ jobs: [{ ...structuredClone(JOB), ...changes }] });
const lastLine = (text) => String(text).trimEnd().split('\n').pop();

// ── The line itself ──
if (statedCompensationLine(JOB) === LINE) pass('the Fyxer record gives the line with the salary band only');
else fail(`statedCompensationLine(Fyxer) = ${JSON.stringify(statedCompensationLine(JOB))}`);

// ── The scan's provider ──
let requested = null;
const rows = await ashby.fetch(FYXER, { fetchJson: async (url) => { requested = url; return FIXTURE; } });
const row = rows[0];
if (requested === 'https://api.ashbyhq.com/posting-api/job-board/fyxer?includeCompensation=true') {
  pass('a pinned api: without includeCompensation is asked with it, so the band is in the payload');
} else {
  fail(`the pinned Fyxer api: was requested as ${JSON.stringify(requested)}`);
}
if (lastLine(row?.description) === LINE) pass('the provider ends the Fyxer advert with the stated band line');
else fail(`provider advert ends ${JSON.stringify(lastLine(row?.description))}`);
if (row?.description.startsWith(JOB.descriptionPlain.trimEnd())) pass('the provider keeps the advert text whole before the line');
else fail('the provider changed the advert text before the line');

const [bare] = await ashby.fetch(FYXER, { fetchJson: async () => variant({ compensation: undefined }) });
if (bare?.description === JOB.descriptionPlain) pass('no compensation field: the advert is unchanged');
else fail('an advert without a compensation field was changed');

const [hidden] = await ashby.fetch(FYXER, { fetchJson: async () => variant({ shouldDisplayCompensationOnJobPostings: false }) });
if (hidden?.description === JOB.descriptionPlain) pass('a band the employer hides from the posting page is not added');
else fail('a hidden band was added to the advert');

const noSalary = structuredClone(JOB.compensation);
delete noSalary.scrapeableCompensationSalarySummary;
const [equityOnly] = await ashby.fetch(FYXER, { fetchJson: async () => variant({ compensation: noSalary }) });
if (equityOnly?.description === JOB.descriptionPlain) pass('a compensation field with no salary band adds nothing');
else fail('a compensation field with no salary band changed the advert');

const [empty] = await ashby.fetch(FYXER, { fetchJson: async () => variant({ descriptionPlain: '' }) });
if (empty?.description === '') pass('an empty advert stays empty, so the row still goes to the advert reader');
else fail(`an empty advert became ${JSON.stringify(empty?.description)}`);

// ── The advert reader's feed rung ──
const fed = extractFeedDescription('ashby', FIXTURE, JOB.id);
if (lastLine(fed) === LINE) pass('the advert reader ends the Fyxer feed text with the stated band line');
else fail(`feed text ends ${JSON.stringify(lastLine(fed))}`);
const fedBare = extractFeedDescription('ashby', variant({ compensation: undefined }), JOB.id);
if (!fedBare.includes('Compensation (stated on the job board)')) pass('the advert reader adds nothing when the board states no band');
else fail('the advert reader added a band line the board does not state');

// ── The gate can quote it ──
const answer = JSON.stringify({ verdict: 'SKIP', reason: 'The stated band reads senior.', excerpt: LINE });
const parsed = parseFitAnswer(answer, row?.description);
if (parsed.ok && parsed.excerptFound) pass('a judge quoting the band line passes the gate\'s excerpt check');
else fail(`parseFitAnswer on the band line: ${JSON.stringify(parsed)}`);
