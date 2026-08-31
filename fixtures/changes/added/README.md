# scenario: added

`assignments.1002.json` is a full copy of `fixtures/canvas/assignments.1002.json` plus one new
published assignment:

- **5110 "Assignment 5: Tries and Autocomplete"**, group 2101 (Programming Assignments),
  100 points, due `2026-11-24T04:59:00Z`.

Ingesting it must produce **exactly one** change: `deadline_added`, origin `canvas`, tier `auto`,
status `applied`, and a new `deadlines` row with `externalIds.canvasAssignmentId === "5110"`.
