import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePortalsConfig } from '../validate-portals.mjs';

test('portal validation accepts block-list keys and a zero cap', async () => {
  const result = await validatePortalsConfig({
    title_filter: {
      block: ['engineer', 'word:intern'],
      block_except: ['Prompt Engineer'],
      block_cap: 0,
    },
  });
  assert.deepEqual(result.errors, []);
});

test('portal validation rejects non-list block keys and invalid caps', async () => {
  for (const [key, value] of [['block', 'engineer'], ['block_except', 'Prompt Engineer']]) {
    const result = await validatePortalsConfig({ title_filter: { [key]: value } });
    assert.match(result.errors.map(error => `${error.path}: ${error.message}`).join('\n'), new RegExp(`title_filter\\.${key}.*array`));
  }

  for (const value of [-1, 1.5, '40']) {
    const result = await validatePortalsConfig({ title_filter: { block_cap: value } });
    assert.match(result.errors.map(error => `${error.path}: ${error.message}`).join('\n'), /title_filter\.block_cap.*non-negative integer/);
  }
});
