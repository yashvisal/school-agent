# scenario: removed

`assignments.1002.json` is a full copy of `fixtures/canvas/assignments.1002.json` with one
assignment deleted:

- **5104 "Assignment 4: Dynamic Programming"** is gone (as it would be if the instructor deleted
  it in Canvas).

Ingesting it must produce **exactly one** change: `deadline_removed`, origin `canvas`, tier
`auto`, status `applied`. The row is not deleted — its `status` becomes `removed`, so the change
feed and any task that referenced it still resolve.
