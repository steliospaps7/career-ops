// tests/portals-search-queries-removed.test.mjs — a portals.yml still carrying
// search_queries is reported, not silently accepted.
//
// The key was type-checked and read by nothing: no module ever executed a
// query, so a file listing seven of them described coverage that did not
// happen. The validator branch that only checked its type is gone; this one
// catches the old copy someone restores from a backup.
//
// Run as a subprocess against a temp file rather than imported: importing
// validate-portals.mjs runs its CLI over the user's real portals.yml.
import { pass, fail, ROOT, NODE } from './helpers.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

console.log('\nvalidate-portals — search_queries is reported as removed');

const CLEAN = `title_filter:
  positive:
    - "Operations Associate"
tracked_companies:
  - name: Fixture Co
    careers_url: https://boards.example.com/fixture
`;

const WITH_KEY = `${CLEAN}search_queries:
  - name: Ashby — London
    query: 'site:jobs.ashbyhq.com London'
    enabled: true
`;

function validate(yamlText) {
  const dir = mkdtempSync(join(tmpdir(), 'portals-searchqueries-'));
  try {
    const file = join(dir, 'portals.yml');
    writeFileSync(file, yamlText);
    const r = spawnSync(NODE, [join(ROOT, 'validate-portals.mjs'), '--file', file], {
      cwd: ROOT, encoding: 'utf-8', timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { status, out } = validate(WITH_KEY);
  if (/warning: search_queries:/.test(out)) pass('a file still carrying search_queries is reported');
  else fail(`search_queries was not reported: ${out}`);
  if (status === 0) pass('the leftover key is a warning, not a hard failure — an old backup still validates');
  else fail(`validator exited ${status} on a file whose only issue is the removed key: ${out}`);
}

{
  const { status, out } = validate(CLEAN);
  if (status === 0 && !/search_queries/.test(out)) pass('a file without the key validates clean');
  else fail(`clean config: exit ${status}, output ${out}`);
}
