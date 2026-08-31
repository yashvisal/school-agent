# `lib/data` — the Face ↔ Core seam

`hooks.ts` is the **only** place the UI touches data. `useViewer()` is already a real Convex
subscription (`api.auth.viewer`). The others return the fixtures in `fixtures.ts` but are shaped
exactly like Convex subscriptions — `undefined` while loading, then an array — so swapping each is
a one-line change and no panel moves. `types.ts` mirrors core.md's state model and is deleted the
day `convex/schema.ts` lands (import `Doc<"courses">` &c. from `convex/_generated/dataModel`
instead).

Panels never import `fixtures.ts`. If you need new data, add a hook here.

## Needs from Core

Everything below is a **read** unless marked otherwise. All of it is per-student and scoped by the
Clerk identity server-side — Face never passes a `studentId`.

| Query                                                             | Args                                                                              | Returns / notes                                                                                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.courses.list`                                                | `{ status?: "active" \| "concluded" }`                                            | `courses` for the sidebar, filters and workspace headers. Needs `gradingScheme` inline (the workspace renders it) and provenance.                                                    |
| `api.courses.get`                                                 | `{ courseId }`                                                                    | One course + grading scheme + provenance, for `/courses/[courseId]`.                                                                                                                 |
| `api.deadlines.list`                                              | `{ from: number, to: number, courseId?: Id<"courses"> }`                          | Deadlines in a window. **Please annotate each with the open `change` touching it** (`pendingChangeId`) so Semester can highlight moved/added/pending without a second round trip.     |
| `api.tasks.list`                                                  | `{ from: number, to: number, courseId?: Id<"courses"> }`                          | Planned tasks. `plannedFor`, `estEffortMin`, `type`, `status`, `deadlineId`.                                                                                                          |
| `api.changes.feed`                                                | `{ status?: ChangeStatus[], limit?: number }`                                     | The change feed. Needs `before`/`after` per field (the diff engine has them), `tier`, `origin`, and a short **tool label** ("polled Canvas", "parsed syllabus") for the tool chips.    |
| `api.sources.list`                                                | `{}`                                                                              | Connector cards: `kind`, `lastPolledAt`, `health`, and which courses each currently feeds. Never any secret material.                                                                 |
| `api.signals.recent`                                              | `{ courseId?: Id<"courses">, limit?: number }`                                    | `studentSignals` for the Context rail. Raw text + origin + `observedAt`; **no aggregation** (vision §4b).                                                                             |
| `api.dashboard.recentlyDiscussed` *(nice to have)*                | `{}`                                                                              | The "recently discussed" view core.md promises, so Dashboard ordering stays simple instead of Face inventing a heuristic. face.md open question.                                      |

### Mutations Face needs

| Mutation                    | Args                                                                          | Notes                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.changes.approve`       | `{ changeId }`                                                                | The Approve button on a pending row. Applies the change.                                                                                                    |
| `api.changes.reject`        | `{ changeId }`                                                                | Dismiss a pending row.                                                                                                                                      |
| `api.changes.approveMany`   | `{ changeIds: Id<"changes">[] }`                                              | Bulk approve at onboarding (core.md "bulk-approve UI").                                                                                                     |
| `api.changes.propose`       | `{ ... }` (origin `"manual"`)                                                 | The **Fix** button. Every student edit is a fact fix that flows through `changes` — Face has no other write path (face.md "Design rules", vision §10).       |
| `api.sources.resync`        | `{ sourceId }`                                                                | The "re-sync" button on a connector card. Should be idempotent / rate-limited.                                                                               |
| `api.students.updatePrefs`  | `{ phone?, timezone?, availability?, checkInPreference? }`                    | Settings. Currently a static form.                                                                                                                          |

### Open questions for Core

- **Windowing.** `deadlines.list` / `tasks.list` take `from`/`to` above; if Core would rather serve
  the whole active semester and let Face window it client-side, say so and we'll drop the args.
- **Provenance shape.** Face assumes `{ source, sourceRef, confidence, snapshotId, observedAt }` on
  every fact and renders exactly those five in the popover. If `snapshots.fetchedAt` is the real
  home of `observedAt`, we'd rather have it denormalised onto the fact than join in the client.
- **Change grouping.** A single syllabus parse produces many `changes`. Face currently shows them
  as individual rows; a `batchId` would let us render "18 items from CHEM 202's syllabus" as one
  bulk-approve card, which is what onboarding wants.
