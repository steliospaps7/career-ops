# Codex's brief for D2, the fit judgement, 13 September 2026

Pasted by Stelios into the Planner chat at about 21:00. Verbatim below; the dispatch
`dispatch-ticket-D2.md` beside this file is derived from it.

Proceed with D2 using my Claude Code subscription. Do not use a direct API, OpenRouter, API keys or separately billed model calls.

Use Sonnet 5 with High effort as the proposed default. Before choosing permanently, compare its decisions against Opus 5 with Medium effort on the same small set of stored adverts. Confirm those model and effort settings are supported; do not silently substitute another model.

Recheck current implementation status and coordinate with existing work.

The smallest proposed change is a lightweight fit assessment in scan.mjs, inside main(), after routeDetail(...) but before countRoute, sourceLedger.keep and newOffers.push. Verify the location against current code.

Every genuinely new row surviving the existing filters must receive an assessment before reaching the normal Inbox. Company tier determines attention, not whether suitability is checked. Preserve explicit user exceptions.

Return PASS, SKIP or REVIEW, with one short reason and a supporting advert excerpt. No full scoring report, cover letter or fresh browsing is needed.

PASS enters the Inbox. SKIP is recorded once with its reason and identity so subsequent scans do not repeatedly assess it. Unreadable adverts, failed calls and invalid responses go to REVIEW, never silently to PASS. Keep existing locking, history and run counters consistent.

For the model comparison, use identical criteria, adverts and output requirements. Run each model independently without showing it the other model's answers. Include: 1. Deliveroo's Care Operations Manager - French. 2. The same advert with the French requirement removed. 3. Perlego's Product Manager - Platform Experience. 4. Relevant AI workflow and deployment roles. 5. Unsuitable senior or specialist roles with no numerical experience bar. 6. Suitable roles that merely mention contact centres as their customers.

The Deliveroo advert actually requires two years in customer-service operations. Its main mismatch is running outsourced contact-centre teams. Removing French should not turn it into a fit.

Judge disagreements against the advert and my criteria. Do not assume Opus is correct because it is larger. Compare missed unsuitable jobs, wrongly rejected suitable jobs, evidence accuracy and response time. Report subscription usage only where measurable; do not invent per-advert dollar costs.

Choose Sonnet if its decisions hold up. Recommend Opus or selective escalation only if the comparison shows a meaningful benefit. Use bounded concurrency and respect subscription limits.

Then implement the smallest reviewed change and test the actual scan path using temporary data. Prove that rejected jobs never enter Pending, suitable jobs survive, failures remain reviewable, and repeated scans do not duplicate decisions.

Do not clean the existing live queue as part of this change without showing the proposed changes first. Do not submit applications.

Report the model comparison, chosen configuration, changed files, commit, tests and remaining limitations. Codex will independently review the result.

## Design, from the Planner's dispatch

Appended by the Career Implementer for D2b on 14 September 2026: Part two of the Planner's
dispatch for D2b, verbatim. The model and effort come from D2a's log entry of 14 September:
`claude-opus-5` at `--effort medium`, for every row, no escalation.

One function, `assessFit`, called in `main()` after `routeDetail(...)` and before `countRoute`, `sourceLedger.keep` and `newOffers.push`; verify that location against the current code and say in the log if it moved. It runs for every genuinely new row that survived the free filters, the advert gate and the tracker dedup, whatever the company's tier: the tier decides attention, not whether fit is checked. Inputs: the stored advert text (the row's `description` or the file its `jdPath` names), company, title, location, and the criteria. Output: PASS, SKIP or REVIEW with a reason and an excerpt.

- PASS: the row is queued as today, with `fit: PASS` added to the line.
- SKIP: **the SKIP path ships behind its own switch, `fit_gate.skip: true|false`, off until Stelios's word; with it off a SKIP verdict is queued as `route: review` with `fit: SKIP (<reason>)` and nothing leaves the Inbox.** With it on, recorded once, so it is never assessed again: a ticked line in the Processed block, `skipped (fit: <reason>, <date>)`, cells kept, and its URL in `data/scan-history.tsv` with a status the dedup honours, so the next scan sees it as seen. Codex's words: rejected jobs never enter Pending, and repeated scans do not duplicate decisions.
- Every run's summary lists each SKIP and REVIEW title with its one-line reason, printed in the scheduled run's log, so a model's verdict is never invisible to him.
- The verdict shows on the dashboard Inbox card, because that is where he reads the queue and the label-only week depends on it. Today `readInbox` in `web/src/lib/career-ops.ts` parses every labelled segment and keeps only `posted:`; the dashboard shows no run summary. Surface `fit:` and `route:` on `InboxJob` and render them on the card in `web/src/components/inbox/inbox-triage.tsx` as one short line, `review: <reason>` or `PASS`, nothing else. Read `web/AGENTS.md` first; this is a view over the file, no second engine, no new write path. One test in the web suite that a line carrying `fit: SKIP (reason)` reaches the card with that text.
- REVIEW: queued with `route: review` and `fit: REVIEW (<reason>)`. An unreadable advert, a call that fails, a timeout, an answer that is not the one-line JSON, or an excerpt not found in the advert all go to REVIEW, never to PASS.
- Explicit exceptions: a company under `always_allow` in `portals.yml` is never SKIPped by the fit gate; it is queued with the verdict noted. A `triage:` segment written by hand is never overwritten.
- One shared limiter across the whole sweep, at most 3 calls in the air, because `main()` already runs sources in parallel through `parallelFetch` (about line 4527) and a per-source bound would multiply; a per-call timeout; a per-run ceiling on rows assessed and a total time budget for the gate, both in `fit_gate`, with rows beyond either ceiling queued as REVIEW, so a big scan never crosses the scheduled run's 120-minute stale-lock rule. One summary line per run: assessed, PASS, SKIP, REVIEW, failed calls, ceiling hits. The run counters in `data/scan-runs.tsv` and the source ledger stay consistent: a SKIP counts as a drop with its own reason. The pipeline lock and the history writer are the existing ones; add no second lock.
- An off switch that ships off: the gate runs only when `config/profile.yml` carries `fit_gate: enabled: true`, with `model` and `effort` beside it, read once per run. An absent key means off, so no other user of this public fork and no scheduled run shells out to `claude` unasked; the Builder turns it on in his own `config/profile.yml` (gitignored) and the log records that the shipped default is off. With it off the scan behaves exactly as before.
- The standalone pass `--read-pipeline --gate` does not assess rows in this ticket; the existing queue was triaged by hand on 13 September and cleaning it is the Planner's, shown to Stelios first. Say in the log that the pass leaves `fit:` untouched.
