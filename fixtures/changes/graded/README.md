# scenario: graded

`submissions.1002.json` is a full copy of `fixtures/canvas/submissions.1002.json` with one edit:

- **5102 "Assignment 2: Hash Maps"** — `workflow_state` `submitted` → `graded`, `score` 88,
  `graded_at` / `posted_at` set.

Ingesting it must produce **exactly one** change: `grade_posted`, origin `canvas`, tier `auto`,
status `applied`, and the row's `submissionStatus` becomes `graded` with `score` 88.
