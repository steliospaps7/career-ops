// Tests for the advert facts an evaluate run attaches to an inbox row
// (ticket 2e). Built against a fixture checkout in a temp directory, so the
// lookups are exercised on real files without touching the user's own.
//
// Run:  node --test tests/lib/advert-facts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAdvertFacts } from "../../src/lib/advert-facts.mjs";
import { parseInboxLine } from "../../src/lib/inbox-line.mjs";

const FRED_PERRY_LINE =
  "- [ ] https://uk.indeed.com/viewjob?jk=1505caa519d66118 | Fred Perry | Product Manager - Menswear | London WC1X 0AA | jd: local:jds/fred-perry-product-manager-menswear-eea864f490.md | route: review | fit: REVIEW (a stretch) | note: local:jds/fred-perry-product-manager-menswear-eea864f490.md";
const FRED_PERRY_JD = "jds/fred-perry-product-manager-menswear-eea864f490.md";

/** A throwaway career-ops checkout: whichever of jds/, portals.yml and
 *  data/companies.tsv the case needs, and nothing else. */
function fixtureRoot({ jdFiles = [], portals, companies } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advert-facts-"));
  if (jdFiles.length) fs.mkdirSync(path.join(root, "jds"));
  for (const name of jdFiles) fs.writeFileSync(path.join(root, "jds", name), "# advert\n");
  if (portals !== undefined) fs.writeFileSync(path.join(root, "portals.yml"), portals);
  if (companies !== undefined) {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "companies.tsv"), companies);
  }
  return root;
}

const FRED_PERRY_FILE = FRED_PERRY_JD.slice("jds/".length);

test("the Fred Perry row resolves to its saved advert", () => {
  // The case of 22 September 2026: the file was there all along.
  const root = fixtureRoot({ jdFiles: [FRED_PERRY_FILE] });
  const facts = readAdvertFacts(parseInboxLine(FRED_PERRY_LINE), root);

  assert.equal(facts.jd, `local:${FRED_PERRY_JD}`);
  assert.equal(facts.company, "Fred Perry");
  // no board line and no companies.tsv row yet — the Tiers chat adds those
  assert.equal(facts.employerSite, undefined);
});

test("a jd: reference to a file that is not there is dropped", () => {
  // Naming a file the worker then cannot open is worse than naming none: it
  // sends it hunting for text that does not exist.
  const root = fixtureRoot({ jdFiles: [] });
  const facts = readAdvertFacts(parseInboxLine(FRED_PERRY_LINE), root);
  assert.equal(facts.jd, undefined);
});

test("portals.yml's careers_url is the employer's page, with api as the fallback", () => {
  const root = fixtureRoot({
    jdFiles: [FRED_PERRY_FILE],
    portals: [
      "tracked_companies:",
      "  - name: Capital on Tap",
      "    careers_url: https://job-boards.greenhouse.io/capitalontap",
      "    api: https://boards-api.greenhouse.io/v1/boards/capitalontap/jobs",
      "  - name: Api Only",
      "    api: https://api.ashbyhq.com/posting-api/job-board/apionly",
      "",
    ].join("\n"),
  });

  assert.equal(
    readAdvertFacts({ company: "capital on tap" }, root).employerSite,
    "https://job-boards.greenhouse.io/capitalontap",
    "careers_url wins, and the name match ignores case",
  );
  assert.equal(
    readAdvertFacts({ company: "Api Only" }, root).employerSite,
    "https://api.ashbyhq.com/posting-api/job-board/apionly",
    "an entry with no careers_url falls back to its api URL",
  );
  assert.equal(readAdvertFacts({ company: "Fred Perry" }, root).employerSite, undefined);
});

test("companies.tsv's website is used when portals.yml has no line", () => {
  const root = fixtureRoot({
    portals: "tracked_companies:\n  - name: Someone Else\n    careers_url: https://else.example/jobs\n",
    // the columns are resolved by header name: this file has gained columns before
    companies: ["name\tlinkedin\tsize\twebsite\ttier", "Lupa\tlupapets\t77\thttps://lupapets.com\t1", "No Site\t\t\t\t2"].join("\n"),
  });

  assert.equal(readAdvertFacts({ company: "Lupa" }, root).employerSite, "https://lupapets.com");
  assert.equal(readAdvertFacts({ company: "No Site" }, root).employerSite, undefined);
});

test("a broken or missing file leaves the field unset, never throws", () => {
  // A portals.yml the scan cannot parse is the scan's problem to report. This
  // prompt degrades to naming no careers page rather than failing the run.
  const broken = fixtureRoot({ portals: "tracked_companies: [ unclosed\n" });
  assert.equal(readAdvertFacts({ company: "Lupa" }, broken).employerSite, undefined);

  const empty = fixtureRoot();
  assert.deepEqual(readAdvertFacts({ company: "Lupa" }, empty), { company: "Lupa" });
  assert.equal(readAdvertFacts(undefined, empty), undefined);
});

test("a company name is matched whole, never by prefix", () => {
  // "Fred" must not resolve to Fred Perry's board, and Fred Perry must not
  // resolve to another Fred's. A second spelling gets an alias line in
  // portals.yml, which is the house rule.
  const root = fixtureRoot({
    portals: "tracked_companies:\n  - name: Fred Perry\n    careers_url: https://careers.fredperry.com\n",
  });
  assert.equal(readAdvertFacts({ company: "Fred Perry" }, root).employerSite, "https://careers.fredperry.com");
  assert.equal(readAdvertFacts({ company: "Fred" }, root).employerSite, undefined);
  assert.equal(readAdvertFacts({ company: "Fred Perry Ltd" }, root).employerSite, undefined);
});
