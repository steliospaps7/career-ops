/**
 * inbox-hidden-file.mjs — read and change data/inbox-hidden.tsv (see inbox-hidden.mjs).
 *
 * The read is shared by inbox-summary.mjs, so the page, /api/pipeline and
 * `node inbox-summary.mjs` leave the same rows out. The change is the route's:
 * read, apply, write the whole file with the `write` it is given (atomicWrite),
 * all synchronous, so two X presses on the one dashboard server cannot
 * interleave between the read and the write.
 *
 * Plain .mjs with relative imports only, so node loads it from the fork root.
 */
import fs from "node:fs";
import path from "node:path";
import { HIDDEN_FILE, parseHiddenTsv, serializeHiddenTsv, applyHiddenChange } from "./inbox-hidden.mjs";

export function hiddenFilePath(root) {
  return path.join(root, HIDDEN_FILE);
}

/** The file's entries. Only a missing file reads as none; any other read error
 *  throws. A failed read that returned [] would let the next X write a file
 *  holding only that URL and wipe every earlier X, so the route answers 500 and
 *  the page rolls the X back instead. */
export function readHiddenFile(root) {
  let text;
  try {
    text = fs.readFileSync(hiddenFilePath(root), "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  return parseHiddenTsv(text);
}

/**
 * Apply one change and write the whole file. When the change changes nothing
 * and the file exists (a merge of URLs already held), the file is left alone.
 * @param {string} root the data root
 * @param {{add?: string[], remove?: string[]}} change
 * @param {{write: (file: string, text: string) => void, now?: string}} io
 */
export function updateHiddenFile(root, change, { write, now } = {}) {
  const before = readHiddenFile(root);
  const { entries, added, removed } = applyHiddenChange(before, change, now);
  if (added || removed || !fs.existsSync(hiddenFilePath(root))) {
    write(hiddenFilePath(root), serializeHiddenTsv(entries));
  }
  return { entries, added, removed };
}
