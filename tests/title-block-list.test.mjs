import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT } from './helpers.mjs';
import { buildCompanyTitleDecision, buildTitleDropReason, buildTitleFilter } from '../title-keywords.mjs';

const block = [
  'engineer', 'machine learning', 'SDR', 'account executive', 'intern',
];
const blockExcept = ['Prompt Engineer', 'Partnerships', 'Partner Manager'];

test('company title decisions let unmatched titles through and name block-list drops', () => {
  const decide = buildCompanyTitleDecision({
    positive: ['Growth Marketing Manager'],
    negative: ['word:Backend'],
    block,
    block_except: blockExcept,
  });

  assert.deepEqual(decide('Marketplace Operations'), {
    keep: true, reason: null, route: 'block_list_pass',
  });
  assert.deepEqual(decide('Senior Platform Engineer'), {
    keep: false, reason: 'block:engineer', route: null,
  });
  assert.deepEqual(decide('Senior Backend Engineer'), {
    keep: false, reason: 'negative:word:Backend', route: null,
  });
  assert.deepEqual(decide('Growth Marketing Manager'), {
    keep: true, reason: null, route: null,
  });
});

test('block entries are whole-word matches and block exceptions win over them', () => {
  const decide = buildCompanyTitleDecision({ positive: ['Target Role'], block, block_except: blockExcept });

  assert.equal(decide('Prompt Engineer').keep, true);
  assert.equal(decide('Partner Manager, EMEA').keep, true);
  assert.equal(decide('International Partnerships Manager').keep, true);
  assert.equal(decide('International Operations Manager').keep, true);
  assert.equal(decide('Engineering Operations Manager').reason, null);
  assert.equal(decide('Machine Learning Specialist').reason, 'block:machine learning');
  assert.equal(decide('SDR Manager').reason, 'block:SDR');
});

test('a missing block list or empty positive list preserves the legacy title decision', () => {
  for (const config of [
    { positive: ['Growth Marketing Manager'], negative: ['word:Backend'] },
    { positive: ['Growth Marketing Manager'], negative: ['word:Backend'], block: 'engineer' },
    { positive: [], negative: ['word:Backend'], block, block_cap: 0 },
  ]) {
    const decide = buildCompanyTitleDecision(config);
    const keep = buildTitleFilter(config);
    const reason = buildTitleDropReason(config);
    for (const title of ['Marketplace Operations', 'Growth Marketing Manager', 'Backend Operations']) {
      assert.deepEqual(decide(title), { keep: keep(title), reason: reason(title), route: null });
    }
  }
});

test('every shipped and worktree positive entry has priority over the block-list', () => {
  const paths = [join(ROOT, 'templates', 'portals.example.yml')];
  const worktreePortals = join(ROOT, 'portals.yml');
  if (existsSync(worktreePortals)) paths.push(worktreePortals);

  for (const path of paths) {
    const config = yaml.load(readFileSync(path, 'utf8')) || {};
    const positive = Array.isArray(config.title_filter?.positive) ? config.title_filter.positive : [];
    const decide = buildCompanyTitleDecision({
      positive,
      block: config.title_filter?.block ?? block,
      block_except: config.title_filter?.block_except ?? blockExcept,
    });
    for (const entry of positive) {
      assert.equal(decide(entry).keep, true, `${path}: ${entry}`);
      assert.equal(decide(entry).route, null, `${path}: ${entry}`);
    }
  }
});

test('worktree positive entries survive the block and exception lists alone', (t) => {
  const worktreePortals = join(ROOT, 'portals.yml');
  if (!existsSync(worktreePortals)) {
    t.skip('worktree portals.yml is absent');
    return;
  }
  const config = yaml.load(readFileSync(worktreePortals, 'utf8')) || {};
  const positive = Array.isArray(config.title_filter?.positive) ? config.title_filter.positive : [];
  const decide = buildCompanyTitleDecision({
    positive: ['__block_list_test_sentinel__'],
    block: config.title_filter?.block ?? [],
    block_except: config.title_filter?.block_except ?? [],
  });
  for (const entry of positive) assert.equal(decide(entry).keep, true, entry);
});
