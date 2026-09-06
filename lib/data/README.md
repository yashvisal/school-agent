# `lib/data` — the Face ↔ Core seam

`hooks.ts` is the **only** place the UI touches data. Every hook is now a **real Convex
subscription** (`undefined` while loading, then data) plus an adapter that maps Core's docs onto
the Face view-model in `types.ts`. Panels never see a Convex doc and never import `fixtures.ts`
directly.

One exception, marked as such: `useCourseChats` / `useCourseChat` read `fixtures.ts` because Core
has **no `chats` table yet**. They keep the other hooks' contract and return the shape Core will
return, so swapping them for a subscription is a one-line change here and nothing in the UI moves.

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
| `api.changes.feed`    | `{ limit? }`                | Raw docs (`before`/`after` bags, `entity`, `createdAt`, `evidence`, `batchId`). Summary / diff lines / tool label are derived in the adapter. |
| `api.ingest.sources.list` | `{}`                    | Config redacted (`token: "[set]"`); `health` is `{ status, message, at }` — adapter maps to the flat enum and derives `label`/`detail`/`covers` (joined from `courses.sourceRefs`). |
| `api.signals.recent`  | `{ courseId?, limit? }`     | Raw text + origin + `observedAt` (ms); no aggregation (vision §4b).                                        |

### Mutations Face needs

| Mutation                  | Status                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| `api.changes.approve`     | ✅ `{ changeId, via }`                                                     |
| `api.changes.reject`      | ✅ `{ changeId }`                                                          |
| `api.changes.approveMany` | ✅ `{ changeIds, via }` **or** `{ batchId, via }` — exactly one selector. Batch mode approves every pending change the caller still has from one extraction run. Already-resolved / foreign / stale ids are skipped, never thrown, so a double-tap is harmless. |
| `api.changes.proposeManual` | ✅ the Fix button. `{ kind, entity: { table, id }, before?, after?, courseId?, reason?, supersedesChangeId? }` → `{ changeId, status }`. `kind` ∈ `deadline_moved \| deadline_updated \| deadline_removed \| course_updated \| task_updated \| other`; `entity.table` ∈ `deadlines \| courses \| tasks` and must match the kind; `entity.id` is required (a fix edits, never creates). Origin is forced to `manual` and the change is proposed **and approved in the same mutation** — the student's tap is the approval, so `status` comes back `approved` and the row is already patched. Pass `supersedesChangeId` when the fix answers a pending card: that card is `rejected` (`resolvedVia: "web"`) in the same transaction. 401 signed out, 403 someone else's row, 404 a row that no longer exists. |
| `api.ingest.sources.resync` | ✅ `{ sourceId }` → `{ scheduled: true }`. Runs the poll the cron would have run for that one source (canvas / ical / site), or re-extracts an upload from its stored document (syllabus / schedule). Health flips to `{ status: "unknown", message: "re-sync requested" }` immediately so the card can show progress; the real health arrives when the run finishes. 403 someone else's source, 400 disabled or no adapter yet. |
| `api.ingest.sources.add` / `setEnabled` | ✅                                                          |
| `api.students.updatePrefs`| ✅ `{ phone?, timezone?, morningHourLocal?, availability?, checkInPreference?, semesterStart?, semesterEnd? }` — all optional, identity-scoped (no `studentId`). Returns `{ studentId, changed: string[] }`; `changed: []` means nothing moved and no change row was written. Throws `400` on an unusable phone/timezone/hour/date and `409: phone already in use`. |
| `api.students.ensure`     | ✅ `{ timezone? }` → `Id<"students">`. **Face must call it once after sign-in** — every other query returns empty and `updatePrefs` throws `404` until the row exists. |

### `photonRegistration` — for the Settings UI

Saving a phone schedules its registration with Photon (a shared line can only
message a registered user), and the outcome lands on the student row as
`photonRegistration: { status: "pending" | "registered" | "failed" | "skipped", at, error? }`.
It is written outside `changes` — routing bookkeeping, like `inboundCount` — and
is absent until the first save. Read it off `api.auth.viewer` (unchanged: it
returns the whole student row, so the new fields — `morningHourLocal`,
`checkInPreference`, `photonRegistration` — are already there).

| `status` | What Settings shows |
| --- | --- |
| absent | Nothing yet — no number has been saved. |
| `pending` | "Registering…" — written in the same transaction that schedules the attempt, so it appears the instant `updatePrefs` returns. |
| `registered` | "We can text this number." |
| `failed` | "Couldn't register — try again." `error` carries the reason; it is operator detail, not student-facing copy. |
| `skipped` | This deployment has no Voice attached. Say nothing. |

The terminal status replaces `pending` a moment later, so the subscription moves
`pending` → `registered`/`failed` on its own with no refetch.

"Try again" is literally a re-save: submitting the same number when the status is
`failed`, `skipped`, or absent schedules another attempt and returns
`changed: []` (nothing about the student changed, so no change row). Submitting a
number that is already `registered` does nothing. **One attempt at a time**: a
re-save while a `pending` attempt is under a minute old also returns normally
with `changed: []` and schedules nothing — a press-happy button must not spend
Photon's project-wide 5 rps on one number, so the button can stay enabled and
show "Registering…" instead. Changing the number goes to `pending` immediately
and never waits behind the old number's attempt.

### Known adapter caveats

- **`provenance.observedAt` is absent** — Core stores no per-fact observation timestamp
  (it lives on the snapshot); the popover hides the "Seen" row. Denormalising
  `snapshots.fetchedAt` onto facts remains a nice-to-have.
- **`change.confidence`** comes from `after.provenance.confidence` when the extractor supplied
  one; otherwise the "N% confident" line simply doesn't render.
- **`accent`** is a deterministic client-side palette by course index, not stored.
- **Change grouping** is done: `Change.batchId` carries one id per extraction run
  (`${sourceId}:${snapshotId}`), so "18 items from CHEM 202's syllabus" is a client-side
  `groupBy(batchId)` over the feed — count it there, then approve the group with
  `approveMany({ batchId })`. Changes that were not part of a run (chat, manual, a single
  Canvas diff) have no `batchId` and render as themselves.
