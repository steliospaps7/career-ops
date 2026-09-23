// Tests for the prompts /api/run sends each worker kind (#2185).
//
// The pdf prompt is the load-bearing half of this fix: it is what tells the agent
// to EMIT the CV instead of saving it. It used to live inside route.ts, where the
// only available guard was grepping the file — which matched route.ts's own
// comments and so could never fail. Asserting the returned string closes that.
//
// Run:  node --test tests/lib/run-prompts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, isShellSafeCompanyName, localJdPath, isAggregatorUrl } from "../../src/lib/run-prompts.mjs";
import { parseInboxLine } from "../../src/lib/inbox-line.mjs";
import { OPEN_MARK, CLOSE_MARK } from "../../src/lib/cv-envelope.mjs";
import { grantsWriteCapability, toolScopeFor } from "../../src/lib/claude-invocation.mjs";

const ARGS = { input: "018", memory: "", today: "2026-08-04" };

test("buildPrompt: the pdf prompt asks for the envelope and forbids saving", () => {
  // Given a pdf run
  const prompt = buildPrompt({ kind: "pdf", ...ARGS });

  // Then it names both markers in the parser's own spelling...
  assert.ok(prompt.includes(OPEN_MARK), "pdf prompt must name the opening marker");
  assert.ok(prompt.includes(CLOSE_MARK), "pdf prompt must name the closing marker");
  // ...and tells it not to save, so an agent that ignores the envelope has been
  // told twice
  assert.match(prompt, /Do NOT save or edit any file/i);
});

test("buildPrompt: the pdf prompt does not claim the agent has no write tools", () => {
  // Given that claim is only true on Claude Code — the six CLIs invoked via
  // clis.ts's bare args keep their default tool access
  const prompt = buildPrompt({ kind: "pdf", ...ARGS });

  // Then the prompt states an instruction ("do not save"), never a false fact
  // about the agent's own capabilities. Telling an agent it lacks a tool it holds
  // invites it to test the claim.
  assert.ok(!/no file-writing tools/i.test(prompt), "must not assert a capability the agent may have");
  assert.ok(!/you have no .*tools/i.test(prompt), "must not assert a capability the agent may have");
});

test("buildPrompt: the pdf prompt never tells the agent to save a file", () => {
  // Given a pdf run
  const prompt = buildPrompt({ kind: "pdf", ...ARGS });

  // Then the pre-#2185 phrasing is gone. This is the regression that matters: the
  // tool grant and the prompt have to agree, and a prompt that asks for a write
  // the agent cannot perform produces a silently failing run.
  assert.ok(!/write the HTML to/i.test(prompt), "pdf prompt must not ask for a file write");
  assert.ok(!/\.meta\.json/.test(prompt), "pdf prompt must not name the sidecar path");
});

test("buildPrompt: the pdf prompt offers both page formats", () => {
  // Given the marker example once interpolated the parser's FALLBACK, which made
  // the prompt read "choose letter for a US/Canada company, otherwise letter" —
  // biasing every CV to one size. The tailoring rule and the fallback are separate.
  const prompt = buildPrompt({ kind: "pdf", ...ARGS });

  // Then both spellings are shown, and the rule distinguishes them
  assert.match(prompt, /format="a4"/);
  assert.match(prompt, /format="letter"/);
  assert.match(prompt, /letter for a US\/Canada company, otherwise a4/i);
});

test("buildPrompt: the pdf prompt still pins tailoring to the real mode", () => {
  // Given a pdf run — the web orchestrates the engine, it does not reimplement it
  const prompt = buildPrompt({ kind: "pdf", ...ARGS });

  // Then modes/pdf.md remains the authority, and the report number is threaded in
  assert.match(prompt, /modes\/pdf\.md/);
  assert.match(prompt, /reports\/018-\*\.md/);
});

test("buildPrompt: every kind ends with exactly one VERDICT instruction", () => {
  // Given each kind — job-store.tsx parses that final line client-side
  for (const kind of ["pdf", "research", "evaluate", "fix-portal"]) {
    const prompt = buildPrompt({ kind, ...ARGS });

    // Then the contract is present exactly once, so the parse cannot pick a
    // stray earlier mention
    const mentions = prompt.match(/VERDICT:/g) ?? [];
    assert.equal(mentions.length, 1, `${kind} must state VERDICT once, got ${mentions.length}`);
  }
});

test("buildPrompt: an unknown kind falls through to the evaluate prompt", () => {
  // Given a kind nobody has taught this map about
  // When building its prompt
  // Then it is the evaluation prompt (the documented default), not an empty string
  const prompt = buildPrompt({ kind: "some-future-kind", ...ARGS });
  assert.match(prompt, /OFFICIAL career-ops job evaluation/);
});

test("buildPrompt: memory is injected only when non-empty", () => {
  // Given a profile note, and given none
  const withMem = buildPrompt({ kind: "evaluate", input: "x", memory: "  Prefers remote.  ", today: "2026-08-04" });
  const without = buildPrompt({ kind: "evaluate", input: "x", memory: "   ", today: "2026-08-04" });

  // Then a whitespace-only memory adds no dangling header — the agent should not
  // be handed an empty "Durable notes" section to interpret
  assert.match(withMem, /Durable notes about the user/);
  assert.match(withMem, /Prefers remote\./);
  assert.ok(!/Durable notes/.test(without));
});

test("buildPrompt: every kind carries a DIRECT no-submission clause", () => {
  // AGENTS.md states the rule unconditionally: "NEVER submit an application without
  // the user reviewing it first ... always STOP before clicking Submit/Send/Apply".
  // Every pattern here must be about submitting/sending specifically. A neighbouring
  // restriction is not a substitute: fix-portal's "never touch any other company"
  // bounds WHICH company it edits and would stay green if the prompt gained a
  // "submit the application" line.
  const clauses = {
    pdf: /Do not submit anything anywhere/i,
    evaluate: /NEVER submit an application/i,
    research: /never submit, send, or click Apply/i,
    "fix-portal": /do not submit, send, or click Apply/i,
  };
  for (const [kind, pattern] of Object.entries(clauses)) {
    assert.match(buildPrompt({ kind, ...ARGS }), pattern, `${kind} must carry a direct no-submission clause`);
  }
});

test("buildPrompt: fix-portal is additionally scoped to one company and one file", () => {
  // Separate from the submission rule above, because it answers a different
  // question: this kind holds Write, Edit and Bash, so the blast radius of a
  // successful injection is every other tracked company plus any file it can reach.
  const prompt = buildPrompt({ kind: "fix-portal", ...ARGS });

  assert.match(prompt, /Never touch any other company/i);
  assert.match(prompt, /edit no file other than portals\.yml/i);
});

test("buildPrompt: research is read-only by tools as well as by instruction", () => {
  // Belt and braces: the clause above is prompt-level, and the scope backs it by
  // denying every write-capable tool. Neither alone is the whole guarantee.
  assert.equal(grantsWriteCapability(toolScopeFor("research")), false);
  assert.match(buildPrompt({ kind: "research", ...ARGS }), /report:/i);
});

test("isShellSafeCompanyName: allows real company names", () => {
  // Given names the scanner and portals.yml legitimately contain
  for (const name of ["Acme Corp", "Nestlé S.A.", "AT&T", "Foo (EU)", "Zeta+Co", "Bar/Baz", "O'Neill Ltd"]) {
    // Then they pass, so the guard cannot break a legitimate fix-portal run
    assert.equal(isShellSafeCompanyName(name), true, name);
  }
});

test("isShellSafeCompanyName: refuses anything that could close the quote", () => {
  // Given the fix-portal prompt interpolates this into `--add "<company>"` for a
  // kind that holds Bash, and company names can come from public ATS listings
  for (const name of ['x";true`;', "a$(id)", "a`id`", "a|b", "a&&b", "a;b", "a\nb", 'a" ; rm -rf ~ ; "b']) {
    // Then each is refused — the route turns this into a 400 rather than rewriting
    assert.equal(isShellSafeCompanyName(name), false, name);
  }
  // ...as are the degenerate inputs
  assert.equal(isShellSafeCompanyName(""), false);
  assert.equal(isShellSafeCompanyName("x".repeat(81)), false);
  assert.equal(isShellSafeCompanyName(undefined), false);
});

// ── the tracker-additions TSV row (#1298, #3517) ────────────────────────────
//
// The web is a WRITER of batch/tracker-additions/*.tsv, not just a reader of the
// tracker. merge-tracker accepts 9 fields forever, and accepts HEADERLESS files
// forever, so a stale template can never go red — it just silently leaves every
// web-evaluated job out of the URL dedup, and on the ingest path where score and
// status have to be told apart by content. Nothing else in this repo can catch
// that, which is why it is asserted here.

/** The two example lines the evaluate prompt tells the agent to write. */
function exampleTsvLines(prompt) {
  const lines = prompt.split("\n").filter((l) => l.includes("\t"));
  assert.equal(lines.length, 2, `the evaluate prompt must show a header line and one data line, got ${lines.length}`);
  return { header: lines[0].trim().split("\t"), fields: lines[1].trim().split("\t") };
}

/** The example DATA row the evaluate prompt tells the agent to append. */
function exampleTsvRow(prompt) {
  return exampleTsvLines(prompt).fields;
}

test("buildPrompt: the evaluate prompt's TSV row carries all 10 fields, url last", () => {
  // Given an evaluate run
  const prompt = buildPrompt({ kind: "evaluate", input: "https://acme.com/jobs/7", memory: "", today: "2026-08-04" });
  const fields = exampleTsvRow(prompt);

  // Then the row has the 10 fields merge-tracker reads, with the posting URL last
  assert.equal(fields.length, 10, `expected 10 tab-separated fields, got ${fields.length}: ${JSON.stringify(fields)}`);
  assert.match(fields[9], /posting URL/i, "the 10th field must be the posting URL");
  // ...and the prose agrees, so the agent is not told "9" while shown 10
  assert.match(prompt, /10 TAB-separated columns/);
});

test("buildPrompt: the evaluate prompt shows a header row, labelled for merge-tracker (#3517)", () => {
  // Given the header is what lets merge-tracker resolve fields by NAME instead
  // of telling score from status by content — a discrimination with an
  // undecidable case (`—` is both a score sentinel and a status)
  const prompt = buildPrompt({ kind: "evaluate", input: "https://acme.com/jobs/7", memory: "", today: "2026-08-04" });
  const { header, fields } = exampleTsvLines(prompt);

  // Then the labels are the ones tracker-aliases.json knows, in step with the
  // data row beneath them. These are lowercase canonical names on purpose: the
  // alias table is matched case-insensitively, but an agent copies what it sees.
  assert.deepEqual(header, [
    "num", "date", "company", "role", "status", "score", "pdf", "report", "notes", "url",
  ]);
  assert.equal(header.length, fields.length, "header and data row must have the same field count");
  // ...and the prose tells the agent to write BOTH lines, since a data row alone
  // is still accepted and would silently fall back to the content-sniffing path
  assert.match(prompt, /HEADER row/);
  assert.match(prompt, /resolves every field by NAME/i);
});

test("buildPrompt: the evaluate prompt demands an EMPTY url field, never a placeholder", () => {
  // Given merge-tracker's parseTsvExtras drops "N/A"/"-" precisely so they can't
  // be misread as the row's LOCATION, and an unconditional template is one an
  // agent actually follows
  const prompt = buildPrompt({ kind: "evaluate", input: "https://acme.com/jobs/7", memory: "", today: "2026-08-04" });

  // Then the instruction says to write all 10 fields and leave the last empty
  assert.match(prompt, /ALWAYS write all 10 fields/i);
  assert.match(prompt, /EMPTY if there is no posting URL/i);
  assert.match(prompt, /never "N\/A"/i);
});

// ── the posted: segment (#2692) ─────────────────────────────────────────────
//
// The dashboard's POSTED column parses this out of the tracker's Notes cell.
// The date is interpolated by the server from what the scanner recorded, never
// requested from the agent: modes/oferta.md is explicit that a guessed date is
// worse than an absent one, because the column renders absent as `—` and would
// render an invented one as a fresh requisition.

test("buildPrompt: a known posting date becomes its own trailing segment", () => {
  const prompt = buildPrompt({ kind: "evaluate", input: "https://acme.com/jobs/7", memory: "", today: "2026-08-14", postedAt: "2026-08-07" });
  const fields = exampleTsvRow(prompt);

  assert.equal(fields.length, 10, "the row must still carry all 10 fields");
  // Canonical form, from the regex that CONSUMES it: separator-anchored `; `,
  // label, colon, ISO date. A mid-sentence mention is deliberately not metadata.
  assert.match(fields[8], /; posted: 2026-08-07$/);
});

test("buildPrompt: no known date writes NO segment, never a guess", () => {
  for (const postedAt of [undefined, null, "", "unknown", "7 Aug 2026", "2026-8-7", "1999-01-01"]) {
    const prompt = buildPrompt({ kind: "evaluate", input: "https://acme.com/jobs/7", memory: "", today: "2026-08-14", postedAt });
    const fields = exampleTsvRow(prompt);
    assert.equal(fields.length, 10, `field count changed for ${JSON.stringify(postedAt)}`);
    assert.ok(!/posted:/.test(fields[8]), `wrote a posted segment for ${JSON.stringify(postedAt)}: ${fields[8]}`);
  }
});

test("buildPrompt: the row without a date is byte-identical to before the feature", () => {
  // The segment is the ONLY difference between the two prompts, so a run with no
  // recorded date cannot drift from what the CLI has always produced.
  const withDate = buildPrompt({ kind: "evaluate", input: "u", memory: "", today: "2026-08-14", postedAt: "2026-08-07" });
  const without = buildPrompt({ kind: "evaluate", input: "u", memory: "", today: "2026-08-14" });
  assert.equal(withDate.replace("; posted: 2026-08-07", ""), without);
});

// ── language.modes_dir / language.output ─────────────────────────────────────
//
// profile.yml's language settings were WRITE-ONLY on the web path: the settings
// UI saved language.modes_dir (India → modes/hi) but the evaluate prompt always
// hardcoded modes/oferta.md, so a web-triggered evaluation silently ignored the
// configured market. Every assertion below fails without the fix.

const DE = { output: "de", modesDir: "modes/de", evalModeFile: "modes/de/angebot.md" };

test("buildPrompt: evaluate reads the MARKET's evaluation mode, not always oferta.md", () => {
  const prompt = buildPrompt({ kind: "evaluate", ...ARGS, lang: DE });
  assert.match(prompt, /Read modes\/de\/angebot\.md and follow it EXACTLY/);
  assert.doesNotMatch(prompt, /Read modes\/oferta\.md/);
});

test("buildPrompt: evaluate still reads oferta.md when no market is configured", () => {
  const prompt = buildPrompt({ kind: "evaluate", ...ARGS });
  assert.match(prompt, /Read modes\/oferta\.md and follow it EXACTLY/);
});

test("buildPrompt: the output language is stated explicitly in the prompt", () => {
  // A headless one-shot prompt cannot read AGENTS.md the way the interactive
  // CLI does, so the composition rule has to be in the prompt itself.
  const prompt = buildPrompt({ kind: "evaluate", ...ARGS, lang: DE });
  assert.match(prompt, /Write all human-facing output in "de"/);
});

test("buildPrompt: a configured market also points the agent at its _shared.md", () => {
  const prompt = buildPrompt({ kind: "evaluate", ...ARGS, lang: DE });
  assert.match(prompt, /modes\/de\/_shared\.md/);
});

test("buildPrompt: the default configuration adds no market note", () => {
  // English/global must not be told to read modes/_shared.md for "this
  // market's vocabulary" — there is no market, and the line would be noise.
  const prompt = buildPrompt({ kind: "evaluate", ...ARGS });
  assert.match(prompt, /Write all human-facing output in "en"/);
  assert.doesNotMatch(prompt, /this market's vocabulary/);
});

test("buildPrompt: the language directive is not limited to the evaluate prompt", () => {
  // language.output governs human-facing prose generally, not only the report.
  //
  // Scope note: pdf and fix-portal are left out on purpose. pdf's prompt ends on
  // an "EXACTLY one final line" contract the directive would have to be threaded
  // around, and fix-portal repairs a YAML entry with no prose for an output
  // language to govern. Happy to send pdf as a follow-up.
  for (const kind of ["evaluate", "research"]) {
    assert.match(
      buildPrompt({ kind, ...ARGS, lang: DE }),
      /Write all human-facing output in "de"/,
      `kind ${kind} lost the language directive`,
    );
  }
});

// ── the saved advert and the employer's own posting (ticket 2e) ──────────────
//
// On 22 September 2026 the dashboard's score button was pressed on the Fred
// Perry row. The worker answered "posting unreadable behind Indeed's login
// wall; nothing evaluated or written" — while the advert it needed had been
// saved by that morning's scan and named on the row itself. The prompt built
// from the URL alone, so the file was never mentioned.
//
// The fixture is that exact pipeline.md line, read through the SAME parser the
// dashboard uses, so these tests cover the whole path from the file to the
// prompt rather than a hand-built object that agrees with itself.

const FRED_PERRY_LINE =
  "- [ ] https://uk.indeed.com/viewjob?jk=1505caa519d66118 | Fred Perry | Product Manager - Menswear | London WC1X 0AA | jd: local:jds/fred-perry-product-manager-menswear-eea864f490.md | route: review | fit: REVIEW (the stretch grade and the specialist requirement pull against the consumer-brand pass) | note: local:jds/fred-perry-product-manager-menswear-eea864f490.md";

const FRED_PERRY_JD = "jds/fred-perry-product-manager-menswear-eea864f490.md";

/** The prompt an evaluate run of that row builds, given what the server knows. */
function fredPerryPrompt(extraFacts = {}) {
  const row = parseInboxLine(FRED_PERRY_LINE);
  return buildPrompt({
    kind: "evaluate",
    input: row.url,
    memory: "",
    today: "2026-09-22",
    advert: { jd: row.jd, company: row.company, ...extraFacts },
  });
}

test("buildPrompt: the Fred Perry row's saved advert is named as the text to read", () => {
  const prompt = fredPerryPrompt();

  // The file the scan saved, by its path, as the source of the advert text
  assert.ok(prompt.includes(FRED_PERRY_JD), "the prompt must name the saved advert file");
  assert.match(prompt, /ALREADY ON THIS MACHINE/);
  // ...and the fetch sentence no longer sends the worker to the URL for the text
  assert.match(prompt, /Take the posting text from the saved advert/);
});

test("buildPrompt: an unreadable posting page no longer stops the evaluation", () => {
  // This is the regression that cost the run: "could not read the page" was
  // treated as "nothing to evaluate". Liveness is reported, never a veto —
  // only evidence the posting is CLOSED stops Block A.
  const prompt = fredPerryPrompt();

  assert.match(prompt, /do not let it stop you/i);
  assert.match(prompt, /login wall/i);
  assert.match(prompt, /Verification: unconfirmed \(batch mode\); advert read from the saved copy/);
  assert.match(prompt, /Only evidence that the posting is CLOSED[^\n]*stops the evaluation/);
});

test("buildPrompt: with a saved advert, the WebFetch refusal does not apply", () => {
  // Upstream's #2789 refusal stops the evaluation when WebFetch returns a login
  // wall. With the text already saved, 1a says a login wall must not stop it;
  // both in one prompt would be two orders that contradict each other.
  const withAdvert = fredPerryPrompt();
  assert.doesNotMatch(withAdvert, /STOP BEFORE BLOCK A/);
  const without = buildPrompt({ kind: "evaluate", input: "https://uk.indeed.com/viewjob?jk=1", memory: "", today: "2026-09-22" });
  assert.match(without, /STOP BEFORE BLOCK A/);
});

test("buildPrompt: an aggregator row with a known careers page is sent to the employer", () => {
  // Fred Perry has no board line in portals.yml yet — the Tiers chat adds its
  // Teamtailor board. This is the prompt the same row builds once it does.
  const prompt = fredPerryPrompt({ employerSite: "https://careers.fredperry.com" });

  assert.match(prompt, /check THERE for the same title/);
  assert.ok(prompt.includes("https://careers.fredperry.com"), "the employer's careers page must be named");
  assert.ok(prompt.includes("Fred Perry's"), "the block must name the company");
  // the found URL goes on the report header's URL line...
  assert.match(prompt, /gives you the URL to write on the report's `\*\*URL:\*\*` line/);
  // ...and NOT into the tracker's dedup field, which stays the row's own URL
  assert.match(prompt, /tracker row's last field stays the posting URL above/);
});

test("buildPrompt: with a saved advert, the employer page settles the LINK, never the text", () => {
  // Two instructions that both claim to name the posting is how a worker ends
  // up scoring one page and citing another. With 1a supplying the text, 1b is
  // confined to liveness and the URL.
  const prompt = fredPerryPrompt({ employerSite: "https://careers.fredperry.com" });

  assert.match(prompt, /THIS IS ABOUT THE LINK, NOT THE TEXT/);
  assert.match(prompt, /the saved advert in 1a stays what you read and score/);
  assert.match(prompt, /nothing on the employer's page changes a score/);
  // the one way the employer page CAN change the outcome
  assert.match(prompt, /shows the role closed, withdrawn or gone, THAT is evidence the posting is closed/);
  assert.match(prompt, /follow modes\/oferta\.md's rule for a dead posting/);
  // and not finding it proves nothing
  assert.match(prompt, /cannot find it there, that is not evidence of anything/);
  // the pre-review wording, which competed with 1a, is gone
  assert.doesNotMatch(prompt, /use it as the posting/);
  assert.doesNotMatch(prompt, /preferring it over the aggregator listing/);
});

test("buildPrompt: a homepage is not called a careers page", () => {
  // data/companies.tsv's `website` column holds lupapets.com, hook.co — a
  // marketing homepage. "Look here for the same title" is the wrong order there.
  const site = buildPrompt({
    kind: "evaluate",
    input: "https://uk.indeed.com/viewjob?jk=1",
    memory: "",
    today: "2026-09-22",
    advert: { company: "Lupa", employerSite: "https://lupapets.com", employerSiteKind: "site" },
  });
  assert.match(site, /Lupa's own site is https:\/\/lupapets\.com — find its careers or jobs page and check THERE/);
  assert.doesNotMatch(site, /own careers page is https:\/\/lupapets\.com/);

  // an unmarked page keeps the careers-page wording: portals.yml is the only
  // other source, and every one of its entries is a careers page
  const careers = buildPrompt({
    kind: "evaluate",
    input: "https://uk.indeed.com/viewjob?jk=1",
    memory: "",
    today: "2026-09-22",
    advert: { company: "Lupa", employerSite: "https://jobs.ashbyhq.com/lupapets", employerSiteKind: "careers" },
  });
  assert.match(careers, /Lupa's own careers page is https:\/\/jobs\.ashbyhq\.com\/lupapets — check THERE for the same title/);
});

test("buildPrompt: no known careers page, no employer-first block", () => {
  // Fred Perry as the file stands today. A block naming no page would be an
  // instruction to go and guess one.
  const prompt = fredPerryPrompt();

  assert.doesNotMatch(prompt, /check THERE for the same title/);
  assert.doesNotMatch(prompt, /aggregator listing/);
  // ...and with only one block, it is 1a, not a 1b with no 1a above it
  assert.match(prompt, /\n1a\. THE ADVERT TEXT/);
  assert.doesNotMatch(prompt, /\n1b\./);
});

test("buildPrompt: an aggregator row with no saved advert is still sent to the employer", () => {
  // The row this helps most: nothing saved, and a page that will not answer a
  // headless read. The employer's own posting is the only way through, so the
  // block must not depend on there being a saved copy.
  const prompt = buildPrompt({
    kind: "evaluate",
    input: "https://uk.indeed.com/viewjob?jk=deadbeef",
    memory: "",
    today: "2026-09-22",
    advert: { company: "Fred Perry", employerSite: "https://careers.fredperry.com" },
  });

  assert.match(prompt, /check THERE for the same title/);
  // with nothing saved, the employer page IS the posting — that wording stays
  assert.match(prompt, /read that page and use it as the posting/);
  assert.doesNotMatch(prompt, /THIS IS ABOUT THE LINK, NOT THE TEXT/);
  // it is the only extra block, so it takes the first label
  assert.match(prompt, /\n1a\. The posting URL above is an aggregator listing/);
  assert.doesNotMatch(prompt, /ALREADY ON THIS MACHINE/);
  // ...and step 1 still sends it to WebFetch, because there is no saved copy
  assert.match(prompt, /Use WebFetch to read the posting/);
});

test("buildPrompt: with both blocks they are labelled 1a then 1b", () => {
  const prompt = fredPerryPrompt({ employerSite: "https://careers.fredperry.com" });
  assert.match(prompt, /\n1a\. THE ADVERT TEXT/);
  assert.match(prompt, /\n1b\. The posting URL above is an aggregator listing/);
  // and the numbered steps that follow are untouched
  assert.match(prompt, /\n2\. Persist the result CANONICALLY/);
  assert.match(prompt, /\n3\. NEVER submit an application/);
});

test("buildPrompt: an employer's own posting is never sent looking for itself", () => {
  const prompt = buildPrompt({
    kind: "evaluate",
    input: "https://job-boards.greenhouse.io/capitalontap/jobs/4",
    memory: "",
    today: "2026-09-22",
    advert: { jd: "local:jds/capital-on-tap-pm-abc1234567.md", company: "Capital on Tap", employerSite: "https://job-boards.greenhouse.io/capitalontap" },
  });

  assert.ok(prompt.includes("jds/capital-on-tap-pm-abc1234567.md"), "the saved advert still applies");
  assert.doesNotMatch(prompt, /check THERE for the same title/, "a direct board URL is not an aggregator copy");
});

test("buildPrompt: a row with no saved advert builds the prompt it always did", () => {
  // The whole feature is additive: nothing about a row without a `jd:` field
  // may change, or every existing evaluation quietly drifts.
  const url = "https://jobs.acme.com/roles/1";
  const before = buildPrompt({ kind: "evaluate", input: url, memory: "", today: "2026-09-22" });
  for (const advert of [undefined, {}, { company: "Acme" }, { jd: "", company: "Acme", employerSite: "https://acme.com" }]) {
    const after = buildPrompt({ kind: "evaluate", input: url, memory: "", today: "2026-09-22", advert });
    assert.equal(after, before, `advert ${JSON.stringify(advert)} changed a prompt that has no advert to name`);
  }
});

test("buildPrompt: the evaluate prompt still states VERDICT once with an advert", () => {
  // job-store.tsx parses that final line; two extra numbered steps must not
  // introduce a second match.
  const mentions = fredPerryPrompt({ employerSite: "https://careers.fredperry.com" }).match(/VERDICT:/g) ?? [];
  assert.equal(mentions.length, 1);
});

test("localJdPath: accepts every capture writer's filename", () => {
  // AGENTS.md, "JD captures": several writers coexist and none is canonical.
  assert.equal(localJdPath(`local:${FRED_PERRY_JD}`), FRED_PERRY_JD);
  assert.equal(localJdPath(`  local:${FRED_PERRY_JD}  `), FRED_PERRY_JD);
  // archive-posting.mjs saves a PDF, with the report number in front
  assert.equal(localJdPath("local:jds/064-2026-09-22_fred-perry_product-manager.pdf"), "jds/064-2026-09-22_fred-perry_product-manager.pdf");
  assert.equal(localJdPath("local:jds/acme role.txt"), "jds/acme role.txt");
});

test("localJdPath: refuses a path that could climb out of jds/", () => {
  // The value reaches this code from a scanned posting, so a path that leaves
  // jds/ or names another file must never become "read this file".
  for (const bad of [
    "local:../cv.md",
    "local:jds/../cv.md",
    "local:jds/..%2fcv.md".replace("%2f", "/"),
    "local:/etc/passwd",
    "local:jds/nested/x.md",
    "local:jds\\..\\cv.md",
    "local:jds/.env.md",
    "local:jds/x.yml",
    "local:jds/x",
    "jds/x.md",
    "https://example.com/x.md",
    "",
    undefined,
    null,
  ]) {
    assert.equal(localJdPath(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("isAggregatorUrl: matches the host, not the string", () => {
  for (const url of [
    "https://uk.indeed.com/viewjob?jk=1505caa519d66118",
    "https://indeed.com/viewjob?jk=1",
    "https://www.linkedin.com/jobs/view/123",
    "https://www.glassdoor.co.uk/job-listing/x",
  ]) {
    assert.equal(isAggregatorUrl(url), true, url);
  }
  for (const url of [
    "https://careers.fredperry.com/jobs/8414770-product-manager-menswear",
    "https://job-boards.greenhouse.io/capitalontap",
    // the aggregator's name inside a path or a query is not its host
    "https://jobs.acme.com/apply?ref=indeed.com",
    "https://notindeed.com/jobs/1",
    "not a url",
    "",
  ]) {
    assert.equal(isAggregatorUrl(url), false, String(url));
  }
});

// ── the evaluate prompt must not out-source its own honesty (#2789) ──────────
// WebFetch answers 200 with a login wall, an expired ad or a bot challenge, and
// none of those announce themselves. Handed that text, an agent grades it: the
// result is a confident A–F report about a login screen, indistinguishable in
// shape from a real one. Nothing downstream can catch it either — a JD-archive
// validator that measures LENGTH accepts a wall's text, and comparing the
// archive against the report's own keywords compares two outputs the same agent
// wrote from the same bad page. So the refusal has to be instructed here.

test("buildPrompt: evaluate refuses to score a page that is not the posting", () => {
  const prompt = buildPrompt({ kind: "evaluate", input: "https://example.com/jobs/9", memory: "", today: "2026-09-04" });
  for (const wall of ["login", "404", "paywall", "bot challenge"]) {
    assert.ok(
      prompt.toLowerCase().includes(wall),
      `the evaluate prompt must name "${wall}" as a case to stop on, or the agent grades whatever came back`,
    );
  }
  // The refusal must POINT AT the core's rule, not restate a rule of its own —
  // the web is a view over the modes, and a second policy here would be the
  // thing that drifts. modes/oferta.md step 3 owns "stop before Block A".
  assert.ok(/STOP BEFORE BLOCK A/i.test(prompt), "the instruction must be to stop, not merely to note it");
  assert.ok(
    /posting appears closed/i.test(prompt),
    "it must invoke the mode file's existing rule by name rather than inventing a parallel one",
  );
  assert.ok(
    /do not generate an evaluation, a report or a CV/i.test(prompt),
    "the consequence must match modes/oferta.md step 3, not a softer web-only version",
  );
});

test("buildPrompt: evaluate does not enumerate the report's sections", () => {
  // The section list lives in modes/oferta.md. A copy of it here cannot help —
  // `follow it EXACTLY` already carries the instruction — and can only go stale,
  // which it had: the old text named "blocks A–F, G posting-legitimacy, and the
  // Machine Summary" while the template also requires Risk Summary, H) Draft
  // Application Answers and Keywords extracted. Nothing failed, which is why it
  // survived. This pins that the subset does not come back.
  const prompt = buildPrompt({ kind: "evaluate", input: "https://example.com/jobs/9", memory: "", today: "2026-09-04" });
  assert.ok(!/blocks?\s+A[–-]F/i.test(prompt), "the prompt must not name a subset of the mode file's sections");
  assert.ok(/EVERY section its report template specifies/i.test(prompt), "it must defer to the mode file for the section set");
});
