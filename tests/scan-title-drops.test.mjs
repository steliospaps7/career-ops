// Title drops are observable and deduplicated; measurement never writes scan state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, NODE } from './helpers.mjs';
import { appendTitleDrops, TITLE_DROPS_HEADER, normalizeUrlForDedup } from '../scan.mjs';
import { buildTitleDropReason, buildTitleFilter } from '../title-keywords.mjs';

const execFileAsync = promisify(execFile);
const scan = join(ROOT, 'scan.mjs');
const HISTORY_HEADER = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n';
const PORTALS = `title_filter:
  positive: [Operations Associate, Operations Intern]
  negative: ['word:Intern']
location_filter:
  allow: [London]
tracked_companies:
  - name: Fixture Board
    careers_url: https://boards.example.com/drops
    parser:
      command: node
      script: tests/fixtures/title-drops-board.mjs
`;

function lane(portals = PORTALS) {
  const root = mkdtempSync(join(tmpdir(), 'scan-title-drops-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'portals.yml'), portals);
  writeFileSync(join(root, 'profile.yml'), '{}\n');
  const pipeline = join(root, 'data', 'pipeline.md');
  const history = join(root, 'data', 'scan-history.tsv');
  const drops = join(root, 'data', 'title-drops.tsv');
  const env = { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '',
    CAREER_OPS_PORTALS: join(root, 'portals.yml'), CAREER_OPS_PROFILE: join(root, 'profile.yml'),
    CAREER_OPS_PIPELINE: pipeline, CAREER_OPS_SCAN_HISTORY: history, CAREER_OPS_TITLE_DROPS: '',
    CAREER_OPS_SCAN_SOURCES: join(root, 'data', 'scan-sources.tsv'),
  };
  return { root, pipeline, history, drops, env };
}
function run(l, args = [], env = {}) {
  return execFileSync(NODE, [scan, ...args], { cwd: ROOT,
    env: { ...l.env, ...env }, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
}
function rows(file) {
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(1).map(line => {
    const fields = line.split('\t');
    return Object.fromEntries(TITLE_DROPS_HEADER.trim().split('\t').map((key, i) => [key, fields[i]]));
  });
}
function cleanup(l) { rmSync(l.root, { recursive: true, force: true }); }

test('title reasons preserve boolean behavior and name the original negative entry', () => {
  for (const config of [undefined, { positive: [] }, { negative: ['word:Intern', null] },
    { positive: ['Operations + Manager', 'stem:market'], negative: ['word:Intern', 'SDR', 2] }]) {
    const reason = buildTitleDropReason(config);
    const keep = buildTitleFilter(config);
    for (const title of ['Marketplace Operations', 'Operations Manager', 'Operations Intern', 'Internal Manager', 'SDR', null, 42]) {
      assert.equal(reason(title) === null, keep(title), JSON.stringify({ config, title }));
    }
  }
  const reason = buildTitleDropReason({ positive: ['Operations Associate'], negative: ['word:Intern'] });
  assert.equal(reason('Marketplace Operations'), 'no_positive');
  assert.equal(reason('Engineering Intern'), 'negative:word:Intern');
});

test('a scan logs both reasons and the default company kind, once across repeated runs', () => {
  const l = lane();
  try {
    run(l);
    const first = readFileSync(l.drops, 'utf8');
    const logged = rows(l.drops);
    assert.equal(logged.length, 2);
    assert.deepEqual(logged.map(r => r.reason), ['no_positive', 'negative:word:Intern']);
    assert.equal(logged[0].company, 'Fixture Co');
    assert.equal(logged[0].title, 'Marketplace Operations');
    assert.equal(logged[0].url, 'https://boards.example.com/drops/1');
    assert.equal(logged[0].location, 'London, UK');
    assert.match(logged[0].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(logged.every(r => r.source_kind === 'company'));
    run(l);
    assert.equal(readFileSync(l.drops, 'utf8'), first);
  } finally { cleanup(l); }
});

test('a normalized URL already in scan-history is never logged, even if recheck releases it', () => {
  const l = lane(PORTALS + 'scan_history:\n  recheck_after_days: 0\n');
  try {
    writeFileSync(l.history, HISTORY_HEADER + 'https://boards.example.com/DROPS/1/?utm_source=history\t2000-01-01\tfixture\trole\tco\tadded\n');
    run(l);
    assert.deepEqual(rows(l.drops).map(r => r.reason), ['negative:word:Intern']);
  } finally { cleanup(l); }
});

test('title-drop path follows the history directory and accepts an environment override', () => {
  const l = lane();
  try {
    const history = join(l.root, 'other', 'scan-history.tsv');
    run(l, [], { CAREER_OPS_SCAN_HISTORY: history });
    assert.equal(rows(join(l.root, 'other', 'title-drops.tsv')).length, 2);
    assert.equal(existsSync(l.drops), false);
    const override = join(l.root, 'override', 'drops.tsv');
    run(l, [], { CAREER_OPS_TITLE_DROPS: override });
    assert.equal(rows(override).length, 2);
  } finally { cleanup(l); }
});

test('retention prunes rows older than 60 days, keeps the boundary, and escapes TSV values', async () => {
  const l = lane();
  try {
    const date = '2026-11-19';
    const dateBefore = days => new Date(Date.parse(date) - days * 86400000).toISOString().slice(0, 10);
    const row = (days, id) => `${dateBefore(days)}\tco\trole\thttps://example.com/${id}\tLondon\tcompany\tno_positive\n`;
    writeFileSync(l.drops, TITLE_DROPS_HEADER + row(61, 'old') + row(60, 'boundary') + row(1, 'recent'));
    // A later admission to history must not erase an earlier drop's evidence.
    writeFileSync(l.history, HISTORY_HEADER + 'https://example.com/recent\t2026-11-19\tfixture\trole\tco\tadded\n');
    await appendTitleDrops([{ url: 'https://example.com/new', company: 'Co\tName', title: 'Role\nName',
      location: 'London', kind: 'portfolio', reason: 'no_positive' }], date,
    { filePath: l.drops, historyPath: l.history });
    assert.deepEqual(rows(l.drops).map(r => r.url), ['https://example.com/boundary', 'https://example.com/recent', 'https://example.com/new']);
    assert.equal(rows(l.drops)[2].title, 'Role Name');
    assert.equal(rows(l.drops)[2].company, 'Co Name');
    await appendTitleDrops([], dateBefore(-61), { filePath: l.drops, historyPath: l.history });
    assert.deepEqual(rows(l.drops), []);
  } finally { cleanup(l); }
});

test('two concurrent scan processes cannot duplicate or interleave title-drop rows', async () => {
  const l = lane();
  try {
    await Promise.all([1, 2].map(() => execFileAsync(NODE, [scan], {
      cwd: ROOT, env: l.env, encoding: 'utf8', timeout: 30000,
    })));
    assert.equal(rows(l.drops).length, 2);
    assert.equal(new Set(rows(l.drops).map(r => normalizeUrlForDedup(r.url))).size, 2);
    assert.ok(rows(l.drops).every(r => r.reason && r.source_kind === 'company'));
  } finally { cleanup(l); }
});

test('--measure-title and --dry-run do not create any of the three scan files', () => {
  const l = lane();
  try {
    for (const flag of ['--measure-title', '--dry-run']) {
      run(l, [flag]);
      for (const file of [l.pipeline, l.history, l.drops]) assert.equal(existsSync(file), false, file);
    }
  } finally { cleanup(l); }
});

const MEASURE_PORTALS = `title_filter:
  positive: ['Operations Associate']
  negative: ['word:Intern']
location_filter:
  allow: [London]
max_posting_age_days: 30
tracked_companies:
  - name: Direct
    careers_url: https://job-boards.greenhouse.io/direct
  - name: Portfolio
    kind: " Portfolio "
    careers_url: https://job-boards.greenhouse.io/portfolio
  - name: Aggregator
    kind: aggregator
    careers_url: https://job-boards.greenhouse.io/aggregator
`;

test('--measure-title counts unique new URLs by kind and separates missing location and date', () => {
  const l = lane(MEASURE_PORTALS);
  try {
    const now = new Date().toISOString();
    const job = (id, extra = {}) => ({ id, title: 'Marketplace Operations', location: { name: 'London' },
      absolute_url: `https://boards.example.com/measure/${id}`, first_published: now, ...extra });
    const boards = { direct: [job(1), job(2, { title: 'Operations Intern' }),
      job(1, { absolute_url: 'https://boards.example.com/measure/1/?utm_source=duplicate' }),
      job(3), job(4, { location: { name: 'Berlin' } }), job(5, { first_published: '2000-01-01' }),
      job(6, { first_published: '2999-01-01' }), job(7, { location: { name: '' } }),
      job(8, { first_published: null }), job(9, { first_published: 'invalid' }),
      job(10, { location: { name: '' }, first_published: null }),
      job(11, { title: 'Operations Associate' })],
    portfolio: [job('p1')], aggregator: [job('a1')] };
    const fixture = join(l.root, 'boards.json');
    writeFileSync(fixture, JSON.stringify(boards));
    writeFileSync(l.history, HISTORY_HEADER + 'https://boards.example.com/MEASURE/3/?utm_source=history\t2000-01-01\tfixture\trole\tco\tadded\n');
    writeFileSync(l.pipeline, '# Pipeline\n');
    writeFileSync(l.drops, TITLE_DROPS_HEADER + '2000-01-01\tco\trole\thttps://example.com/old\tLondon\tcompany\tno_positive\n');
    // If a title-positive row reaches the fit gate, the deliberately missing runner fails the test.
    writeFileSync(join(l.root, 'profile.yml'), 'fit_gate:\n  enabled: true\n  command: [definitely-no-model-runner]\n');
    const files = [l.pipeline, l.history, l.drops];
    const before = files.map(file => readFileSync(file, 'utf8'));
    const output = run(l, ['--measure-title', '--json', '--verify', '--posted-before', '2099-01-01'], {
      NODE_OPTIONS: `--import=${join(ROOT, 'tests', 'fixtures', 'title-drops-fetch.mjs')}`,
      TITLE_DROPS_FIXTURE: fixture,
    });
    const receipt = JSON.parse(output);
    assert.deepEqual(receipt.errors, []);
    assert.equal(receipt.dry_run, true);
    assert.deepEqual(receipt.title_measurement.company, {
      total: 6, confirmed: 2, missing_location_only: 1, missing_date_only: 2, missing_both: 1,
    });
    for (const kind of ['portfolio', 'aggregator']) {
      assert.deepEqual(receipt.title_measurement[kind], {
        total: 1, confirmed: 1, missing_location_only: 0, missing_date_only: 0, missing_both: 0,
      });
    }
    assert.deepEqual(files.map(file => readFileSync(file, 'utf8')), before);
    assert.equal(existsSync(join(l.root, 'jds')), false);
  } finally { cleanup(l); }
});

test('--measure-title rejects --read-pipeline before it can write', () => {
  const l = lane();
  try {
    assert.throws(() => run(l, ['--measure-title', '--read-pipeline']), /cannot be combined/);
    for (const file of [l.pipeline, l.history, l.drops]) assert.equal(existsSync(file), false);
  } finally { cleanup(l); }
});


test('an unwritable title-drop path reports an error but still saves pipeline and history rows', () => {
  const l = lane(MEASURE_PORTALS.split('  - name: Portfolio')[0]);
  try {
    const fixture = join(l.root, 'boards.json');
    writeFileSync(fixture, JSON.stringify({ direct: [
      { id: 1, title: 'Operations Associate', location: { name: 'London' },
        absolute_url: 'https://boards.example.com/kept/1', content: '<p>Operations in London.</p>' },
      { id: 2, title: 'Engineering Intern', location: { name: 'London' },
        absolute_url: 'https://boards.example.com/dropped/2' },
    ] }));
    const blocker = join(l.root, 'not-a-directory');
    writeFileSync(blocker, 'file');
    let result;
    try {
      run(l, ['--json'], { CAREER_OPS_TITLE_DROPS: join(blocker, 'drops.tsv'),
        NODE_OPTIONS: `--import=${join(ROOT, 'tests', 'fixtures', 'title-drops-fetch.mjs')}`,
        TITLE_DROPS_FIXTURE: fixture });
      assert.fail('the failed log write must appear in the JSON errors');
    } catch (error) {
      assert.equal(error.status, 2);
      result = JSON.parse(error.stdout);
    }
    assert.equal(result.added, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /title.drops.*(?:ENOTDIR|EEXIST)/i);
    assert.match(readFileSync(l.pipeline, 'utf8'), /https:\/\/boards.example.com\/kept\/1/);
    assert.match(readFileSync(l.history, 'utf8'), /https:\/\/boards.example.com\/kept\/1/);
  } finally { cleanup(l); }
});


test('an unknown source kind warns once, falls back to company, and still scans', async () => {
  const l = lane(PORTALS.replace('  - name: Fixture Board', '  - name: Fixture Board\n    kind: vc'));
  try {
    const { stdout, stderr } = await execFileAsync(NODE, [scan, '--json'], {
      cwd: ROOT, env: l.env, encoding: 'utf8', timeout: 30000,
    });
    assert.deepEqual(JSON.parse(stdout).errors, []);
    assert.equal((stderr.match(/unknown source kind/gi) || []).length, 1);
    assert.match(stderr, /vc.*company/i);
    assert.equal(rows(l.drops).length, 2);
    assert.ok(rows(l.drops).every(row => row.source_kind === 'company'));
  } finally { cleanup(l); }
});
