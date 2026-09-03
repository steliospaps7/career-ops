---
description: Build a scoped change on its branch, following the app's own rules.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

Implement the agreed change on its branch. Re-read `web/AGENTS.md` first and hold its three rules while building:

- Orchestrate the core; never reimplement it. The command-line scripts already resolve tracker paths, match tailored CVs and canonicalise statuses. Call them, or mirror them behind a parity test. Two implementations of one rule disagree silently.
- Markdown is the source of truth. `data/applications.md`, `cv.md` and `reports/` are canonical. Status changes go through `/api/status`, which delegates to the root `set-status.mjs`. That is the single write path, and it is single on purpose.
- Nothing is ever submitted automatically. The apply flow fills in and previews; a human presses send. No flag, no test exception.

Four more that are ours:

- A missing file is not a malformed file. Distinguish `ENOENT` from every other failure, or a user's config gets overwritten with the shipped example.
- Logic that deserves a test lives in a plain `.mjs` module so `node --test` imports it with no build step. A component is not a place to put a rule you want to assert.
- Keep it surgical. Every changed line traces to the spec. Adjacent code, comments and formatting stay as they were found.
- Personal files stay out of git. `cv.md`, `config/profile.yml`, `portals.yml`, `data/`, `reports/`, `output/` and `modes/_*.md` are all in `.gitignore`. Read `git status` before every commit and never stage one of them.

Before handing off, run `npm test` and `npm run typecheck` in `web/`. Commit in small, clear commits on the branch. Do not push to `main`. Only with both clean, go to /review.
