# scenario: moved

`assignments.1002.json` is a full copy of `fixtures/canvas/assignments.1002.json` with one edit:

- **5103 "Assignment 3: Graphs"** `due_at` `2026-10-13T03:59:00Z` → `2026-10-16T03:59:00Z`
  (`updated_at` bumped to match).

Ingesting it after the base semester must produce **exactly one** change: `deadline_moved`,
origin `canvas`, tier `auto`, status `applied`, and the `deadlines` row's `dueAt` must be the new
value.
