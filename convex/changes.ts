import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"

import { internalMutation, mutation, query } from "./_generated/server"
import { getCurrentStudent, requireStudent } from "./lib/auth"
import type { Id } from "./_generated/dataModel"
import {
  approveChangeInternal,
  expireStaleInternal,
  loadOwned,
  proposeChangeInternal,
  rejectChangeInternal,
} from "./lib/changes"
import type { OwnedTable } from "./lib/changes"
import {
  changeDocV,
  changeEntityV,
  changeKindV,
  changeStatusV,
  inlineEvidenceV,
  originV,
} from "./lib/validators"

/**
 * The changes API. Every mutation to student state flows through here
 * (CLAUDE.md hard constraint); adapters and agent tools call
 * `internal.changes.propose`, the web queue calls `approve` / `reject`.
 */

const proposeResultV = v.object({
  changeId: v.id("changes"),
  status: changeStatusV,
})

/**
 * Internal: the single entry point for adapters, the diff engine, and the three
 * Voice tools. Tiering and application are decided in `lib/changes.ts`.
 */
export const propose = internalMutation({
  args: {
    studentId: v.id("students"),
    courseId: v.optional(v.id("courses")),
    kind: changeKindV,
    entity: changeEntityV,
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    origin: originV,
    snapshotIds: v.optional(v.array(v.id("snapshots"))),
    reason: v.optional(v.string()),
    conflict: v.optional(v.boolean()),
    confirmedInline: v.optional(v.boolean()),
    evidence: v.optional(inlineEvidenceV),
  },
  returns: proposeResultV,
  handler: async (ctx, args) => await proposeChangeInternal(ctx, args),
})

/**
 * The Fix button (face.md "Design rules": every edit is a fact fix, and it goes
 * through `changes` like everything else).
 *
 * Origin is forced to `manual` — the caller does not get to say where the fact
 * came from — which makes `tierFor` call it `needs_approval`. That is the right
 * default for an LLM-free path, and the student's own tap IS the approval, so
 * the change is proposed and approved in the same mutation, exactly as
 * `onboarding.resolvePastDeadlines` does. A correction the student typed must
 * not land in the queue asking the student to confirm it.
 *
 * Scope is narrow on purpose: only the five edit kinds, only the three
 * student-scoped fact tables, only rows that already exist and belong to the
 * caller. `students` is unreachable by construction — the account is edited in
 * Settings, not by a diff card.
 */
const manualKindV = v.union(
  v.literal("deadline_moved"),
  v.literal("deadline_updated"),
  v.literal("deadline_removed"),
  v.literal("course_updated"),
  v.literal("task_updated"),
  v.literal("other")
)

const manualEntityV = v.object({
  table: v.union(v.literal("deadlines"), v.literal("courses"), v.literal("tasks")),
  /** Required: a fix edits a row the student is looking at; it never creates one. */
  id: v.string(),
})

/** Which table each kind is allowed to name, so a kind cannot patch the wrong row. */
const KIND_TABLE: Record<string, OwnedTable | null> = {
  deadline_moved: "deadlines",
  deadline_updated: "deadlines",
  deadline_removed: "deadlines",
  course_updated: "courses",
  task_updated: "tasks",
  // `other` is the escape hatch for a field none of the above name; `applyChange`
  // dispatches it on `entity.table`, so any of the three is coherent.
  other: null,
}

export const proposeManual = mutation({
  args: {
    kind: manualKindV,
    entity: manualEntityV,
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    courseId: v.optional(v.id("courses")),
    reason: v.optional(v.string()),
    /**
     * The pending card this correction answers — the typical Fix ("the syllabus
     * parse said the 12th, it's the 14th"). Rejected in the same transaction so
     * the queue does not keep asking about a value the student just overrode.
     */
    supersedesChangeId: v.optional(v.id("changes")),
  },
  returns: proposeResultV,
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) throw new Error("401: not signed in")

    const required = KIND_TABLE[args.kind]
    if (required && required !== args.entity.table) {
      throw new Error(`400: ${args.kind} edits ${required}, not ${args.entity.table}`)
    }

    const table = args.entity.table
    const entityId = args.entity.id as Id<OwnedTable>
    // Ownership at the front door as well as in `applyChange`: a 404/403 here is
    // an answer the UI can show, where a silently no-op'd apply is a Fix button
    // that appears to work and changes nothing.
    const doc = await loadOwned(ctx, table, entityId, student._id)
    if (!doc) throw new Error("404: entity not found")

    if (args.courseId) {
      const course = await ctx.db.get("courses", args.courseId)
      if (!course || course.studentId !== student._id) {
        throw new Error("403: course does not belong to you")
      }
    }

    if (args.supersedesChangeId) {
      const superseded = await ctx.db.get("changes", args.supersedesChangeId)
      if (!superseded) throw new Error("404: change not found")
      if (superseded.studentId !== student._id) throw new Error("403: forbidden")
      // Idempotent: an already-resolved card is left alone rather than refused,
      // so a double-tap still lands the correction.
      await rejectChangeInternal(ctx, args.supersedesChangeId, "web")
    }

    const { changeId } = await proposeChangeInternal(ctx, {
      studentId: student._id,
      ...(args.courseId ? { courseId: args.courseId } : {}),
      kind: args.kind,
      entity: { table, id: entityId },
      ...(args.before !== undefined ? { before: args.before } : {}),
      ...(args.after !== undefined ? { after: args.after } : {}),
      origin: "manual",
      ...(args.reason ? { reason: args.reason } : {}),
    })
    return await approveChangeInternal(ctx, changeId, "web")
  },
})

/** Approve a pending change (web tap or an inline chat confirmation). */
export const approve = mutation({
  args: {
    changeId: v.id("changes"),
    via: v.union(v.literal("web"), v.literal("chat")),
  },
  returns: proposeResultV,
  handler: async (ctx, args) => {
    const change = await ctx.db.get("changes", args.changeId)
    if (!change) throw new Error("404: change not found")
    await requireStudent(ctx, change.studentId)
    return await approveChangeInternal(ctx, args.changeId, args.via)
  },
})

/**
 * Bulk approval — the onboarding path (core.md rule 2: the web queue holds bulk
 * syllabus/site parses, approved in one gesture). Same semantics as `approve`,
 * per row; already-resolved rows are counted as skipped, not errors, so a
 * double-tap is harmless.
 */
export const approveMany = mutation({
  args: {
    changeIds: v.array(v.id("changes")),
    via: v.union(v.literal("web"), v.literal("chat")),
  },
  returns: v.object({ approved: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    if (args.changeIds.length > 200) {
      throw new Error("400: at most 200 changes per call")
    }
    const student = await getCurrentStudent(ctx)
    if (!student) throw new Error("401: not signed in")
    let approved = 0
    let skipped = 0
    for (const changeId of args.changeIds) {
      const change = await ctx.db.get("changes", changeId)
      // A stale, foreign, or already-resolved id is SKIPPED, not thrown: the
      // mutation is transactional, and one bad id must not roll back the other
      // 199 approvals (CR 3898632494). Foreign rows leak nothing but a count.
      if (!change || change.studentId !== student._id || change.status !== "pending") {
        skipped++
        continue
      }
      await approveChangeInternal(ctx, changeId, args.via)
      approved++
    }
    return { approved, skipped }
  },
})

/** Reject a pending change. Never applied. */
export const reject = mutation({
  args: { changeId: v.id("changes") },
  returns: proposeResultV,
  handler: async (ctx, args) => {
    const change = await ctx.db.get("changes", args.changeId)
    if (!change) throw new Error("404: change not found")
    await requireStudent(ctx, change.studentId)
    return await rejectChangeInternal(ctx, args.changeId, "web")
  },
})

/**
 * The web approval queue: only what chat could not confirm in flow (rule 2).
 * Standard Convex pagination — the queue is meant to be drained, but a deep one
 * must still be fully visible, not cut at an arbitrary window (CR 3892156162).
 */
export const listPending = query({
  args: {
    studentId: v.id("students"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireStudent(ctx, args.studentId)
    return await ctx.db
      .query("changes")
      .withIndex("by_student_status", (q) =>
        q.eq("studentId", args.studentId).eq("status", "pending")
      )
      .order("desc")
      .paginate(args.paginationOpts)
  },
})

/**
 * The change feed for Face's Dashboard, newest first, identity-scoped
 * (lib/data/README.md: Face never passes a studentId). Raw `before`/`after`
 * bags ride along; the diff lines, summary, and tool label are presentation and
 * are derived client-side in `lib/data/hooks.ts`.
 */
export const feed = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(changeDocV),
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) return []
    const limit = clampLimit(args.limit, 50, 200)
    return await ctx.db
      .query("changes")
      .withIndex("by_student_createdAt", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(limit)
  },
})

/** "New since you last looked" — the change feed, newest first. */
export const listRecent = query({
  args: {
    studentId: v.id("students"),
    limit: v.optional(v.number()),
  },
  returns: v.array(changeDocV),
  handler: async (ctx, args) => {
    await requireStudent(ctx, args.studentId)
    const limit = clampLimit(args.limit, 50, 200)
    return await ctx.db
      .query("changes")
      .withIndex("by_student_createdAt", (q) => q.eq("studentId", args.studentId))
      .order("desc")
      .take(limit)
  },
})

/**
 * Internal: drop pending changes older than the horizon (rule 5). They are
 * marked `expired` and never applied.
 */
export const expireStale = internalMutation({
  args: {
    studentId: v.id("students"),
    olderThanMs: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.olderThanMs) || args.olderThanMs < 0) {
      throw new Error("olderThanMs must be a finite, non-negative number")
    }
    return await expireStaleInternal(ctx, args.studentId, args.olderThanMs)
  },
})

function clampLimit(limit: number | undefined, fallback: number, max: number) {
  if (limit === undefined) return fallback
  if (!Number.isFinite(limit) || limit < 1) return fallback
  return Math.min(Math.floor(limit), max)
}
