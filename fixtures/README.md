# fixtures/

Test data for the ingestion pipeline. **This directory is split: some of it is committed, most
of it is not.** See `plans/core.md`, "Test data & limitations".

## Committed (spec-derived — no real student data)

| Path                | What                                                                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixtures/canvas/`  | Canvas API responses hand-authored from the example JSON in <https://developerdocs.instructure.com/> — courses, assignments (incl. assignment groups/weights), submissions, files/modules/pages/announcements, and `Link`-header pagination samples. Shapes and field names come from the docs, never from memory. |
| `fixtures/ical/`    | Hand-authored `.ics` files using Canvas's `event-assignment-<id>` UID convention, so the exact-join dedupe against the Canvas adapter is tested.            |
| `fixtures/changes/` | Synthetic change scenarios derived from the above (deadline moved / added / removed, submission landed) that drive the snapshot → diff → `changes` tests.   |

These contain no personal data and are the reason the whole pipeline can be tested with **no live
Canvas access**. Keep them that way: if you need a realistic value, invent one.

### Layout

```text
fixtures/
  canvas/                       spec-derived Canvas REST responses (Fall 2026, one student)
    courses.json                GET /api/v1/courses?enrollment_state=active&include[]=term
                                  1001 BIO201 / 1002 CS201 / 1003 STA210  (active, fully polled)
                                  1004 HIST101  workflow_state "completed" + concluded: true
                                  1005 CHEM101  workflow_state "unpublished"
    assignment_groups.<id>.json GET /api/v1/courses/:id/assignment_groups  (group_weight, rules.drop_lowest)
    assignments.<id>.json       GET /api/v1/courses/:id/assignments        (23 published + 1 unpublished)
    submissions.<id>.json       GET /api/v1/courses/:id/students/submissions?student_ids[]=self
    files.<id>.json             GET /api/v1/courses/:id/files
    modules.<id>.json           GET /api/v1/courses/:id/modules
    pages.<id>.json             GET /api/v1/courses/:id/pages
    announcements.<id>.json     GET /api/v1/announcements?context_codes[]=course_:id
    pagination.json             Link-header samples (first / middle / last / bookmark / unquoted)
  ical/
    canvas-feed.ics             Canvas user feed: 4 event-assignment-<id> + 2 event-calendar-event-<id>
    generic.ics                 non-Canvas feed for the fuzzy fallback (all-day, TZID, and a duplicate)
    index.ts                    GENERATED mirror of the .ics files (see below)
    build.mjs                   regenerates index.ts
  changes/                      synthetic scenarios, each a FULL modified copy + a README
    moved/      assignments.1002.json      5103 due_at + 3 days        -> one deadline_moved
    added/      assignments.1002.json      new assignment 5110         -> one deadline_added
    removed/    assignments.1002.json      5104 deleted                -> one deadline_removed
    submitted/  submissions.1002.json      5103 workflow_state         -> one submitted
    graded/     submissions.1002.json      5102 score posted           -> one grade_posted
    conflict/   canvas-feed.ics            5101 DTSTART + 1 day        -> one deadline_moved, conflict, PENDING
```

The semester is coherent: assignment ids in the `.ics` files match the ids in
`assignments.*.json`, so the exact-join dedupe is exercised for real, and every scenario is a full
file rather than a patch so the whole pipeline runs on it end to end.

Counts the tests pin (`convex/lib/canvas/normalize.test.ts`): 5 courses, 23 deadlines
(13 homework / 6 exam / 2 quiz / 2 reading), 21 materials, submission statuses
4 graded / 3 submitted / 2 excused / 2 unsubmitted / 1 missing / 11 unknown.

### `fixtures/ical/index.ts` is generated

Convex bundles with esbuild, which has no `?raw` loader, so a `.ics` file cannot be imported from
`convex/`. The `.ics` files stay the source of truth; `index.ts` mirrors them into a module the
bundler can see. **After editing any `.ics`, run `node fixtures/ical/build.mjs`.**

### Using them

`convex/dev/fixtures.ts` assembles these into the exact payload shapes the adapters see, and
`convex/dev/seed.ts` ingests them through the real pipeline:

```bash
npx convex run dev/seed:fixtureSemester
npx convex run dev/seed:applyScenario '{"scenario":"moved"}'
npx convex run dev/seed:reset
```

A source whose `config` is `{ mode: "fixture" }` makes `internal.ingest.canvas.poll` and
`internal.ingest.ical.poll` read these instead of the network, so the cron works on a dev
deployment with no Canvas token at all.

## Ignored (real data, never committed)

Everything else under `fixtures/` — the founder's Duke Canvas snapshots, real syllabi, course-site
crawls, schedule uploads, and any hand-verified extraction-eval expected outputs derived from them.
It is real student data and it is stale (vision §7 / core.md "Test data"). It stays local until
scrubbed.

`.gitignore` implements this as `/fixtures/*` plus explicit `!` exceptions for the three
spec-derived directories and this README — git cannot re-include a path whose parent directory is
excluded, so the ignore has to be on the contents, not the directory.

## Adding a new committed fixture directory

Add the directory here **and** a matching `!/fixtures/<name>/` line in `.gitignore`, and say in this
table where the data came from. A fixture without a stated provenance is indistinguishable from
leaked real data.
