import type { Infer } from "convex/values"

import type { Doc, Id } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
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
 * feed — expired, never applied. Bounded scan: the pending set stays small
 * precisely because this drains it.
 */
export async function expireStaleInternal(
  ctx: MutationCtx,
  studentId: Id<"students">,
  olderThanMs: number,
  limit = 200
): Promise<number> {
  const cutoff = Date.now() - olderThanMs
  const pending = await ctx.db
    .query("changes")
    .withIndex("by_student_status", (q) =>
      q.eq("studentId", studentId).eq("status", "pending")
    )
    .take(limit)

  let expired = 0
  for (const change of pending) {
    if (change.createdAt >= cutoff) continue
    await ctx.db.patch("changes", change._id, {
      status: "expired",
      resolvedAt: Date.now(),
      resolvedVia: "expired",
    })
    expired++
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

function fallbackProvenance(change: Doc<"changes">) {
  return {
    source: change.origin,
    sourceRef: change.reason ?? change._id,
    confidence: change.tier === "auto" ? 1 : 0.5,
    snapshotId: change.snapshotIds[0],
  }
}

/**
 * Writes the entity described by `change`. Idempotent where feasible: an already
 * -applied insert is detected via `entity.id` or the source's external id, and
 * patches are last-write-wins by construction.
 *
 * Returns the entity id the change now points at (undefined for no-ops).
 */
export async function applyChange(
  ctx: MutationCtx,
  change: Doc<"changes">
): Promise<string | undefined> {
  const after = asBag(change.after)

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
        await ctx.db.patch("deadlines", existing._id, pick(after, DEADLINE_KEYS))
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
        provenance:
          (after.provenance as Doc<"deadlines">["provenance"]) ??
          fallbackProvenance(change),
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
      const doc = await ctx.db.get("deadlines", id)
      if (!doc) return undefined
      await ctx.db.patch("deadlines", id, pick(after, DEADLINE_KEYS))
      return id
    }

    case "deadline_removed": {
      const id = change.entity.id as Id<"deadlines"> | undefined
      if (!id) return undefined
      const doc = await ctx.db.get("deadlines", id)
      if (!doc) return undefined
      await ctx.db.patch("deadlines", id, { status: "removed" })
      return id
    }

    case "course_added": {
      if (change.entity.id) {
        const existing = await ctx.db.get(
          "courses",
          change.entity.id as Id<"courses">
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
        provenance:
          (after.provenance as Doc<"courses">["provenance"]) ??
          fallbackProvenance(change),
      })
      return await remember(id)
    }

    case "course_updated": {
      const id = (change.entity.id ?? change.courseId) as Id<"courses"> | undefined
      if (!id) return undefined
      const doc = await ctx.db.get("courses", id)
      if (!doc) return undefined
      await ctx.db.patch("courses", id, pick(after, COURSE_KEYS))
      return id
    }

    case "task_created": {
      if (change.entity.id) {
        const existing = await ctx.db.get("tasks", change.entity.id as Id<"tasks">)
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
      const doc = await ctx.db.get("tasks", id)
      if (!doc) return undefined
      await ctx.db.patch("tasks", id, pick(after, TASK_KEYS))
      return id
    }

    case "availability_updated": {
      const id = (change.entity.id ?? change.studentId) as Id<"students">
      const doc = await ctx.db.get("students", id)
      if (!doc) return undefined
      await ctx.db.patch("students", id, pick(after, STUDENT_KEYS))
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
          if (!(await ctx.db.get("deadlines", id))) return undefined
          await ctx.db.patch("deadlines", id, pick(after, DEADLINE_KEYS))
          return id
        }
        case "courses": {
          const id = change.entity.id as Id<"courses">
          if (!(await ctx.db.get("courses", id))) return undefined
          await ctx.db.patch("courses", id, pick(after, COURSE_KEYS))
          return id
        }
        case "tasks": {
          const id = change.entity.id as Id<"tasks">
          if (!(await ctx.db.get("tasks", id))) return undefined
          await ctx.db.patch("tasks", id, pick(after, TASK_KEYS))
          return id
        }
        case "students": {
          const id = change.entity.id as Id<"students">
          if (!(await ctx.db.get("students", id))) return undefined
          await ctx.db.patch("students", id, pick(after, STUDENT_KEYS))
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
    const byId = await ctx.db.get("deadlines", change.entity.id as Id<"deadlines">)
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
