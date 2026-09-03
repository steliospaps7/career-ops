---
description: Scope a change before building. Produces a written change spec and creates the branch.
allowed-tools: Bash, Read, Write
---

No building until the spec is agreed. Discuss with Stelios until it converges, then write it. Capture:

- What: the change, one or two lines.
- Why: the goal or the problem, stated in terms of the job search rather than the code.
- Success criteria: how we know it is done.
- How to verify: which button gets pressed, which file gets read back afterwards, and what that file has to contain. A run that reports success is not evidence.
- What it must never do: the guard rails this change has to keep. Every kind that reads a job advert runs with no write tool, because the advert is text written by a stranger and lands in the agent's context. No sub-agents. Web research capped at five queries.
- Risk tier: 0 (build and verify on a branch, the chat does it freely), 1 (merging to the fork's `main`, Stelios reads the diff first), 2 (anything that spends or sends — an evaluation run, a paid reader, a letter to a company; Stelios presses the button, and nothing is ever submitted by the tool).
- Upstreamable: is this a correctness fix the maintainer would take? If so it also goes to `career-ops-hq/career-ops` as its own pull request, and one fewer line has to survive the weekly merge. Feature proposals go to their Discussion #156 instead.
- If it adds a run kind, which of the seven edits it needs: the name in `KNOWN_KINDS`, its prompt in `web/src/lib/run-prompts.mjs`, its precondition file, its time limit, its entry in the action registry marked spend or write, the button, and the proof. The proof checks the last step, never the first.

Write the spec to `specs/<short-name>.md`, then create branch `change-<short-name>` off `main`. Then hand to /build.
