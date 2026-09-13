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
