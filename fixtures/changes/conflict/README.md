# scenario: conflict

`canvas-feed.ics` is a full copy of `fixtures/ical/canvas-feed.ics` with one edit:

- **`UID:event-assignment-5101`** — `DTSTART` `20260915T035900Z` → `20260916T035900Z`.

The UID carries the Canvas assignment id, so the reconcile step joins it exactly (no fuzzy
matching) against the already-ingested Canvas deadline for 5101 and finds the dates disagree by
24 hours. Canvas wins on precedence, so the change is **not** applied: it must be
`deadline_moved` with `conflict: true`, origin `ical`, tier `needs_approval`, status `pending`,
and the `deadlines` row's `dueAt` must be unchanged (`2026-09-15T03:59:00Z`).

This is the one place the two-tier rule bites for a structured source: `plans/core.md`
"Two-tier apply rule" — authoritative sources are `auto` *unless* they conflict.
