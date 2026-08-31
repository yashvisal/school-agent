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
