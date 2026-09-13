# Ticket C: suitability before routing

**Written:** 12 September 2026, by the Career Planner, from the outside audit
`outputs/general/General Career Ops Search Audit and Repair Plan v1.md` (findings F01 to F10,
acceptance tests A01 to A18) and the decision table added the same day to
`projects/career/General Role Criteria v1.md`. Read both before this file. The audit's
Objective table (T01 to T15) reproduced exactly on `ticket-b2-gate-and-route` at `004fdfa` when the
Planner reran it on 12 September; nothing in it was already fixed.

## Problem

The scan reads the advert (B1) and drops on it (B2), but the drop is a substring match. It rejects
"5+ years is preferred, not required" and "we have served customers for 5+ years", keeps "you must
have 5 years" and "5 to 7 years", and dropped Super Payments' Product Manager on "5+ years" when the
advert reads "3 to 5+ years ... does not preclude applications from candidates with less". An advert
nobody could read gets `route: standard`, which means the standard pack with no evaluation. A town
outside London passes because the location string ends in "United Kingdom". The queue keeps rows
that a later rule would drop, and drops that a later rule would keep.

## What this ticket builds

One module and four bounded changes, in two halves because the whole does not fit one builder
session. **Ca is C1 and C3** (the years clause and the title config), one pull request. **Cb is
C2, C4 and C5** (the read route, the location rule, the recheck), one pull request, branched from
`main` after Ca merges; C4 needs the read status C2 adds and C5's second-run proof needs every rule
settled. B2's own five review fixes are a separate pass on pull request #6 and merge before Ca.

**C1. The years clause is read, not matched (F01, A01 to A04, A16).** A pure module
`providers/_experience-clause.mjs` exporting `extractExperienceClauses(text)`, returning an
array of `{ minimum, mandatory, subject, sentence }`; no `maximum`, the gate never reads one.
Numbers as digits or the words one to ten; "+" and "or more"; ranges with a hyphen, an en dash
and "to"; a range's `minimum` is its lower bound. `mandatory` is `true` on "must", "required", "at least", "minimum", "need", "essential";
`false` on "preferred", "ideally", "nice to have", "bonus", "we'd love it if", "would be a plus", or
when a later sentence says less experience does not preclude; `null` otherwise. `subject` is
`company` when the clause's sentence is about the company or the product ("we have", "our platform
has", "founded", "in business"), `candidate` when it is about the reader ("you", "the candidate",
"applicants"), `unknown` otherwise. The gate's years rule then becomes: drop only on a clause with
`subject !== 'company'`, `mandatory !== false` and `minimum >= 5`, naming the sentence; a minimum of
four is kept and the row gets a `years: 4` segment so triage sees the long shot; the years phrases in
`portals.yml` `content_filter.negative` come out in the same change, with the removed block recorded
in the build log and `sync-backup.sh` run first. Every other `content_filter` entry stays.

**C2. An unread advert has its own route (F03, A08, A09).** `routeDetail` gains a read status.
When the stored advert's `read_status` is not `read`, the row is labelled `route: review` on both
paths, the sweep and the standalone pass, and is counted on its own line in the summary. `review`
means a person reads it before anything is sent. `ROUTE_SEGMENT_RE` in `scan.mjs` (about line
2440) matches only `score|standard` today; widen it, or a `review` line is never recognised as
routed and the recheck rewrites it every run. One test proves a `review` line survives a second
run byte-identical. A row whose read is later repaired by `--reread`
is re-gated and re-routed on the same line, never duplicated; the `jd:` file and the URL cell are
untouched. Nothing downstream may treat `review` as `standard`; grep every consumer of the
`route:` segment and say in the log what each does with the new value.

**C3. Titles gather, they do not certify (F02, A05 to A07).** No code unless the config cannot do
it. In `portals.yml` `title_filter`: the bare `Engineer` negative is replaced by the specific forms
it was added for on 2 September ("Applied AI Engineer", "Solution Engineer", "Solutions Engineer",
"Forward Deployed Engineer"), so "Prompt Engineer" reaches the advert; "Growth Marketing Manager"
and "Prompt Engineer" join the positive list; "Senior" joins the negative list as a bare word,
which is Stelios's 9 September cut, unless the Planner's dispatch says otherwise. Record the exact
lines changed. A genuine specialist engineering advert is still caught, by the advert: C1 does not
touch the non-years `content_filter` entries and "Python", "LangGraph", "Node.js" and the rest stay.

**C4. Location reads attendance, not the country word (F09, A13).** In the gate, after the read:
when the listing's location is in the UK and not London, keep the row only if the advert says
remote, hybrid from anywhere, work from home, or names London; label it `location: remote-uk`.
Otherwise drop it as `location` with the town named, which is the brief's own "Outside London"
hard DQ; if Stelios says a commutable town is a flag rather than a cut, the drop becomes
`route: review` with the town named, one line. An unread advert is `review` under C2 and this rule
does not fire. No town list is added or extended.

**C5. The recheck, preserving decisions (F07, A16 to A18).** `--read-pipeline --gate` re-gates every
pending line on every run under the current rules and rewrites a line only when its segments
change; "Already labelled" becomes "Unchanged". A line carrying `keep: <reason>` is never moved:
that is Stelios's explicit exception, written by hand. The marker is new in this spec; nothing in
the repo or the queue carries it yet, and it is named to him before Cb starts. A line moved to Processed keeps every cell
and its `triage:` segment, so the earlier verdict stays readable beside the new reason. A second run
on the same input changes nothing. The tracker is read, never written; applications, contacts and
interview records are not touched.

## Testing decisions

Fixtures only, no network, no paid run. Five files under `tests/`: `experience-clause` (A01 to
A04, T07 to T13 verbatim with the en dash preserved, plus the Super Payments sentence), `advert-gate-
years` (the gate on the extractor, the four-year keep, the five-year drop with the sentence named),
`advert-route-review` (C2 on both paths, and a repaired read re-routing the same line),
`advert-location-attendance` (C4, Amersham with and without remote wording), and `advert-recheck`
(C5: a `triage: PASS` row kept under the new rule, a `keep:` row never moved, a moved row keeping its
cells, a second run byte-identical). Include retention cases in every file; a suite that only
proves rejections proves nothing.

## Proof runs never touch the real queue

Every proof run in Ca and Cb, the sweep included, points at copies: `CAREER_OPS_PIPELINE` and
`CAREER_OPS_TRACKER` to copied files, the apify plugin off. The real `data/pipeline.md` gains no
row from a proof run; if a run did append to it, the log lists every row so it can be removed.

## Ca is done when

The `experience-clause` and `advert-gate-years` suites are green and `test-all.mjs --quick` is
green outside the sandbox; T07 to T13 give the results the audit's acceptance column asks for and
the Super Payments sentence is kept with `minimum 3, preferred`; "Prompt Engineer", "Growth
Marketing Manager" and "Deployment Specialist" pass the title filter and "Senior Legal Operations
Manager" does not; the years block removed from `portals.yml` and the title lines added are in the
log verbatim; a sweep against copies prints its DROP lines with the sentence the extractor found.
One pull request, open, not merged.

## Cb is done when

The `advert-route-review`, `advert-location-attendance` and `advert-recheck` suites are green and
the whole suite is green outside the sandbox; a `read_status: unreadable` row prints
`route: review` on both paths and survives a second run unchanged; Amersham without remote wording
is dropped and Amersham with it is kept; `--read-pipeline --gate` on copies of the real queue and
tracker shows Super Payments kept with its clause named, the 9fin and Cytiva rows relabelled
`review`, no `keep:` row moved, and a second run with zero changes; the build log carries the
before-and-after counts (read, unread, kept, stretch, dropped) and one sentence plus the advert
excerpt for each changed outcome. One pull request, open, not merged. The run over the real queue
is the Planner's, after Stelios has seen the preview.

## Out of scope

Any model call per advert. A suitability database field. Reweighting the triage formula. The
triage and brief prose (done by the Planner on 12 September). The apify plugin (B3). The
schedule (D). A town list. Anything that submits.
