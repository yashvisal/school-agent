# scenario: submitted

`submissions.1002.json` is a full copy of `fixtures/canvas/submissions.1002.json` with one edit:

- **5103 "Assignment 3: Graphs"** — `workflow_state` `unsubmitted` → `submitted`, `submitted_at`
  set to `2026-10-13T03:41:00Z`, `attempt` 1.

Ingesting it must produce **exactly one** change: `submitted`, origin `canvas`, tier `auto`,
status `applied`, and the row's `submissionStatus` becomes `submitted`.
