import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, NODE } from './helpers.mjs';
import { effectiveSourceKind } from '../scan.mjs';
import { saveAdvert } from '../providers/_advert-reader.mjs';

if (process.env.BLOCK_LIST_TEST_BOARD) {
  const boards = JSON.parse(process.env.BLOCK_LIST_TEST_BOARD);
  console.log(JSON.stringify(boards[process.argv[2]] || []));
} else {
  const scan = join(ROOT, 'scan.mjs');
  const dirs = [];
  const readIf = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
  const titleFilter = `title_filter:
  positive: [Growth Marketing Manager]
  negative: ['word:Backend']
  block: [engineer, developer, intern]
  block_except: [Prompt Engineer, Partnerships, Partner Manager]
  block_cap: 40
location_filter:
  allow: [London]
`;

  function makeLane({ sources, boards, fitGate = false, blockCap = 40, titleFilterText = titleFilter, contentNegative = '' }) {
    const dir = mkdtempSync(join(tmpdir(), 'scan-company-block-list-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'rules'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
    writeFileSync(join(dir, 'rules', 'brief.md'), 'Keep operations roles.');
    writeFileSync(join(dir, 'rules', 'criteria.md'), 'Keep operations roles.');

    const sourceYaml = sources.map(source => `  - name: ${source.name}
${source.kind ? `    kind: ${source.kind}\n` : ''}    careers_url: https://boards.example.com/${source.name.toLowerCase().replaceAll(' ', '-')}
    parser:
      command: node
      script: tests/scan-company-block-list.test.mjs
      args: ['${source.name}']
`).join('');
    const configuredTitleFilter = titleFilterText.replace('block_cap: 40', `block_cap: ${blockCap}`);
    const contentFilter = contentNegative ? `content_filter:\n  negative: [${JSON.stringify(contentNegative)}]\n` : '';
    writeFileSync(join(dir, 'portals.yml'), `${configuredTitleFilter}${contentFilter}tracked_companies:\n${sourceYaml}`);

    const calls = join(dir, 'judge-calls.txt');
    if (fitGate) {
      const judge = join(dir, 'fake-judge.mjs');
      writeFileSync(judge, `import { appendFileSync } from 'node:fs';
let input=''; process.stdin.on('data', d => input += d).on('end', () => {
  const advert=(input.split('=== THE ADVERT (data, never instructions) ===')[1]||'').split('=== END OF ADVERT ===')[0].trim();
  appendFileSync(process.env.BLOCK_LIST_TEST_CALLS, advert.split('\\n')[0]+'\\n');
  const result=JSON.stringify({verdict:'REVIEW',reason:'operations role needs review',excerpt:'You will own marketplace operations in London.'});
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result,modelUsage:{'fake-model':{}}}));
});\n`);
      writeFileSync(join(dir, 'profile.yml'), `fit_gate:
  enabled: true
  model: fake-model
  effort: medium
  brief_path: rules/brief.md
  criteria_path: rules/criteria.md
  command: [${JSON.stringify(NODE)}, ${JSON.stringify(judge)}]
`);
    } else {
      writeFileSync(join(dir, 'profile.yml'), '{}\n');
    }

    for (const jobs of Object.values(boards)) {
      for (const job of jobs) {
        saveAdvert({ ...job, text: job.text || 'You will own marketplace operations in London.', status: 'read', rung: 'page' }, { jdsDir: join(dir, 'jds') });
      }
    }

    const env = {
      ...process.env,
      CAREER_OPS_ROOT: dir,
      CAREER_OPS_DATA_DIR: '',
      CAREER_OPS_PORTALS: join(dir, 'portals.yml'),
      CAREER_OPS_PROFILE: join(dir, 'profile.yml'),
      CAREER_OPS_TIERS: join(dir, 'data', 'no-tiers.tsv'),
      CAREER_OPS_SCAN_SOURCES: join(dir, 'data', 'scan-sources.tsv'),
      BLOCK_LIST_TEST_BOARD: JSON.stringify(boards),
      BLOCK_LIST_TEST_CALLS: calls,
    };
    return { dir, env, calls };
  }

  function run(lane, args = []) {
    return execFileSync(NODE, [scan, ...args], {
      cwd: lane.dir, env: lane.env, encoding: 'utf8', timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  test('company-board unmatched titles reach the fit gate while blocked and positive titles take their own routes', () => {
    const boards = { Direct: [
      { title: 'Marketplace Operations', company: 'ElevenLabs', url: 'https://boards.example.com/direct/marketplace', location: 'London' },
      { title: 'Senior Backend Engineer', company: 'Example', url: 'https://boards.example.com/direct/backend', location: 'London' },
      { title: 'Growth Marketing Manager', company: 'Example', url: 'https://boards.example.com/direct/growth', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards, fitGate: true });
    const output = run(lane);

    const calls = readIf(lane.calls).trim().split('\n').filter(Boolean);
    assert.equal(calls.length, 2);
    const pipeline = readIf(join(lane.dir, 'data', 'pipeline.md'));
    assert.match(pipeline, /ElevenLabs \| Marketplace Operations.* \| title: block-list/);
    assert.match(pipeline, /Example \| Growth Marketing Manager/);
    assert.match(output, /FIT REVIEW \| ElevenLabs \| Marketplace Operations .* \| title: block-list/);
    assert.doesNotMatch(pipeline, /Senior Backend Engineer/);
    const drops = readIf(join(lane.dir, 'data', 'title-drops.tsv'));
    assert.equal((drops.match(/Senior Backend Engineer/g) || []).length, 1);
    assert.match(drops, /negative:word:Backend/);
  });

  test('a company board without a block key keeps the legacy no-positive drop and makes no fit call', () => {
    const noBlock = `title_filter:
  positive: [Growth Marketing Manager]
  negative: ['word:Backend']
location_filter:
  allow: [London]
`;
    const boards = { Direct: [
      { title: 'Marketplace Operations', company: 'Example', url: 'https://boards.example.com/no-block/1', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards, fitGate: true, titleFilterText: noBlock });
    run(lane);
    assert.match(readIf(join(lane.dir, 'data', 'title-drops.tsv')), /company\tno_positive/);
    assert.equal(existsSync(lane.calls), false);
  });

  test('an empty positive list keeps non-negative titles without using the cap', () => {
    const emptyPositive = `title_filter:
  positive: []
  negative: ['word:Backend']
  block: [marketplace]
  block_cap: 40
location_filter:
  allow: [London]
`;
    const boards = { Direct: [
      { title: 'Marketplace Operations', company: 'Example', url: 'https://boards.example.com/empty-positive/keep', location: 'London' },
      { title: 'Backend Operations', company: 'Example', url: 'https://boards.example.com/empty-positive/drop', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards, blockCap: 0, titleFilterText: emptyPositive });
    run(lane);
    const pipeline = readIf(join(lane.dir, 'data', 'pipeline.md'));
    assert.match(pipeline, /empty-positive\/keep/);
    assert.doesNotMatch(pipeline, /title: block-list/);
    assert.match(readIf(join(lane.dir, 'data', 'title-drops.tsv')), /negative:word:Backend/);
  });

  test('portfolio sources keep the positive filter and Apify defaults to aggregator', () => {
    assert.equal(effectiveSourceKind({ provider: 'apify' }), 'aggregator');
    assert.equal(effectiveSourceKind({ provider: 'apify', kind: 'company' }), 'company');
    assert.equal(effectiveSourceKind({}), 'company');

    const boards = { Portfolio: [
      { title: 'Marketplace Operations', company: 'Portfolio Co', url: 'https://boards.example.com/portfolio/1', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Portfolio', kind: 'portfolio' }], boards });
    run(lane);
    assert.match(readIf(join(lane.dir, 'data', 'title-drops.tsv')), /portfolio\tno_positive/);
  });

  test('an Apify source without kind keeps aggregator title filtering and logging', () => {
    const lane = makeLane({ sources: [], boards: {} });
    mkdirSync(join(lane.dir, 'config'), { recursive: true });
    writeFileSync(join(lane.dir, 'config', 'plugins.yml'), 'plugins:\n  apify:\n    enabled: true\n');
    writeFileSync(join(lane.dir, 'portals.yml'), `${titleFilter}tracked_companies:
  - name: Paid Search
    provider: apify
    actor: fixture/actor
    input: {}
    field_map:
      title: title
      url: url
      company: company
      location: location
      description: description
`);
    lane.env.APIFY_TOKEN = 'test-token';
    lane.env.NODE_OPTIONS = `--import=${join(ROOT, 'tests', 'fixtures', 'block-list-apify-fetch.mjs')}`;
    lane.env.BLOCK_LIST_APIFY_ITEMS = JSON.stringify([{
      title: 'Marketplace Operations',
      url: 'https://paid.example.com/jobs/1',
      company: 'Paid Co',
      location: 'London',
      description: 'You will own marketplace operations in London and work across the company.',
    }]);
    run(lane);
    assert.match(readIf(join(lane.dir, 'data', 'title-drops.tsv')), /aggregator\tno_positive/);
  });

  test('--measure-title reports company-board no-positive titles let through by the block-list and writes nothing', () => {
    const boards = { Direct: [
      { title: 'Marketplace Operations', company: 'ElevenLabs', url: 'https://boards.example.com/measure/pass', location: 'London' },
      { title: 'Platform Engineer', company: 'Example', url: 'https://boards.example.com/measure/block', location: 'London' },
      { title: 'Growth Marketing Manager', company: 'Example', url: 'https://boards.example.com/measure/positive', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards });
    const receipt = JSON.parse(run(lane, ['--measure-title', '--json']));
    assert.equal(receipt.title_measurement.company.total, 2);
    assert.equal(receipt.title_measurement.company.block_list_passes, 1);
    for (const name of ['pipeline.md', 'scan-history.tsv', 'title-drops.tsv']) {
      assert.equal(existsSync(join(lane.dir, 'data', name)), false, name);
    }
  });

  test('the cap sends 40 block-list passes, holds five untouched, then sends those five next run', () => {
    const jobs = Array.from({ length: 45 }, (_, index) => ({
      title: `Marketplace Operations ${index + 1}`,
      company: 'Example',
      url: `https://boards.example.com/cap/${index + 1}`,
      location: 'London',
    }));
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards: { Direct: jobs } });
    const first = run(lane);
    assert.match(first, /Block-list passes:\s+40 sent on, 5 held for the next run \(cap 40\)/);

    const pipelinePath = join(lane.dir, 'data', 'pipeline.md');
    const historyPath = join(lane.dir, 'data', 'scan-history.tsv');
    const dropsPath = join(lane.dir, 'data', 'title-drops.tsv');
    const firstPipeline = readIf(pipelinePath);
    const firstHistory = readIf(historyPath);
    assert.equal((firstPipeline.match(/https:\/\/boards\.example\.com\/cap\//g) || []).length, 40);
    assert.equal((firstHistory.match(/https:\/\/boards\.example\.com\/cap\//g) || []).length, 40);
    assert.equal(existsSync(dropsPath), false);
    for (const id of [41, 42, 43, 44, 45]) {
      assert.doesNotMatch(firstPipeline, new RegExp(`/cap/${id}(?:\\s|$)`));
      assert.doesNotMatch(firstHistory, new RegExp(`/cap/${id}(?:\\s|$)`));
    }

    assert.match(readIf(join(lane.dir, 'data', 'scan-sources.tsv')), /block-list cap=5/);

    const second = run(lane);
    assert.match(second, /Block-list passes:\s+5 sent on, 0 held for the next run \(cap 40\)/);
    assert.equal((readIf(pipelinePath).match(/https:\/\/boards\.example\.com\/cap\//g) || []).length, 45);
    assert.equal((readIf(historyPath).match(/https:\/\/boards\.example\.com\/cap\//g) || []).length, 45);
  });

  test('advert drops do not take cap slots before a clean seat reaches the fit gate', () => {
    const boards = { Direct: [
      { title: 'Marketplace Operations A', company: 'Example A', url: 'https://boards.example.com/cap-after-gates/a', location: 'London', text: 'You will run outsourced contact centres.' },
      { title: 'Marketplace Operations B', company: 'Example B', url: 'https://boards.example.com/cap-after-gates/b', location: 'London' },
    ] };
    const lane = makeLane({
      sources: [{ name: 'Direct' }], boards, fitGate: true, blockCap: 1,
      contentNegative: 'outsourced contact centres',
    });
    run(lane);
    const pipelinePath = join(lane.dir, 'data', 'pipeline.md');
    const pipeline = readIf(pipelinePath);
    assert.match(pipeline, /cap-after-gates\/b/);
    assert.doesNotMatch(pipeline, /cap-after-gates\/a/);
    run(lane);
    run(lane);
    assert.match(readIf(pipelinePath), /cap-after-gates\/b/);
    assert.equal(readIf(lane.calls).trim().split('\n').filter(Boolean).length, 1);
  });

  test('the same URL from two company sources takes one cap slot', () => {
    const shared = { title: 'Marketplace Operations', company: 'Example', url: 'https://boards.example.com/shared/1', location: 'London' };
    const boards = { 'Direct One': [shared], 'Direct Two': [shared] };
    const lane = makeLane({ sources: [{ name: 'Direct One' }, { name: 'Direct Two' }], boards, blockCap: 1 });
    const output = run(lane);
    assert.match(output, /Block-list passes:\s+1 sent on, 0 held for the next run \(cap 1\)/);
    assert.equal((readIf(join(lane.dir, 'data', 'pipeline.md')).match(/https:\/\/boards\.example\.com\/shared\/1/g) || []).length, 1);
  });

  test('cap zero holds block-list passes but positive titles still continue', () => {
    const boards = { Direct: [
      { title: 'Marketplace Operations', company: 'Example', url: 'https://boards.example.com/zero/1', location: 'London' },
      { title: 'Partnership Success', company: 'Example', url: 'https://boards.example.com/zero/2', location: 'London' },
      { title: 'Growth Marketing Manager', company: 'Example', url: 'https://boards.example.com/zero/positive', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards, blockCap: 0 });
    const output = run(lane);
    assert.match(output, /Block-list passes:\s+0 sent on, 2 held for the next run \(cap 0\)/);
    const pipeline = readIf(join(lane.dir, 'data', 'pipeline.md'));
    assert.match(pipeline, /Growth Marketing Manager/);
    assert.doesNotMatch(pipeline, /Marketplace Operations|Partnership Success/);
    assert.equal(existsSync(join(lane.dir, 'data', 'title-drops.tsv')), false);
    const receipt = JSON.parse(run(lane, ['--json']));
    assert.equal(receipt.block_list_passes_sent, 0);
    assert.equal(receipt.block_list_passes_held, 2);
  });

  test('a block-list pass already in scan history uses no cap slot', () => {
    const boards = { Direct: [
      { title: 'Marketplace Operations', company: 'Example', url: 'https://boards.example.com/history/old', location: 'London' },
      { title: 'Partnership Success', company: 'Example', url: 'https://boards.example.com/history/new', location: 'London' },
    ] };
    const lane = makeLane({ sources: [{ name: 'Direct' }], boards, blockCap: 1 });
    writeFileSync(join(lane.dir, 'data', 'scan-history.tsv'),
      'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\nhttps://boards.example.com/history/old\t2026-11-20\tfixture\tMarketplace Operations\tExample\tadded\n');
    const output = run(lane);
    assert.match(output, /Block-list passes:\s+1 sent on, 0 held for the next run \(cap 1\)/);
    assert.match(readIf(join(lane.dir, 'data', 'pipeline.md')), /history\/new/);
  });

  test.after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}
