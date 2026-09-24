// tests/ashby-salary-component.test.mjs — the structured salary comes from the Salary component.
//
// Ashby's posting-api keeps minValue, maxValue, currencyCode and interval one
// level down, in compensation.summaryComponents[] and in each
// compensationTiers[].components[], one component per compensationType. The
// top level carries only summary strings, so parseCompensation read nothing
// and every Ashby row had offer.salary null. The Salary component is read
// now, never the equity one; the old top-level shape still parses.
//
// The fixture is the Fyxer AI Growth Product Manager record (£140K – £180K
// salary plus £140K – £180K equity) as the posting-api returned it on
// 23 September 2026 with includeCompensation=true.
import { pass, fail, ROOT } from './helpers.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nAshby — the structured salary comes from the Salary component');

const ashbyModule = await import(pathToFileURL(join(ROOT, 'providers/ashby.mjs')).href);
const ashby = ashbyModule.default;
const { parseCompensation } = ashbyModule;
const { formatCompensation } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'ashby-fyxer-growth-product-manager.json'), 'utf8'));
const JOB = FIXTURE.jobs[0];
const FYXER = { name: 'Fyxer AI', careers_url: 'https://jobs.ashbyhq.com/fyxer' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── The Fyxer record ──
const fyxer = parseCompensation(JOB);
if (same(fyxer, { min: 140000, max: 180000, currency: 'GBP' })) pass('the Fyxer record gives 140000-180000 GBP from the Salary component');
else fail(`parseCompensation(Fyxer) = ${JSON.stringify(fyxer)}`);

const [row] = await ashby.fetch(FYXER, { fetchJson: async () => FIXTURE });
if (same(row?.salary, { min: 140000, max: 180000, currency: 'GBP' })) pass('the provider sets offer.salary on the Fyxer row');
else fail(`provider salary = ${JSON.stringify(row?.salary)}`);
if (formatCompensation(row?.salary) === '140000-180000 GBP') pass('the pipeline cell reads 140000-180000 GBP');
else fail(`formatCompensation = ${JSON.stringify(formatCompensation(row?.salary))}`);

// ── Equity is never read as salary ──
const equityOnly = structuredClone(JOB);
const noSalary = (list) => list.filter((c) => c.compensationType !== 'Salary');
equityOnly.compensation.summaryComponents = noSalary(equityOnly.compensation.summaryComponents);
equityOnly.compensation.compensationTiers.forEach((t) => { t.components = noSalary(t.components); });
if (parseCompensation(equityOnly) === null) pass('a record with only an equity component gives null');
else fail(`equity-only record = ${JSON.stringify(parseCompensation(equityOnly))}`);

const equityFirst = structuredClone(JOB);
equityFirst.compensation.summaryComponents.reverse();
equityFirst.compensation.summaryComponents[0].minValue = 1;
if (same(parseCompensation(equityFirst), { min: 140000, max: 180000, currency: 'GBP' })) pass('an equity component listed first is skipped for the Salary one');
else fail(`equity-first record = ${JSON.stringify(parseCompensation(equityFirst))}`);

// ── Only the tiers carry it ──
const tiersOnly = structuredClone(JOB);
delete tiersOnly.compensation.summaryComponents;
if (same(parseCompensation(tiersOnly), { min: 140000, max: 180000, currency: 'GBP' })) pass('a record without summaryComponents reads the first tier\'s salary');
else fail(`tiers-only record = ${JSON.stringify(parseCompensation(tiersOnly))}`);

// ── Several tiers: the first tier's salary ──
const twoTiers = structuredClone(JOB);
const second = structuredClone(twoTiers.compensation.compensationTiers[0]);
second.components[0].minValue = 200000;
second.components[0].maxValue = 250000;
twoTiers.compensation.compensationTiers.push(second);
twoTiers.compensation.summaryComponents[0].maxValue = 250000;
if (same(parseCompensation(twoTiers), { min: 140000, max: 180000, currency: 'GBP' })) pass('a record with two tiers takes the first tier\'s salary, not the span');
else fail(`two-tier record = ${JSON.stringify(parseCompensation(twoTiers))}`);

// ── The old top-level shape ──
const legacy = parseCompensation({ compensation: { interval: '1 YEAR', minValue: 90000, maxValue: 120000, currency: 'usd' } });
if (same(legacy, { min: 90000, max: 120000, currency: 'USD' })) pass('a record with the old top-level shape still parses');
else fail(`legacy record = ${JSON.stringify(legacy)}`);

const monthly = structuredClone(JOB);
Object.assign(monthly.compensation.summaryComponents[0], { interval: '1 MONTH', minValue: 10000, maxValue: 12000 });
if (same(parseCompensation(monthly), { min: 120000, max: 144000, currency: 'GBP' })) pass('the component\'s own interval is annualized');
else fail(`monthly component = ${JSON.stringify(parseCompensation(monthly))}`);

// ── No compensation ──
if (parseCompensation({ ...JOB, compensation: undefined }) === null) pass('a record with no compensation gives null');
else fail('a record with no compensation gave a salary');
const stringsOnly = { compensation: { compensationTierSummary: JOB.compensation.compensationTierSummary, scrapeableCompensationSalarySummary: '£140K - £180K' } };
if (parseCompensation(stringsOnly) === null) pass('a record with only the summary strings gives null');
else fail(`summary-strings-only record = ${JSON.stringify(parseCompensation(stringsOnly))}`);
