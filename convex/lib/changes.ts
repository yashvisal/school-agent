import type { Infer } from "convex/values"

import type { Doc, Id, TableNames } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import { normalizePhone } from "./phone"
import type {
  changeEntityV,
  changeKindV,
  changeStatusV,
  originV,
  resolvedViaV,
} from "./validators"

/**
 * The changes pipeline — the ONLY write path to student state (CLAUDE.md).
 *
 * Two-tier apply rule (plans/core.md, "Two-tier apply rule"):
 * - Authoritative structured sources (Canvas, iCal) with no conflict apply
 *   immediately: tier `auto`, status `applied`.
 * - Anything an LLM interpreted (chat, syllabus, site, schedule upload) or any
 *   source conflict is `needs_approval`. It lands `approved` + applied when the
 *   student confirmed it inline in chat (a first-class approval channel, equal
 *   to a web tap — rule 1), otherwise `pending` in the web queue.
 *
 * Pending changes are never applied. The planner plans on applied facts only and
 * *annotates* anything a pending change would touch (rule 3).
 */

export type ChangeKind = Infer<typeof changeKindV>
export type ChangeOrigin = Infer<typeof originV>
export type ChangeStatus = Infer<typeof changeStatusV>
export type ChangeEntity = Infer<typeof changeEntityV>
export type ResolvedVia = Infer<typeof resolvedViaV>

export type ProposeChangeInput = {
  studentId: Id<"students">
  courseId?: Id<"courses">
  kind: ChangeKind
  entity: ChangeEntity
  before?: unknown
  after?: unknown
  origin: ChangeOrigin
  snapshotIds?: Id<"snapshots">[]
  reason?: string
  conflict?: boolean
  /** The student confirmed this in the same chat exchange it was born in. */
  confirmedInline?: boolean
  /** REQUIRED with `confirmedInline`: what the student actually said. */
  evidence?: { quotedReply: string; inboundMessageId?: string }
}

export type ProposeChangeResult = {
  changeId: Id<"changes">
  status: ChangeStatus
}

/** Sources trusted enough to apply without asking. */
const AUTHORITATIVE_ORIGINS: ReadonlySet<ChangeOrigin> = new Set<ChangeOrigin>([
  "canvas",
  "ical",
])

export function tierFor(
  origin: ChangeOrigin,
  conflict?: boolean
): "auto" | "needs_approval" {
  return AUTHORITATIVE_ORIGINS.has(origin) && !conflict ? "auto" : "needs_approval"
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

export async function proposeChangeInternal(
  ctx: MutationCtx,
  input: ProposeChangeInput
): Promise<ProposeChangeResult> {
  const now = Date.now()
  const tier = tierFor(input.origin, input.conflict)

  // `confirmedInline` rests on the model's honesty; the evidence requirement is
  // ACCOUNTABILITY, not proof — the quoted reply lands in the change feed so a
  // student can see exactly what "approval" the agent claims ("confirmed in
  // chat: 'yeah'") and contest a fabricated one.
  if (input.confirmedInline && !input.evidence?.quotedReply?.trim()) {
    throw new Error(
      "400: confirmedInline requires evidence.quotedReply — the student's confirming reply, quoted verbatim"
    )
  }

  // When the claim also names the confirming message, it must actually exist in
  // the inbound log (written by the Voice channel before every dispatch, TTL'd
  // well past any live conversation) and belong to THIS student. A quoted reply
  // without an id remains allowed — accountability-only — but a wrong id is a
  // fabricated citation and the whole change is refused (VOICE_TOOLS.md §4).
  if (input.confirmedInline && input.evidence?.inboundMessageId) {
    const messageId = input.evidence.inboundMessageId
    const logged = await ctx.db
      .query("inboundMessages")
      .withIndex("by_student_messageId", (q) =>
        q.eq("studentId", input.studentId).eq("messageId", messageId)
      )
      .first()
    if (!logged) {
      throw new Error(
        "400: evidence.inboundMessageId does not match any stored inbound message from this student"
      )
    }
  }

  let status: ChangeStatus
  let resolvedVia: ResolvedVia | undefined
  if (tier === "auto") {
    status = "applied"
    resolvedVia = "auto"
  } else if (input.confirmedInline) {
    status = "approved"
    resolvedVia = "chat"
  } else {
    status = "pending"
    resolvedVia = undefined
  }

  const changeId = await ctx.db.insert("changes", {
    studentId: input.studentId,
    courseId: input.courseId,
    kind: input.kind,
    entity: input.entity,
    before: input.before,
    after: input.after,
    origin: input.origin,
    tier,
    status,
    snapshotIds: input.snapshotIds ?? [],
    reason: input.reason,
    conflict: input.conflict,
    createdAt: now,
    resolvedAt: status === "pending" ? undefined : now,
    resolvedVia,
    evidence: input.confirmedInline ? input.evidence : undefined,
  })

  if (status !== "pending") {
    const change = await ctx.db.get("changes", changeId)
    if (change) await applyChange(ctx, change)
  }

  return { changeId, status }
}

// ---------------------------------------------------------------------------
// approve / reject / expire
// ---------------------------------------------------------------------------

export async function approveChangeInternal(
  ctx: MutationCtx,
  changeId: Id<"changes">,
  via: "web" | "chat"
): Promise<ProposeChangeResult> {
  const change = await ctx.db.get("changes", changeId)
  if (!change) throw new Error("404: change not found")
  // Idempotent: approving an already-resolved change is a no-op, not a re-apply.
  if (change.status !== "pending") return { changeId, status: change.status }

  await ctx.db.patch("changes", changeId, {
    status: "approved",
    resolvedAt: Date.now(),
    resolvedVia: via,
  })
  const fresh = await ctx.db.get("changes", changeId)
  if (fresh) await applyChange(ctx, fresh)
  return { changeId, status: "approved" }
}

export async function rejectChangeInternal(
  ctx: MutationCtx,
  changeId: Id<"changes">,
  via: "web" | "chat" = "web"
): Promise<ProposeChangeResult> {
  const change = await ctx.db.get("changes", changeId)
  if (!change) throw new Error("404: change not found")
  if (change.status !== "pending") return { changeId, status: change.status }

  await ctx.db.patch("changes", changeId, {
    status: "rejected",
    resolvedAt: Date.now(),
    resolvedVia: via,
  })
  return { changeId, status: "rejected" }
}

/**
 * Rule 5: pending changes older than the horizon are dropped with a note in the
 * feed — expired, never applied.
 *
 * Drains with a real cursor over `_creationTime` (the implicit last field of
 * every index), not a fixed front window: a `take(200)` loop re-reads the same
 * front of the index each pass, so stale rows sitting behind 200 fresh ones
 * were unreachable (CR 3892156162). The cursor walks the entire pending set;
 * `MAX_EXPIRE_BATCHES` is a transaction-budget backstop, and the nightly pass
 * picks up any remainder on its next run.
 */
const EXPIRE_BATCH = 200
const MAX_EXPIRE_BATCHES = 20

export async function expireStaleInternal(
  ctx: MutationCtx,
  studentId: Id<"students">,
  olderThanMs: number,
  batchSize = EXPIRE_BATCH
): Promise<number> {
  const cutoff = Date.now() - olderThanMs
  let expired = 0
  let cursor: number | undefined

  for (let batch = 0; batch < MAX_EXPIRE_BATCHES; batch++) {
    const after = cursor
    const pending = await ctx.db
      .query("changes")
      .withIndex("by_student_status", (q) => {
        const base = q.eq("studentId", studentId).eq("status", "pending")
        return after === undefined ? base : base.gt("_creationTime", after)
      })
      .take(batchSize)
    if (pending.length === 0) break
    cursor = pending[pending.length - 1]._creationTime

    for (const change of pending) {
      if (change.createdAt >= cutoff) continue
      await ctx.db.patch("changes", change._id, {
        status: "expired",
        resolvedAt: Date.now(),
        resolvedVia: "expired",
      })
      expired++
    }
    if (pending.length < batchSize) break
  }
  return expired
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

type Bag = Record<string, unknown>

const asBag = (value: unknown): Bag =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Bag) : {}

/** Copies only the listed keys, dropping `undefined` (not a Convex value). */
function pick<K extends string>(source: Bag, keys: readonly K[]): Bag {
  const out: Bag = {}
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

/**
 * Optional deadline fields a source can *lose*: a grade retracted, a due date
 * removed, a description deleted. Convex values cannot be `undefined`, so a
 * cleared field arrives as `null` on the wire and is turned back into a real
 * unset here. Required fields are deliberately absent — nothing may clear a
 * title, a kind, or a submission status.
 */
const CLEARABLE_DEADLINE_KEYS: ReadonlySet<string> = new Set([
  "dueAt",
  "pointsPossible",
  "category",
  "score",
  "description",
  "url",
])

/**
 * The deadline patch, with `null` read as "unset this field".
 *
 * `pick` alone can only ever *set* values, so a reopened deadline
 * (`graded` → `unsubmitted`) kept the stale `score` it was graded with, and the
 * agent would tell a student their un-submitted work is worth 18/20.
 */
function pickDeadline(after: Bag): Bag {
  const out: Bag = {}
  for (const key of DEADLINE_KEYS) {
    const value = after[key]
    if (value === undefined) continue
    if (value === null && CLEARABLE_DEADLINE_KEYS.has(key)) {
      out[key] = undefined // `patch` with an explicit undefined removes the field
      continue
    }
    out[key] = value
  }
  return out
}

const DEADLINE_KEYS = [
  "courseId",
  "title",
  "kind",
  "dueAt",
  "pointsPossible",
  "category",
  "submissionStatus",
  "score",
  "description",
  "url",
  "externalIds",
  "provenance",
  "status",
] as const

const COURSE_KEYS = [
  "name",
  "code",
  "sourceRefs",
  "gradingScheme",
  "status",
  "provenance",
] as const

const TASK_KEYS = [
  "courseId",
  "deadlineId",
  "title",
  "type",
  "status",
  "plannedFor",
  "plannedStartMin",
  "estEffortMin",
  "estEffortConfidence",
  "actualEffortMin",
  "createdBy",
] as const

const STUDENT_KEYS = [
  "timezone",
  "phone",
  "semesterStart",
  "semesterEnd",
  "classBlocks",
  "availability",
  "status",
  "nightlyHourLocal",
] as const

/**
 * What a chat-origin change may touch on the student row. Anything an LLM
 * interpreted from a message can move the *schedule*; it can never move the
 * account. `phone`, `clerkId`, `timezone`, and `status` are identity and
 * routing — a mis-parsed sentence must not be able to repoint a student's
 * number or un-pause their account.
 */
const CHAT_STUDENT_KEYS = [
  "classBlocks",
  "availability",
  "semesterStart",
  "semesterEnd",
  "nightlyHourLocal",
] as const

/**
 * Origins that assert nothing: whatever provenance the caller attached is
 * overwritten on apply. Voice interpreting a message cannot claim the fact came
 * from Canvas (CR 3892156302) — the two-tier rule keys off exactly that claim.
 */
const CALLER_ASSERTED_ORIGINS: ReadonlySet<ChangeOrigin> = new Set<ChangeOrigin>([
  "chat",
  "manual",
])

function fallbackProvenance(change: Doc<"changes">) {
  return {
    // `reason` is student-facing prose, not a source reference (CR 3892156165).
    source: change.origin,
    sourceRef: change._id,
    // Confidence is a SOURCE fact: structured sources assert 1; an extraction
    // passes its own number through `after.provenance`. Where neither exists it
    // is ABSENT — never fabricated (a made-up 0.5 reads like a measurement).
    ...(change.tier === "auto" ? { confidence: 1 } : {}),
    snapshotId: change.snapshotIds[0],
  }
}

/**
 * For a PATCH from a caller-asserted origin (chat, manual), the row's
 * provenance must move with the fact: leaving the old Canvas provenance on a
 * due date the student changed in chat shows "Canvas, confidence 1" for a
 * chat-asserted value — exactly the misattribution the §4 rule forbids. Found
 * live (the insert paths already did this via `provenanceFor`); adapters keep
 * their own behaviour, since they always supply real provenance in `after`.
 */
function withAssertedProvenance(change: Doc<"changes">, after: Bag, patch: Bag): Bag {
  if (!CALLER_ASSERTED_ORIGINS.has(change.origin)) return patch
  return { ...patch, provenance: provenanceFor(change, after) }
}

/**
 * The provenance to write for this change's entity. A caller-supplied
 * `after.provenance` is honoured only for origins that can actually evidence it;
 * for `chat` and `manual` it is replaced with what we know to be true.
 */
function provenanceFor(change: Doc<"changes">, after: Bag) {
  if (CALLER_ASSERTED_ORIGINS.has(change.origin)) {
    // The SOURCE claim is always replaced (chat cannot claim Canvas), but a
    // numeric confidence is honoured: an extractor's own number is a real
    // measurement, unlike the labelled fallback (CR 3897465420).
    const supplied = (after.provenance as { confidence?: unknown } | undefined)
      ?.confidence
    return {
      ...fallbackProvenance(change),
      ...(typeof supplied === "number" && supplied >= 0 && supplied <= 1
        ? { confidence: supplied }
        : {}),
    }
  }
  return (after.provenance as Doc<"deadlines">["provenance"]) ?? fallbackProvenance(change)
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

/** Tables whose rows carry a `studentId` and are therefore student-scoped. */
type OwnedTable = Extract<TableNames, "deadlines" | "courses" | "tasks">

const NOT_YOURS = "403: entity does not belong to student"

/**
 * Loads a student-scoped row **and proves it belongs to this change's student.**
 *
 * Without this, `entity.id` is an unauthenticated cross-tenant write primitive:
 * a change proposed for student A naming student B's deadline id would patch
 * B's row, since ids are opaque strings the caller supplies. Returns `null` for
 * a row that does not exist (an already-deleted target is a no-op, not an
 * error); throws when the row exists and belongs to someone else.
 */
async function loadOwned<T extends OwnedTable>(
  ctx: MutationCtx,
  table: T,
  id: Id<T>,
  studentId: Id<"students">
): Promise<Doc<T> | null> {
  const doc = await ctx.db.get(table, id)
  if (!doc) return null
  // Every table in `OwnedTable` carries `studentId`; TypeScript cannot see that
  // through the generic table name, so the ownership field is read structurally.
  const owner = (doc as unknown as { studentId: Id<"students"> }).studentId
  if (owner !== studentId) throw new Error(NOT_YOURS)
  return doc
}

/**
 * Every foreign key an insert would write must point inside the same student.
 * Creating a deadline under another student's course is the same defect as
 * patching their row directly, and survives an `entity.id` check untouched.
 */
async function assertRefsOwned(
  ctx: MutationCtx,
  change: Doc<"changes">,
  after: Bag
): Promise<void> {
  const refs: [OwnedTable, unknown][] = [
    ["courses", after.courseId ?? change.courseId],
    ["deadlines", after.deadlineId],
    ["tasks", after.taskId],
  ]
  for (const [table, raw] of refs) {
    if (typeof raw !== "string") continue
    const doc = await ctx.db.get(table, raw as Id<OwnedTable>)
    // A reference we cannot resolve cannot be proven to be the caller's own.
    if (!doc || doc.studentId !== change.studentId) throw new Error(NOT_YOURS)
  }
}

/**
 * The student-row fields this change may write, normalized. Chat-origin changes
 * reach only the scheduling fields; a phone number is normalized on the way in
 * so `by_phone` (an exact-match index) can still find it.
 */
function studentPatch(change: Doc<"changes">, after: Bag): Bag {
  const keys = change.origin === "chat" ? CHAT_STUDENT_KEYS : STUDENT_KEYS
  const patch = pick(after, keys)
  if (typeof patch.phone === "string") patch.phone = normalizePhone(patch.phone)
  return patch
}

/**
 * Writes the entity described by `change`. Idempotent where feasible: an already
 * -applied insert is detected via `entity.id` or the source's external id, and
 * patches are last-write-wins by construction.
 *
 * **Tenancy is enforced here, once, for every path** — propose-and-apply,
 * approve, and the nightly drain all funnel through this function. Every row it
 * touches is proven to belong to `change.studentId` first, and every foreign key
 * it would write is proven to point inside the same student. `entity.id` is a
 * caller-supplied opaque string; without these checks it is a cross-tenant write.
 *
 * Returns the entity id the change now points at (undefined for no-ops).
 */
export async function applyChange(
  ctx: MutationCtx,
  change: Doc<"changes">
): Promise<string | undefined> {
  const after = asBag(change.after)
  await assertRefsOwned(ctx, change, after)

  const remember = async (id: string) => {
    if (change.entity.id !== id) {
      await ctx.db.patch("changes", change._id, {
        entity: { ...change.entity, id },
      })
    }
    return id
  }

  switch (change.kind) {
    case "deadline_added": {
      const existing = await findExistingDeadline(ctx, change, after)
      if (existing) {
        await ctx.db.patch("deadlines", existing._id, pickDeadline(after))
        return await remember(existing._id)
      }
      const courseId = (after.courseId ?? change.courseId) as
        | Id<"courses">
        | undefined
      if (!courseId) throw new Error("deadline_added: missing courseId")
      const id = await ctx.db.insert("deadlines", {
        studentId: change.studentId,
        courseId,
        title: (after.title as string) ?? "Untitled",
        kind: (after.kind as Doc<"deadlines">["kind"]) ?? "other",
        dueAt: after.dueAt as number | undefined,
        pointsPossible: after.pointsPossible as number | undefined,
        category: after.category as string | undefined,
        submissionStatus:
          (after.submissionStatus as Doc<"deadlines">["submissionStatus"]) ??
          "unknown",
        score: after.score as number | undefined,
        description: after.description as string | undefined,
        url: after.url as string | undefined,
        externalIds: (after.externalIds as Doc<"deadlines">["externalIds"]) ?? {},
        provenance: provenanceFor(change, after),
        status: (after.status as Doc<"deadlines">["status"]) ?? "active",
      })
      return await remember(id)
    }

    case "deadline_moved":
    case "deadline_updated":
    case "submitted":
    case "grade_posted": {
      const id = change.entity.id as Id<"deadlines"> | undefined
      if (!id) return undefined
      const doc = await loadOwned(ctx, "deadlines", id, change.studentId)
      if (!doc) return undefined
      await ctx.db.patch(
        "deadlines",
        id,
        withAssertedProvenance(change, after, pickDeadline(after))
      )
      return id
    }

    case "deadline_removed": {
      const id = change.entity.id as Id<"deadlines"> | undefined
      if (!id) return undefined
      const doc = await loadOwned(ctx, "deadlines", id, change.studentId)
      if (!doc) return undefined
      await ctx.db.patch("deadlines", id, { status: "removed" })
      return id
    }

    case "course_added": {
      if (change.entity.id) {
        const existing = await loadOwned(
          ctx,
          "courses",
          change.entity.id as Id<"courses">,
          change.studentId
        )
        if (existing) {
          await ctx.db.patch("courses", existing._id, pick(after, COURSE_KEYS))
          return existing._id
        }
      }
      const canvasCourseId = asBag(after.sourceRefs).canvasCourseId as
        | string
        | undefined
      if (canvasCourseId) {
        const dupe = await ctx.db
          .query("courses")
          .withIndex("by_student_canvasCourseId", (q) =>
            q
              .eq("studentId", change.studentId)
              .eq("sourceRefs.canvasCourseId", canvasCourseId)
          )
          .first()
        if (dupe) {
          await ctx.db.patch("courses", dupe._id, pick(after, COURSE_KEYS))
          return await remember(dupe._id)
        }
      }
      const id = await ctx.db.insert("courses", {
        studentId: change.studentId,
        name: (after.name as string) ?? "Untitled course",
        code: after.code as string | undefined,
        sourceRefs: (after.sourceRefs as Doc<"courses">["sourceRefs"]) ?? {},
        gradingScheme: after.gradingScheme as Doc<"courses">["gradingScheme"],
        status: (after.status as Doc<"courses">["status"]) ?? "active",
        provenance: provenanceFor(change, after),
      })
      return await remember(id)
    }

    case "course_updated": {
      const id = (change.entity.id ?? change.courseId) as Id<"courses"> | undefined
      if (!id) return undefined
      const doc = await loadOwned(ctx, "courses", id, change.studentId)
      if (!doc) return undefined
      await ctx.db.patch(
        "courses",
        id,
        withAssertedProvenance(change, after, pick(after, COURSE_KEYS))
      )
      return id
    }

    case "task_created": {
      if (change.entity.id) {
        const existing = await loadOwned(
          ctx,
          "tasks",
          change.entity.id as Id<"tasks">,
          change.studentId
        )
        if (existing) {
          await ctx.db.patch("tasks", existing._id, pick(after, TASK_KEYS))
          return existing._id
        }
      }
      const id = await ctx.db.insert("tasks", {
        studentId: change.studentId,
        courseId: (after.courseId ?? change.courseId) as Id<"courses"> | undefined,
        deadlineId: after.deadlineId as Id<"deadlines"> | undefined,
        title: (after.title as string) ?? "Untitled task",
        type: (after.type as Doc<"tasks">["type"]) ?? "do",
        status: (after.status as Doc<"tasks">["status"]) ?? "todo",
        plannedFor: after.plannedFor as string | undefined,
        plannedStartMin: after.plannedStartMin as number | undefined,
        estEffortMin: after.estEffortMin as number | undefined,
        estEffortConfidence:
          after.estEffortConfidence as Doc<"tasks">["estEffortConfidence"],
        actualEffortMin: after.actualEffortMin as number | undefined,
        createdBy: (after.createdBy as Doc<"tasks">["createdBy"]) ?? "agent",
      })
      return await remember(id)
    }

    case "task_updated": {
      const id = change.entity.id as Id<"tasks"> | undefined
      if (!id) return undefined
      const doc = await loadOwned(ctx, "tasks", id, change.studentId)
      if (!doc) return undefined
      await ctx.db.patch("tasks", id, pick(after, TASK_KEYS))
      return id
    }

    case "availability_updated": {
      const id = (change.entity.id ?? change.studentId) as Id<"students">
      // The only student a change may edit is its own.
      if (id !== change.studentId) throw new Error(NOT_YOURS)
      const doc = await ctx.db.get("students", id)
      if (!doc) return undefined
      await ctx.db.patch("students", id, studentPatch(change, after))
      return id
    }

    // A decision reached in chat, or anything else: apply whatever `after`
    // carries to the named entity, or record-only when there is nothing to
    // point at (the change row itself is the durable artifact).
    case "chat_decision":
    case "other": {
      if (!change.entity.id) return undefined
      switch (change.entity.table) {
        case "deadlines": {
          const id = change.entity.id as Id<"deadlines">
          if (!(await loadOwned(ctx, "deadlines", id, change.studentId))) return undefined
          await ctx.db.patch(
            "deadlines",
            id,
            withAssertedProvenance(change, after, pickDeadline(after))
          )
          return id
        }
        case "courses": {
          const id = change.entity.id as Id<"courses">
          if (!(await loadOwned(ctx, "courses", id, change.studentId))) return undefined
          await ctx.db.patch(
            "courses",
            id,
            withAssertedProvenance(change, after, pick(after, COURSE_KEYS))
          )
          return id
        }
        case "tasks": {
          const id = change.entity.id as Id<"tasks">
          if (!(await loadOwned(ctx, "tasks", id, change.studentId))) return undefined
          await ctx.db.patch("tasks", id, pick(after, TASK_KEYS))
          return id
        }
        case "students": {
          const id = change.entity.id as Id<"students">
          if (id !== change.studentId) throw new Error(NOT_YOURS)
          if (!(await ctx.db.get("students", id))) return undefined
          await ctx.db.patch("students", id, studentPatch(change, after))
          return id
        }
      }
      return undefined
    }
  }
}

/**
 * Idempotency for inserts: prefer the id already on the change, then the exact
 * external-id join (Canvas assignment id, then iCal UID — core.md "iCal").
 */
async function findExistingDeadline(
  ctx: MutationCtx,
  change: Doc<"changes">,
  after: Bag
): Promise<Doc<"deadlines"> | null> {
  if (change.entity.id) {
    const byId = await loadOwned(
      ctx,
      "deadlines",
      change.entity.id as Id<"deadlines">,
      change.studentId
    )
    if (byId) return byId
  }
  const externalIds = asBag(after.externalIds)
  const canvasAssignmentId = externalIds.canvasAssignmentId as string | undefined
  if (canvasAssignmentId) {
    const hit = await ctx.db
      .query("deadlines")
      .withIndex("by_student_canvasAssignmentId", (q) =>
        q
          .eq("studentId", change.studentId)
          .eq("externalIds.canvasAssignmentId", canvasAssignmentId)
      )
      .first()
    if (hit) return hit
  }
  const icalUid = externalIds.icalUid as string | undefined
  if (icalUid) {
    const hit = await ctx.db
      .query("deadlines")
      .withIndex("by_student_icalUid", (q) =>
        q.eq("studentId", change.studentId).eq("externalIds.icalUid", icalUid)
      )
      .first()
    if (hit) return hit
  }
  return null
}
