# Spec — Ticket 0: the scan runs every day and shows its sources

**Written:** 8 September 2026. Cut from `General Job Search Operating Plan v1`, front 0.
Triage: ready-for-agent.

## Problem Statement

Stelios cannot tell which job boards are being read. The scanner writes one total per run, so
"twenty-one sources are configured" and "twenty-one sources were read" look identical from the
outside, and the question he keeps asking has had no answer for a week.

Three things sit under that. The scan works from a terminal and fails from a Claude chat, because
the chat's sandbox blocks outbound network, and every failed run since 3 September was that rather
than a broken tool. The app carries a Scan button that reads four applicant systems and never opens
the source list, so the job boards, the nine venture portfolio boards and the two paid readers only
ever run when he opens a terminal, which he does not do daily. And seven search queries sit in the
source list marked enabled while no code reads them, so the file overstates its own coverage.

The result is a scan he does not trust and does not run, at the top of a pipeline where everything
else waits on it.

## Solution

One file he double-clicks each morning, beside the one that opens the app. It runs the real scan
outside any sandbox with the paid readers included, prints a line for every source saying what it
found, what it kept and where the rest went, writes those lines to a log he can read later, and
opens the app on the pipeline.

The source list stops lying: queries nothing reads are removed, a board that has a working reader
is switched on, and the app's four-system button is labelled as the extra it is.

After this, "which boards were read this morning" is answered by looking at the terminal, and
"which boards were read on Tuesday" by reading one file.

## User Stories

1. As Stelios, I want to start the day's scan by double-clicking one file, so that I never have to open a terminal or remember a command.
2. As Stelios, I want the scan to run outside the sandbox, so that it does not report zero because the network was blocked.
3. As Stelios, I want one line per source as the scan runs, so that I can see progress rather than watch a blank screen.
4. As Stelios, I want each line to name the source, so that I can tell which board produced which roles.
5. As Stelios, I want each line to show how many adverts the source returned, so that I can see a board that has gone quiet.
6. As Stelios, I want each line to show how many survived the filters, so that I can judge whether a source earns its place.
7. As Stelios, I want the reason the rest were removed, so that I can tell a wrong-city board from a wrong-title one.
8. As Stelios, I want a source that returned nothing to say so explicitly, so that silence is never mistaken for absence.
9. As Stelios, I want a source that errored to be named with its error, so that a broken reader is visible the morning it breaks.
10. As Stelios, I want the two paid readers included in the run, so that the daily scan is the whole scan and not a cheap subset.
11. As Stelios, I want to know before the run that it will spend money, so that a paid scan is never a surprise.
12. As Stelios, I want the same per-source lines written to a log, so that I can compare this morning against last Tuesday.
13. As Stelios, I want the log to carry one row per source per run, so that a board's history can be read down a column.
14. As Stelios, I want the existing run-summary file left alone, so that the statistics the app already draws do not break.
15. As Stelios, I want the app to open on the pipeline when the scan finishes, so that the new rows are the first thing I see.
16. As Stelios, I want the app to open only after the scan has finished writing, so that I never read a half-written pipeline.
17. As Stelios, I want the window to tell me plainly if the scan failed, so that I do not think a failed run was an empty one.
18. As Stelios, I want the file to live outside the tool's own folder, so that the weekly upstream merge never conflicts with it.
19. As Stelios, I want sources that nothing reads removed from the configuration, so that the file describes what actually happens.
20. As Stelios, I want the removal recorded with its reason, so that a later session does not helpfully add them back.
21. As Stelios, I want a reader for Jack and Jill, so that a founders'-associate board I want is scanned like any other.
22. As Stelios, I want the Jack and Jill reader to obey the same title, location and age filters, so that it needs no special handling.
23. As Stelios, I want the Jack and Jill reader to fail like every other reader, so that a board outage is an error line and not a crashed scan.
24. As Stelios, I want the app's four-system Scan button labelled as an extra, so that nobody mistakes it for the full scan again.
25. As Stelios, I want the label to say which four it reads, so that the difference is concrete rather than a warning.
26. As Stelios, I want the run to work when a source is switched off, so that turning one off is a one-line edit and not a code change.
27. As Stelios, I want the log at a fixed path outside the tool's folder, so that a run written by one shell is the run I read from another.
28. As a future session, I want the per-source work to sit in the scanner rather than the double-click file, so that it is covered by the test suite.
29. As Stelios, I want the double-click file to hold no logic worth testing, so that there is nothing in it that can be silently wrong.
30. As Stelios, I want the test suite to stay green before anything is pushed, so that the pull request is not the place the problem is found.

## Implementation Decisions

**The scanner keeps the counting; the double-click file keeps none of it.** Every count, reason
and line of output is produced by the scan module, which the suite already covers. The `.command`
file changes directory, runs the scanner unsandboxed with the paid readers enabled, tees output to
the log, waits for exit, and opens the app. It contains no filtering, no parsing and no arithmetic,
because a shell script is the one place in this change with no test seam.

**Per-source counters ride the existing summary object.** The scanner already accumulates run
totals into one counters object handed to the run-summary writer. The change adds a per-source
record alongside, incremented at the same points as the totals, so a new drop reason can never be
counted in one place and missed in the other. No new filtering logic is introduced; this is
bookkeeping on paths that already exist.

**A separate per-source log, not a wider run summary.** The run-summary file is one row per run and
its header is guarded by a drift test that other modules read. Adding columns there would break a
contract for a different shape of data. Per-source rows go to their own file, one row per source per
run, keyed by the run's timestamp so the two join.

**The terminal line.** One line per source, fixed order, padded so the columns read down the screen.
The shape encodes the decision and is therefore given exactly:

```
Lupa                     found 12   kept 3    dropped 9   (title 7, location 1, age 1)
Balderton (portfolio)    found 0    kept 0    —           (no postings returned)
Indeed UK                found 25   kept 2    dropped 23  (title 18, age 5)          [paid]
Jack and Jill            ERROR      board returned 503
```

Sources that cost money are marked, so the spend is visible in the same glance as the yield.

**The seven search queries are deleted, not run.** Nothing executes them: the validator type-checks
that the key is an array and no other module reads it. Building a runner would need a web search per
query, which the fork's process rules forbid twice over, capping web research per mode and barring
sub-agents. On their content they also split cleanly: four are site-restricted searches against
applicant systems the dedicated readers already cover completely, and three are company discovery,
which the operating plan now assigns to a daily discovery run rather than to the scanner. The key is
removed along with the validator branch that only existed to check it, and the reason is recorded in
the source file so it is not re-added.

**Jack and Jill is a new reader on the existing provider contract.** It exposes an id, a fetch and a
detect, is discovered by the same directory scan as the other ninety-four, and returns the same
normalised shape. It maps a posting date, because a reader that omits one silently disables the age
filter for every role it returns.

**The a16z Speedrun reader is switched on.** The tree already carries a complete, tested reader for
Speedrun's public job feed, roughly two hundred portfolio companies with no login, and nothing in
the source list points at it. It goes in as a job board entry, and the existing London location
filter and posting-age limit do the cutting; a small number of London rows is the expected result
and is not a fault. The talent-network sign-up is a separate hand task in the recruiter pack.

**The lock file is ignored.** The lock the fork uses to stop two sessions editing at once sits
untracked in a public repository. It joins the ignore list on the build branch.

**The logs live at a fixed path outside the fork.** The `.command` file tees the terminal output to
`projects/career/career-ops/logs/scan-<date>.log`, and the scanner writes the per-source rows to
`projects/career/career-ops/logs/scan-sources.tsv`, the path passed in by the `.command` file. Both
sit beside the file that starts the run, never under a temporary directory, because the sandboxed
and unsandboxed shells resolve that directory differently and a log written by one is invisible to
the other.

**The run states its cost and starts.** One daily run of the two paid readers costs up to about 90
cents: Indeed at six searches of 25 adverts at half a cent each, up to 75 cents on a day when every
search fills; LinkedIn at the same volume at a tenth of a cent, about 15 cents. About USD 25 a month
at the ceiling. The `.command` file prints that figure as its first line and runs without a
confirmation prompt, so the morning double-click stays one action and the spend is never a surprise.

**The app's Scan button is relabelled, not changed.** Its description gains a sentence naming it as
an extra covering four applicant systems and pointing at the double-click file for the full scan.
No behaviour changes.

## Testing Decisions

A good test here asserts what the scan reports, never how it counted. The counters are internal;
the observable behaviour is the per-source record on the summary object and the rows in the
per-source log. Tests drive the scanner with fixture sources and fixture postings and read those two
outputs. No test asserts on terminal formatting beyond the
fields being present, because column padding is presentation and will change.

**The scanner.** Given two sources and a set of postings that fail different filters, the per-source
record attributes every posting to exactly one source and one reason, and the per-source totals sum
to the run totals. That last assertion is the one that catches a new drop reason added to the totals
and forgotten in the breakdown. A source returning nothing records zero found rather than being
absent. A source that throws records an error and does not abort the run or the other sources.

**The per-source log.** A run appends one row per enabled source, with a header written once when
the file is created, and joins to the run summary on the timestamp. No drift test: the file has one
reader, this ticket, and a guard for a contract nobody else depends on is weight the day does not
have.

**The Jack and Jill reader.** Tested at the provider seam against a recorded response fixture, in the
shape the existing provider tests use, with `a16z-speedrun-talent` as the closest prior art. Assert
the normalised fields including the posting date, an empty board returning an empty array, and a
non-200 response surfacing as an error rather than an empty result.

**The portals validator.** Asserts that a file still carrying the removed key is reported rather than
silently accepted, so an old copy restored from a backup is caught.

**Not tested.** The `.command` file, which is why it holds no logic. It is verified by running it
once by hand and reading what it printed.

The suite runs outside the sandbox. Inside, it fails while copying the fork's own command files into
a temporary directory, which is a sandbox restriction and not a test failure. Baseline on a clean
tree at the time of writing: 8,094 passed, 0 failed, 12 warnings.

## Done When

One morning run from the double-click prints a line for every enabled source, the two paid readers
and Speedrun among them, with the cost line first; `projects/career/career-ops/logs/scan-sources.tsv`
holds one row per source for that run; the app opens on the pipeline showing the rows the run added;
`portals.yml` carries no `search_queries` key and validates; the Jack and Jill reader returns a
posting date on a real response; and `test-all --quick` was green outside the sandbox before the
push. One pull request, open, not merged.

## Out of Scope

The Apify plugin's missing posting date: `plugins/apify/index.mjs` maps five fields and no date,
so both paid readers return undated rows and the age filter never fires on them. The per-source
lines will show it on the first run as "age 0 removed" against Indeed and LinkedIn, and that is the
plugin, not this ticket. It is the upstream `postedAt` pull request already listed in `TICKETS.md`.
Scheduled or unattended scans, which stay parked until a month of daily double-clicks shows a role
missed because of the hour it was posted. Reading the full advert, which is the next ticket and is
what makes the filters bite. Any change to the filters themselves, to the scoring, or to what the
app does with a row once it exists. Any change to the run-summary file's columns. Retiring the app's
four-system Scan button, which is relabelled and otherwise left alone. The four venture boards that
have never returned a London match, which are reviewed after one more scan. Narrowing the two paid
searches that flood, which waits on the advert reader.

## Further Notes

The tool's own repository is public and the fork's process rules keep records of how the work is
done outside it. This spec is an exception the rules already name: the fork carries its specs.

Two traps this ticket walks past, both already paid for. A scan run through the sandbox fails on
every fetch and reports zero, and the temporary directory differs between the sandboxed and
unsandboxed shell, so a log written by one is not the log read by the other. And a reader that does
not map a posting date does not merely lack a field; it disables the age filter for everything it
returns, which is how fifty-seven undated rows reached the pipeline in September.

The proof for this ticket checks the last step, not the first: a run that printed its lines but wrote
no rows to the per-source log has not passed.
