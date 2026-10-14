---
description: Ship a verified change. Open the pull request on the fork and record it. Stelios merges.
allowed-tools: Bash, Read, Edit
---

Only after /verify is clean.

1. Check nothing personal is staged. `git status --short` must show no `cv.md`, no `portals.yml`, no `config/profile.yml`, no `modes/_*.md`, and nothing under `data/`, `reports/` or `output/`. They are all gitignored; a stray `git add -f` is the only way one gets in, and it would be public.
2. Push the branch and open the pull request on `steliospaps7/career-ops` with `gh pr create`. The body carries what changed, what proves it works — the file path and the line, from /verify — and what it must never do. Stelios merges; the chat does not. Merging to `main` is tier 1.
3. Record. Append a dated entry to `~/Documents/Claude Context/projects/career/career-ops/live/build-log.md` saying what is now live, what is still pending, and what bit. Do it the same hour, not at the end of the session; sessions crash and the log is the memory.
4. Run `~/Documents/Claude Context/projects/career/career-ops/sync-backup.sh` so the job-search files reach the backup, then commit them from the Claude Context folder, staging only that folder's own paths.
5. If the change is a correctness fix the maintainer would want, open the second pull request against `career-ops-hq/career-ops` off a branch cut from `upstream/main`, and say in the body that it came from a fork's use. Every fix they take is one fewer line for the weekly merge to carry.
6. Tell Stelios what now works, in one line, and what to press to see it.

**One pull request, one merge.** Once it is merged the branch is closed: pushing more commits to it does nothing and the work never reaches `main`. Any change after a merge is a new branch off `main` and a new pull request. Before pushing a follow-up to any branch not created this session, run `gh pr view <branch> --json state` and push only if it is OPEN.
