---
description: Verify a change actually works in the running app. A hard gate before merge.
allowed-tools: Bash, Read
---

Verify against the running app, not against the diff. A run that reports success is not proof.

1. Tests: `npm test` and `npm run typecheck` in `web/` both clean on the branch. If either fails, it was not ready.
2. Start the app and press the button the spec named. Do it here; never tell Stelios to press it and report back.
3. Read back the file the run was supposed to write, and state the evidence: the path, the line, the exact string matched. For a report, that means the report file *and* the tracker row in `data/applications.md` that links to it — the Hook re-run on 3 September 2026 wrote its report and then hung for twelve hours without the row, and the proof only looked for the report.
4. For a CV: count the pages in the rendered PDF, and read the run log for the fact gate's verdict and the mirroring check. A three-page PDF is a failure even when every other check passed.
5. Read the run log for the guard rails: no sub-agent was dispatched, web research stayed inside five queries, and a kind that read an advert held no write tool.
6. Anything that depends on outside behaviour — a board's feed, an Apify actor's output shape, a page behind Cloudflare — is tested live against that thing. If it genuinely cannot be tested here, say so and flag it. Never report it verified.
7. Report the evidence. If anything does not match intent, diagnose before declaring done.
