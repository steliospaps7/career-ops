#!/usr/bin/env node
/**
 * inbox-summary.mjs — what the dashboard Inbox shows, counted from the files.
 *
 *   node inbox-summary.mjs
 *
 * Prints four numbers and the rows between them: the unticked lines in
 * data/pipeline.md, the rows hidden because the tracker already holds them
 * (each with its tracker row, status and date), the rows hidden with X on the
 * dashboard (data/inbox-hidden.tsv), and the rows the Inbox shows.
 * A count of the file alone is higher than the page whenever a tracked line is
 * still unticked, which is the normal case: only the scan's hand-run
 * `--read-pipeline --gate` recheck ticks them.
 *
 * This is the first root script that imports from web/: it runs the same
 * composition the Inbox page and the Explore add use,
 * web/src/lib/inbox-summary.mjs, so the three can never count differently. That
 * module and everything it imports are plain .mjs with relative imports, so no
 * build step is needed. Read only: nothing is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDataRoot } from './web/src/lib/core/data-root.mjs';
import { readInboxSummary, countInbox } from './web/src/lib/inbox-summary.mjs';

const coreRoot = path.dirname(fileURLToPath(import.meta.url));
const root = resolveDataRoot(
  coreRoot,
  (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  process.env,
  path.resolve,
  path.join,
);

if (!fs.existsSync(path.join(root, 'data/pipeline.md'))) {
  console.error(`inbox-summary: no data/pipeline.md under ${root}`);
  process.exit(1);
}

const { jobs, inbox } = readInboxSummary(root);
const { pendingLines, hidden, hiddenWithX, shown } = countInbox(jobs, inbox);
const repeats = pendingLines - hidden.length - hiddenWithX.length - shown.length;

console.log(`Inbox summary for ${root}`);
console.log(`Pending lines in data/pipeline.md: ${pendingLines}`);
console.log(`Hidden, already in the tracker: ${hidden.length}`);
for (const j of hidden) {
  const t = j.tracked;
  console.log(`  - ${j.company} | ${j.role} — tracker row ${t.n}, ${t.status || 'no status'}, ${t.date || 'no date'}`);
}
console.log(`Hidden with X: ${hiddenWithX.length}`);
for (const j of hiddenWithX) {
  console.log(`  - ${j.company} | ${j.role} — ${j.hiddenWithX.at || 'no time'}`);
}
if (repeats) console.log(`Repeat lines of a URL already listed: ${repeats}`);
console.log(`Shown in the Inbox: ${shown.length}`);
