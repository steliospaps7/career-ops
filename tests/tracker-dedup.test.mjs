/**
 * tests/tracker-dedup.test.mjs — seam 7 of ticket B2.
 *
 * A role already in `data/applications.md` must never be queued again, whether
 * it comes back under the same link or under a different board's link and a
 * slightly different title. Two keys carry it: the posting URL through
 * `normalizeUrlForDedup`, and company plus title through the same canonicalisers
 * `collectSeenCompanyRoles` uses.
 *
 * The tracker has no URL column and must not grow one. Its URLs are the inline
 * ones in the row text and the `**URL:**` header of each report a row links to.
 * It is read here and never written.
 *
 * Nothing here touches the network.
 *
 * Run: node test-all.mjs --only tracker-dedup
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectTrackerDedupIndex,
  matchTrackerDuplicate,
  formatTrackerDuplicateReason,
  collectSeenCompanyRoles,
  companyRoleDedupKey,
  normalizeRoleForDedup,
} from '../scan.mjs';
import { pass, fail, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — dedup against the tracker (seam 7)');

function ok(label, cond) {
  if (cond) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  if (actual === expected) pass(label);
  else fail(`${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const dirs = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'co-tracker-dedup-'));
  dirs.push(d);
  return d;
}

// The real tracker's header, Via column included, so a positional reader is
// caught here rather than in production.
const HEADER = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|-----|------|-------|--------|-----|--------|-------|',
].join('\n');

function tracker(...rows) {
  return [HEADER, ...rows, ''].join('\n');
}

// ── The two keys, built from a tracker that has no URL column ───────
{
  const root = tempDir();
  const dataDir = join(root, 'data');
  const reportsDir = join(root, 'reports');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  writeFileSync(join(reportsDir, '049-yulife-2026-09-05.md'), [
    '# Evaluation: YuLife — Product Owner',
    '',
    '**Date:** 2026-09-05',
    '**URL:** https://careers.yulife.engineering/jobs/8217928-product-owner',
    '**Score:** 3.2/5',
  ].join('\n'));

  const text = tracker(
    '| 1 | 2026-08-26 | Suna Health | — | Smart Generalist | — | Applied | ❌ | — | Applied direct | link: https://suna.health/careers |',
    '| 49 | 2026-09-05 | YuLife | — | Product Owner | 3.2/5 | SKIP | ❌ | [049](../reports/049-yulife-2026-09-05.md) | Delivery-side PO seat |',
  );
  const trackerPath = join(dataDir, 'applications.md');
  writeFileSync(trackerPath, text);

  const index = collectTrackerDedupIndex({ applicationsText: text, trackerPath });

  eq('both rows contribute a company+title key', index.byCompanyRole.size, 2);
  ok(
    'an inline link: URL is a key',
    index.byUrl.has('https://suna.health/careers'),
  );
  ok(
    "a linked report's **URL:** header is a key",
    index.byUrl.has('https://careers.yulife.engineering/jobs/8217928-product-owner'),
  );
  eq(
    'the URL key carries the row number back',
    index.byUrl.get('https://careers.yulife.engineering/jobs/8217928-product-owner')?.row,
    49,
  );

  // The row-49 duplicate, by URL.
  const byUrl = matchTrackerDuplicate(
    { url: 'https://careers.yulife.engineering/jobs/8217928-product-owner?utm_source=x', company: 'YuLife', title: 'Product Owner, Activation Squad' },
    index,
  );
  eq('a tracked URL matches through the normalizer', byUrl?.row, 49);
  eq('the match says which key fired', byUrl?.key, 'url');
  eq(
    'the reason names the row, the company and the title',
    formatTrackerDuplicateReason(byUrl),
    'skipped (duplicate: tracker row 49, YuLife Product Owner)',
  );

  // The same row, by company plus title, under a link the tracker never saw.
  const byPair = matchTrackerDuplicate(
    { url: 'https://app.welcometothejungle.com/jobs/abc123', company: 'yulife', title: ' Product   Owner ' },
    index,
  );
  eq('company plus title matches with no URL in common', byPair?.row, 49);
  eq('the match says which key fired', byPair?.key, 'company-role');

  // A local: queue line has no URL to match, so the pair has to carry it.
  const local = matchTrackerDuplicate(
    { url: '', company: 'YuLife', title: 'Product Owner' },
    index,
  );
  eq('a row with no URL still matches on the pair', local?.row, 49);

  // Two sibling roles at one company stay two rows.
  ok(
    'a sibling role at the same company is not a duplicate',
    matchTrackerDuplicate({ url: 'https://careers.yulife.engineering/jobs/8102560-product-owner', company: 'YuLife', title: 'Product Owner, Game Squad' }, index) === null,
  );
  ok(
    'an untracked company is not a duplicate',
    matchTrackerDuplicate({ url: 'https://example.com/jobs/1', company: 'Never Heard Of', title: 'Product Owner' }, index) === null,
  );

  // The header and the separator are not rows.
  ok('the header row contributes no key', !index.byCompanyRole.has(companyRoleDedupKey('Company', 'Role')));
}

// ── The tracker is read, never written ──────────────────────────────
{
  const root = tempDir();
  mkdirSync(join(root, 'data'), { recursive: true });
  const trackerPath = join(root, 'data', 'applications.md');
  const text = tracker('| 7 | 2026-09-01 | Acme | — | Analyst | 4.0/5 | Applied | ❌ | — | Note |');
  writeFileSync(trackerPath, text);
  const index = collectTrackerDedupIndex({ applicationsText: text, trackerPath });
  matchTrackerDuplicate({ url: 'https://acme.example/jobs/1', company: 'Acme', title: 'Analyst' }, index);
  const { readFileSync } = await import('fs');
  eq('the tracker file is byte-identical after the check', readFileSync(trackerPath, 'utf-8'), text);
}

// ── The Anthropic re-listing: a different URL and a slightly different title ──
//
// "Applied AI Strategist, EMEA" was cut through its Greenhouse link on
// 4 September and re-queued on 9 September as "Applied AI Strategist (EMEA)"
// through Welcome to the Jungle. The two URLs share nothing, so the
// company-plus-title key is the only thing that can catch it.
{
  const processedLine = '- [x] https://boards.greenhouse.io/anthropic/jobs/5390791008 | Anthropic | Applied AI Strategist, EMEA | London, UK | triage: FAIL 2.0';
  const seen = collectSeenCompanyRoles({ pipelineText: `## Processed\n${processedLine}\n` });

  const boardRow = { company: 'Anthropic', title: 'Applied AI Strategist (EMEA)' };
  const key = companyRoleDedupKey(boardRow.company, boardRow.title);

  ok('the re-listing matches the cut row on company plus title', seen.has(key));
  eq(
    'the trailing ", EMEA" and the trailing "(EMEA)" key the same',
    normalizeRoleForDedup('Applied AI Strategist, EMEA'),
    normalizeRoleForDedup('Applied AI Strategist (EMEA)'),
  );
  // The same holds for the tracker-side index, so the row cannot come back
  // through a board after it has been evaluated either.
  const text = tracker('| 60 | 2026-09-04 | Anthropic | — | Applied AI Strategist, EMEA | 2.0/5 | SKIP | ❌ | — | Fifteen years wanted |');
  const index = collectTrackerDedupIndex({ applicationsText: text });
  eq(
    'the tracker catches the re-listing too',
    matchTrackerDuplicate({ url: 'https://www.welcometothejungle.com/en/companies/anthropic/jobs/applied-ai-strategist-emea_london_ec5jjya2', ...boardRow }, index)?.row,
    60,
  );
}

// ── The key is not widened past a location suffix ───────────────────
//
// YuLife runs two Product Owner squads and they stay two rows. A trailing tag
// is stripped only when it is a place, which is what the bracketed form has
// always done.
{
  ok(
    'two sibling squads keep two keys',
    normalizeRoleForDedup('Product Owner, Activation Squad') !== normalizeRoleForDedup('Product Owner, Game Squad'),
  );
  ok(
    'a squad name is not mistaken for a location',
    normalizeRoleForDedup('Product Owner, Activation Squad') !== normalizeRoleForDedup('Product Owner'),
  );
  ok(
    'a department is not a location either',
    normalizeRoleForDedup('Product Manager, Public Sector') !== normalizeRoleForDedup('Product Manager'),
  );
  eq(
    'a trailing country is stripped, as the bracketed form already was',
    normalizeRoleForDedup('Account Executive, Germany'),
    normalizeRoleForDedup('Account Executive (Germany)'),
  );
  eq(
    'a trailing city too',
    normalizeRoleForDedup('Engineer, Berlin'),
    normalizeRoleForDedup('Engineer'),
  );
  ok(
    'a one-word title is never stripped to nothing',
    normalizeRoleForDedup('EMEA') === 'emea',
  );
}

// ── A region is kept in the key, in both spellings ──────────────────
//
// A city or a country after the title is how one company splits one req per
// office, and collapsing those to one key is what the normalizer is for. A
// region is not that: "Account Executive, EMEA" and "Account Executive,
// Americas" are two jobs on two continents, and merging them loses the second
// as a duplicate that never reaches the queue. So a region stays in the key —
// which is also what makes the two spellings of the Anthropic title agree,
// rather than both collapsing onto the bare title.
{
  ok(
    'two regions at one company stay two keys',
    normalizeRoleForDedup('Account Executive, EMEA') !== normalizeRoleForDedup('Account Executive, Americas'),
  );
  ok(
    'and in the bracketed spelling too, which had the same flaw before this ticket',
    normalizeRoleForDedup('Account Executive (EMEA)') !== normalizeRoleForDedup('Account Executive (Americas)'),
  );
  eq(
    'a region is not stripped down to the bare title',
    normalizeRoleForDedup('Account Executive (EMEA)'),
    'account executive emea',
  );
  eq(
    'the two spellings of a region still agree with each other',
    normalizeRoleForDedup('Account Executive, EMEA'),
    normalizeRoleForDedup('Account Executive (EMEA)'),
  );
  for (const region of ['APAC', 'Americas', 'Europe', 'EU', 'North America', 'Latin America', 'AMER']) {
    ok(
      `"${region}" is kept in the key`,
      normalizeRoleForDedup(`Manager, ${region}`) !== normalizeRoleForDedup('Manager'),
    );
  }
  // The city and country behaviour the upstream suite pins is unchanged.
  eq('a city is still stripped', normalizeRoleForDedup('Engineer (Berlin)'), normalizeRoleForDedup('Engineer'));
  eq('a country is still stripped', normalizeRoleForDedup('Engineer (Germany)'), normalizeRoleForDedup('Engineer'));
  eq('a remote tag is still stripped', normalizeRoleForDedup('Engineer [Remote]'), normalizeRoleForDedup('Engineer'));
}

// ── A title that is nothing but its tag keys the tag, not '' ────────
//
// The empty key is the dangerous one: every title at that company that
// normalizes to nothing shares it, and the first one queued buries the rest.
{
  eq('a bracketed tag alone keys the tag', normalizeRoleForDedup('(Remote)'), 'remote');
  eq('a square-bracketed tag alone too', normalizeRoleForDedup('[Berlin]'), 'berlin');
  eq('a bare region keys itself', normalizeRoleForDedup('EMEA'), 'emea');
  ok(
    'so two tag-only titles at one company do not share a key',
    normalizeRoleForDedup('(Remote)') !== normalizeRoleForDedup('(Berlin)'),
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
