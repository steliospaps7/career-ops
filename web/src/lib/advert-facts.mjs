/**
 * advert-facts.mjs — what an evaluate run knows about an inbox row's advert
 * beyond its URL (ticket 2e).
 *
 * Plain .mjs, the same pattern as inbox-line.mjs, so the two lookups can be
 * tested with `node --test` against a fixture tree and no build step. A view
 * over the user's files: nothing here writes.
 *
 * Why it exists: on 22 September 2026 the dashboard scored an Indeed row and
 * the worker reported the posting unreadable behind Indeed's login wall, having
 * written nothing — while a 5 KB copy of that advert, saved by the same
 * morning's scan, sat in jds/ and was named on the row itself. The server had
 * the facts; the prompt never stated them.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { localJdPath } from "./run-prompts.mjs";

/** @typedef {{jd?: string, company?: string, employerSite?: string}} AdvertFacts */

/**
 * The advert facts for one inbox row.
 *
 * Both lookups are tolerant — a missing or broken file leaves the field unset
 * and the prompt falls back to the one it has always been.
 *
 *  - `jd`: the row's own `jd: local:jds/<file>` reference, kept only when that
 *    file is really on disk. A reference the prompt names but the worker cannot
 *    open is worse than none: it sends it looking for text that is not there.
 *    The accepted shape is localJdPath's, shared with the prompt itself, so the
 *    check here and the instruction there cannot drift.
 *  - `employerSite`: the company's own careers page, from portals.yml's
 *    tracked_companies (careers_url, else the api URL) and failing that the
 *    `website` column of data/companies.tsv.
 *
 * Company names are matched whole and case-insensitively. A company that
 * appears under a second spelling gets an alias line in portals.yml, which is
 * the house rule; fuzzy matching here would resolve the wrong employer's board
 * and send the worker to read somebody else's posting.
 *
 * @param {{company?: string, jd?: string} | undefined | null} job
 * @param {string} root - the career-ops checkout holding jds/, portals.yml, data/
 * @returns {AdvertFacts | undefined}
 */
export function readAdvertFacts(job, root) {
  if (!job) return undefined;
  const company = String(job.company ?? "").trim();
  /** @type {AdvertFacts} */
  const facts = {};
  if (company) facts.company = company;

  const rel = localJdPath(job.jd);
  if (rel && fileExists(path.join(root, rel))) facts.jd = String(job.jd).trim();

  const site = employerCareersUrl(company, root);
  if (site) facts.employerSite = site;

  return facts;
}

/** @param {string} file */
function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** @param {string} file */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** portals.yml → the company's careers_url, else its api URL, else undefined.
 *  @param {string} company @param {string} root */
function portalsCareersUrl(company, root) {
  const source = readText(path.join(root, "portals.yml"));
  if (!source) return undefined;
  let doc;
  try {
    doc = yaml.load(source);
  } catch {
    // A portals.yml that will not parse is the scan's problem to report; this
    // prompt degrades to naming no careers page rather than failing the run.
    return undefined;
  }
  const tracked = doc?.tracked_companies;
  if (!Array.isArray(tracked)) return undefined;
  const want = company.toLowerCase();
  for (const entry of tracked) {
    if (String(entry?.name ?? "").trim().toLowerCase() !== want) continue;
    for (const field of [entry?.careers_url, entry?.api]) {
      const url = String(field ?? "").trim();
      if (url) return url;
    }
  }
  return undefined;
}

/** data/companies.tsv → the company's `website` cell, else undefined.
 *  @param {string} company @param {string} root */
function companiesWebsite(company, root) {
  const tsv = readText(path.join(root, "data", "companies.tsv"));
  if (!tsv) return undefined;
  const lines = tsv.split("\n");
  // Resolve the two columns by their header names: the file has gained columns
  // before (tier, door, status) and a fixed index would silently read one of them.
  const header = (lines[0] ?? "").split("\t").map((h) => h.trim().toLowerCase());
  const nameCol = header.indexOf("name");
  const siteCol = header.indexOf("website");
  if (nameCol < 0 || siteCol < 0) return undefined;
  const want = company.toLowerCase();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    if (String(cells[nameCol] ?? "").trim().toLowerCase() !== want) continue;
    const url = String(cells[siteCol] ?? "").trim();
    if (url) return url;
  }
  return undefined;
}

/** @param {string} company @param {string} root */
function employerCareersUrl(company, root) {
  if (!company) return undefined;
  return portalsCareersUrl(company, root) ?? companiesWebsite(company, root);
}
