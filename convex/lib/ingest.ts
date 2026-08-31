import type { Doc, Id } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { ChangeOrigin } from "./changes"
import { proposeChangeInternal } from "./changes"
import type { ChangeProposal } from "./diff"
import type { NormalizedMaterial } from "./normalized"

/**
 * Shared plumbing between the ingestion adapters. Everything student-facing
 * here goes through `proposeChangeInternal` — the changes pipeline is the only
 * write path to student state (CLAUDE.md hard constraint).
 *
 * The one exception, deliberately: `materials`. Files, modules, pages and
 * announcements are *raw captures* of what a course published, not facts about
 * the student, so they are upserted directly. Nothing plans on them, nothing
 * approves them, and routing them through `changes` would flood the feed with
 * noise the student never asked about (core.md: "the Canvas adapter captures
 * files/modules/pages now (raw, cheap)").
 */

// ---------------------------------------------------------------------------
// snapshots
// ---------------------------------------------------------------------------

export async function latestSnapshot(
  ctx: QueryCtx | MutationCtx,
  sourceId: Id<"sources">
): Promise<Doc<"snapshots"> | null> {
  return await ctx.db
    .query("snapshots")
    .withIndex("by_source_fetchedAt", (q) => q.eq("sourceId", sourceId))
    .order("desc")
    .first()
}

export type StoreSnapshotResult = {
  snapshotId: Id<"snapshots">
  created: boolean
  previous: Doc<"snapshots"> | null
}

/**
 * Immutable, and written **only when the hash changes** (core.md "State model":
 * identical polls just bump `sources.lastPolledAt`). Returns the previous
 * snapshot alongside, because the diff always re-normalizes from snapshots
 * rather than trusting any cached normalized state.
 */
export async function storeSnapshot(
  ctx: MutationCtx,
  input: {
    sourceId: Id<"sources">
    studentId: Id<"students">
    payload: unknown
    contentHash: string
    label?: string
    fetchedAt?: number
  }
): Promise<StoreSnapshotResult> {
  const now = Date.now()
  const previous = await latestSnapshot(ctx, input.sourceId)

  if (previous && previous.contentHash === input.contentHash) {
    await ctx.db.patch("sources", input.sourceId, { lastPolledAt: now })
    return { snapshotId: previous._id, created: false, previous }
  }

  const snapshotId = await ctx.db.insert("snapshots", {
    sourceId: input.sourceId,
    studentId: input.studentId,
    fetchedAt: input.fetchedAt ?? now,
    contentHash: input.contentHash,
    payload: input.payload,
    label: input.label,
  })
  await ctx.db.patch("sources", input.sourceId, { lastPolledAt: now })
  return { snapshotId, created: true, previous }
}

// ---------------------------------------------------------------------------
// entity resolution
// ---------------------------------------------------------------------------

export type ExternalIds = {
  canvasAssignmentId?: string
  icalUid?: string
}

const asBag = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const externalIdsOf = (value: unknown): ExternalIds => {
  const ids = asBag(asBag(value).externalIds)
  return {
    canvasAssignmentId:
      typeof ids.canvasAssignmentId === "string" ? ids.canvasAssignmentId : undefined,
    icalUid: typeof ids.icalUid === "string" ? ids.icalUid : undefined,
  }
}

/** Exact join, Canvas assignment id first, then the iCal UID (core.md "Adapters" #2). */
export async function findDeadlineByExternalIds(
  ctx: QueryCtx | MutationCtx,
  studentId: Id<"students">,
  ids: ExternalIds
): Promise<Doc<"deadlines"> | null> {
  if (ids.canvasAssignmentId) {
    const hit = await ctx.db
      .query("deadlines")
      .withIndex("by_student_canvasAssignmentId", (q) =>
        q
          .eq("studentId", studentId)
          .eq("externalIds.canvasAssignmentId", ids.canvasAssignmentId)
      )
      .first()
    if (hit) return hit
  }
  if (ids.icalUid) {
    const hit = await ctx.db
      .query("deadlines")
      .withIndex("by_student_icalUid", (q) =>
        q.eq("studentId", studentId).eq("externalIds.icalUid", ids.icalUid)
      )
      .first()
    if (hit) return hit
  }
  return null
}

export async function findCourseByCanvasId(
  ctx: QueryCtx | MutationCtx,
  studentId: Id<"students">,
  canvasCourseId: string
): Promise<Doc<"courses"> | null> {
  return await ctx.db
    .query("courses")
    .withIndex("by_student_canvasCourseId", (q) =>
      q.eq("studentId", studentId).eq("sourceRefs.canvasCourseId", canvasCourseId)
    )
    .first()
}

/**
 * The student's courses, bounded. A student has tens of courses across a degree,
 * not thousands, so a single `take` is the whole set and keeps the mapping from
 * external key to `Id<"courses">` in one read.
 */
export async function loadCourses(
  ctx: QueryCtx | MutationCtx,
  studentId: Id<"students">,
  limit = 200
): Promise<Doc<"courses">[]> {
  return await ctx.db
    .query("courses")
    .withIndex("by_student", (q) => q.eq("studentId", studentId))
    .take(limit)
}

/** `canvas:course:<id>` → the Convex row, for whatever already exists. */
export function courseIdIndex(courses: Doc<"courses">[]): Map<string, Id<"courses">> {
  const map = new Map<string, Id<"courses">>()
  for (const course of courses) {
    if (course.sourceRefs.canvasCourseId) {
      map.set(`canvas:course:${course.sourceRefs.canvasCourseId}`, course._id)
    }
    if (course.code) map.set(`code:${course.code.toLowerCase()}`, course._id)
  }
  return map
}

// ---------------------------------------------------------------------------
// proposals -> changes
// ---------------------------------------------------------------------------

export type ApplyProposalsInput = {
  studentId: Id<"students">
  proposals: ChangeProposal[]
  origin: ChangeOrigin
  /** Snapshot this batch was derived FROM; stamped onto each fact's provenance. */
  snapshotId: Id<"snapshots">
  /** Snapshots that explain the diff (prev first, when any); stored on the change row. */
  snapshotIds: Id<"snapshots">[]
  /** External course key → Convex id. Mutated as `course_added` changes apply. */
  courseIds: Map<string, Id<"courses">>
  /** Course used for deadlines whose feed does not name one. */
  fallbackCourseId?: Id<"courses">
}

export type ApplyProposalsResult = {
  proposed: number
  applied: number
  pending: number
  skipped: number
}

/**
 * Turns diff/reconcile output into `changes` rows. Every proposal — including
 * the ones that apply immediately — becomes a durable, replayable change row
 * carrying its snapshot ids, so the feed can always answer "why did this move".
 */
/**
 * Stamps `provenance.snapshotId` on a proposal's `after` bag. Only touches a
 * payload that already carries a provenance object — a partial `after` (the
 * `{ dueAt }` a conflict proposal carries) is left exactly as it was.
 */
function withSnapshotProvenance(
  after: unknown,
  snapshotId: Id<"snapshots"> | undefined
): unknown {
  if (after === undefined || snapshotId === undefined) return after
  const bag = asBag(after)
  const provenance = bag.provenance
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return after
  }
  return {
    ...bag,
    provenance: { ...(provenance as Record<string, unknown>), snapshotId },
  }
}

export async function applyProposals(
  ctx: MutationCtx,
  input: ApplyProposalsInput
): Promise<ApplyProposalsResult> {
  const result: ApplyProposalsResult = { proposed: 0, applied: 0, pending: 0, skipped: 0 }

  // core.md requires every stored fact to carry the snapshot that produced it;
  // it is stamped onto each proposal's provenance before the change is written.
  // The id is passed explicitly rather than read off `snapshotIds` ordering
  // (CR 3897465438): the change row's `snapshotIds` explains the diff,
  // `provenance.snapshotId` explains the row.
  const snapshotId = input.snapshotId

  for (const proposal of input.proposals) {
    let courseId: Id<"courses"> | undefined
    let entityId: string | undefined = proposal.entityId

    if (proposal.entity === "courses") {
      courseId = input.courseIds.get(proposal.key)
      entityId = entityId ?? courseId
    } else {
      courseId = proposal.courseKey
        ? input.courseIds.get(proposal.courseKey)
        : undefined
      courseId = courseId ?? input.fallbackCourseId

      if (!entityId) {
        const existing = await findDeadlineByExternalIds(
          ctx,
          input.studentId,
          externalIdsOf(proposal.after ?? proposal.before)
        )
        entityId = existing?._id
      }

      // A deadline needs a course. If the feed never named one and there is no
      // fallback, skip rather than inventing a home for it.
      if (proposal.kind === "deadline_added" && !courseId) {
        result.skipped++
        continue
      }
      if (proposal.kind !== "deadline_added" && !entityId) {
        result.skipped++
        continue
      }
    }

    const withCourse =
      proposal.entity === "deadlines" && courseId && proposal.after
        ? { ...asBag(proposal.after), courseId }
        : proposal.after
    const after = withSnapshotProvenance(withCourse, snapshotId)

    const outcome = await proposeChangeInternal(ctx, {
      studentId: input.studentId,
      ...(courseId ? { courseId } : {}),
      kind: proposal.kind,
      entity: {
        table: proposal.entity,
        ...(entityId ? { id: entityId } : {}),
      },
      ...(proposal.before !== undefined ? { before: proposal.before } : {}),
      ...(after !== undefined ? { after } : {}),
      origin: input.origin,
      snapshotIds: input.snapshotIds,
      ...(proposal.reason ? { reason: proposal.reason } : {}),
      ...(proposal.conflict ? { conflict: true } : {}),
    })

    result.proposed++
    if (outcome.status === "pending") result.pending++
    else result.applied++

    // `course_added` mints the row; later deadlines in this same batch need it.
    if (proposal.entity === "courses" && !input.courseIds.has(proposal.key)) {
      const change = await ctx.db.get("changes", outcome.changeId)
      if (change?.entity.id) {
        input.courseIds.set(proposal.key, change.entity.id as Id<"courses">)
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

/**
 * Raw course captures, upserted directly (see the module comment for why they
 * do NOT go through `changes`). Idempotent on `(courseId, externalId)`.
 */
export async function upsertMaterials(
  ctx: MutationCtx,
  input: {
    studentId: Id<"students">
    materials: NormalizedMaterial[]
    courseIds: Map<string, Id<"courses">>
  }
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const material of input.materials) {
    const courseId = input.courseIds.get(material.courseKey)
    if (!courseId) {
      skipped++
      continue
    }
    const existing = await ctx.db
      .query("materials")
      .withIndex("by_course_externalId", (q) =>
        q.eq("courseId", courseId).eq("externalId", material.externalId)
      )
      .first()

    const fields = {
      kind: material.kind,
      title: material.title,
      raw: material.raw,
      provenance: material.provenance,
    }
    if (existing) {
      await ctx.db.patch("materials", existing._id, fields)
      updated++
    } else {
      await ctx.db.insert("materials", {
        studentId: input.studentId,
        courseId,
        externalId: material.externalId,
        ...fields,
      })
      inserted++
    }
  }

  return { inserted, updated, skipped }
}
