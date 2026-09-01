# `lib/data` — the Face ↔ Core seam

`hooks.ts` is the **only** place the UI touches data. Every hook is now a **real Convex
subscription** (`undefined` while loading, then data) plus an adapter that maps Core's docs onto
the Face view-model in `types.ts`. Panels never see a Convex doc and never import `fixtures.ts`
(kept only as shape reference / future story data).

`types.ts` is **not** deleted now that the schema exists — it is the view-model, and several of
its fields are presentation Core deliberately does not store (vision §9): `accent`,
`Change.summary`/`fields[]`/`toolLabel`, `Source.label`/`detail`/`covers`, the flat health enum,
ISO date strings. All of it is derived in `hooks.ts`, per render, recomputable.

If you need new data, add a hook (and its mapping) here.

## The Core queries (implemented)

All identity-scoped server-side — Face never passes a `studentId`. Signed-out / unprovisioned →
empty array.

| Query                 | Args                        | Notes                                                                                                     |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `api.courses.list`    | `{ status? }`               | `hidden` filtered by default. `gradingScheme` inline (`{ categories, notes }` wrapper — adapter flattens). |
| `api.courses.get`     | `{ courseId }`              | 403 on someone else's course.                                                                              |
| `api.deadlines.list`  | `{ from?, to?, courseId? }` | ms range on `dueAt`. **Each row annotated with `pendingChangeId`** (the open change touching it, derived in the query). `removed` filtered server-side; the adapter also drops undated rows (no date-shaped surface for them yet). |
| `api.tasks.list`      | `{ courseId? }`             | Whole active set; Face windows client-side (resolves the old windowing question — a semester of tasks is a few hundred rows). |
| `api.changes.feed`    | `{ limit? }`                | Raw docs (`before`/`after` bags, `entity`, `createdAt`, `evidence`). Summary / diff lines / tool label are derived in the adapter. |
| `api.ingest.sources.list` | `{}`                    | Config redacted (`token: "[set]"`); `health` is `{ status, message, at }` — adapter maps to the flat enum and derives `label`/`detail`/`covers` (joined from `courses.sourceRefs`). |
| `api.signals.recent`  | `{ courseId?, limit? }`     | Raw text + origin + `observedAt` (ms); no aggregation (vision §4b).                                        |

### Mutations Face needs (unchanged asks; `changes.*` exist)

| Mutation                  | Status                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| `api.changes.approve`     | ✅ `{ changeId, via }`                                                     |
| `api.changes.reject`      | ✅ `{ changeId }`                                                          |
| `api.changes.approveMany` | still needed for onboarding bulk-approve                                   |
| `api.changes.propose`     | exists as `internal.changes.propose`; a public `origin: "manual"` wrapper is still needed for the Fix button |
| `api.ingest.sources.add` / `setEnabled` | ✅                                                          |
| `api.students.updatePrefs`| still needed for Settings                                                  |

### Known adapter caveats

- **`provenance.observedAt` is absent** — Core stores no per-fact observation timestamp
  (it lives on the snapshot); the popover hides the "Seen" row. Denormalising
  `snapshots.fetchedAt` onto facts remains a nice-to-have.
- **`change.confidence`** comes from `after.provenance.confidence` when the extractor supplied
  one; otherwise the "N% confident" line simply doesn't render.
- **`accent`** is a deterministic client-side palette by course index, not stored.
- **Change grouping** (`batchId` for "18 items from CHEM 202's syllabus") is still open for
  onboarding.
