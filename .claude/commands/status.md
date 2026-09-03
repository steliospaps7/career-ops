---
description: Cold start. Reconstruct where the career-ops build stands and give the single next action.
allowed-tools: Bash, Read
---

Reconstruct the current state, then state the one next action. Do not start work; just orient.

1. Read the build log at `~/Documents/Claude Context/projects/career/career-ops/live/build-log.md` — it is the memory, sessions are not.
2. Git on this fork: current branch, `git status -s`, `git log --oneline -6`, whether the branch is ahead of `main`, and `gh pr list --state open`.
3. Upstream: `git fetch upstream` then `git log --oneline HEAD..upstream/main | wc -l`, and whether a "Sync upstream" pull request is already open.
4. The search itself: the last line of `data/scan-runs.tsv`, the row count in `data/pipeline.md`, and the newest file in `reports/`.
5. Output, briefly: where we are (branch, what is in flight, what is blocked on Stelios), then THE single next action.
