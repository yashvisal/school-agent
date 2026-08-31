import { v } from "convex/values"

import type { Doc, Id } from "./_generated/dataModel"
import type { QueryCtx } from "./_generated/server"
import { internalQuery, query } from "./_generated/server"
import { requireStudent } from "./lib/auth"
import type { FeasibleActions } from "./lib/planner"
import {
  DEFAULT_HORIZON_DAYS,
  feasibleActions as computeFeasibleActions,
} from "./lib/planner"
import { addDays, startOfLocalDay } from "./lib/time"
import { deadlineKindV, effortConfidenceV } from "./lib/validators"

/**
 * Planner v0, wired to the database. The maths lives in `lib/planner.ts` (pure,
 * unit-tested); this file only loads the applied facts it needs.
 *
 * `internal.planner.compute` is what the nightly pass and the Voice tool call.
 * `api.planner.feasibleActions` is the same thing for Face, behind `requireStudent`.
 */

// ---------------------------------------------------------------------------
// Return validators
//
// Ids are validated as `v.string()` rather than `v.id(...)`: `lib/planner.ts` is
// deliberately Convex-agnostic and types them as strings, and an `Id` is a string
// at runtime. The seam's real contract is documented in `convex/VOICE_TOOLS.md`.
// ---------------------------------------------------------------------------

export const windowV = v.object({
  startMin: v.number(),
  endMin: v.number(),
  durationMin: v.number(),
})

export const fitV = v.object({
  windowIndex: v.number(),
  startMin: v.number(),
  endMin: v.number(),
})

export const pendingAnnotationV = v.object({
  changeId: v.string(),
  kind: v.string(),
  summary: v.string(),
  affectsDate: v.optional(v.string()),
})

export const signalsDigestV = v.object({
  availability: v.array(v.string()),
  pacing: v.array(v.string()),
  preference: v.array(v.string()),
  difficulty: v.array(v.string()),
  life_event: v.array(v.string()),
  other: v.array(v.string()),
})

export const optionV = v.object({
  taskId: v.optional(v.string()),
  deadlineId: v.optional(v.string()),
  courseId: v.optional(v.string()),
  courseName: v.optional(v.string()),
  title: v.string(),
  kind: deadlineKindV,
  dueAt: v.optional(v.number()),
  dueInDays: v.optional(v.number()),
  pointsPossible: v.optional(v.number()),
  category: v.optional(v.string()),
  categoryWeight: v.optional(v.number()),
  estEffortMin: v.number(),
  estEffortConfidence: effortConfidenceV,
  effortSource: v.union(v.literal("prior"), v.literal("signal")),
  fits: v.array(fitV),
  remainingWindowsBeforeDue: v.number(),
  facts: v.array(v.string()),
  pending: v.optional(v.array(v.string())),
  signals: v.optional(v.array(v.string())),
})

export const feasibleActionsV = v.object({
  date: v.string(),
  windows: v.array(windowV),
  options: v.array(optionV),
  pending: v.array(pendingAnnotationV),
  signalsDigest: signalsDigestV,
})

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Bounds on every read path; the planner never scans a table unboundedly. */
const MAX_COURSES = 100
const MAX_DEADLINES = 500
const MAX_UNDATED_DEADLINES = 200
const MAX_TASKS = 500
const MAX_PENDING = 200
const MAX_SIGNALS = 50

/**
 * Sentinel below any plausible timestamp. Convex indexes a missing optional
 * field before every value, so `lt("dueAt", BEFORE_ANY_TIME)` selects exactly
 * the undated deadlines — the ones a range query on `dueAt` would otherwise miss.
 */
const BEFORE_ANY_TIME = -8.64e15

/**
 * Loads the applied facts for `date` and runs the planner. Exported (not
 * registered) so `convex/voice.ts` can reuse it without a `ctx.runQuery` from
 * inside a query.
 */
export async function loadFeasibleActions(
  ctx: QueryCtx,
  args: { studentId: Id<"students">; date: string; now?: number; horizonDays?: number }
): Promise<{ student: Doc<"students">; result: FeasibleActions }> {
  const student = await ctx.db.get("students", args.studentId)
  if (!student) throw new Error("404: student not found")

  const now = args.now ?? Date.now()
  const horizonDays = args.horizonDays ?? DEFAULT_HORIZON_DAYS
  const tz = student.timezone
  const rangeStart = startOfLocalDay(args.date, tz)
  const rangeEnd = startOfLocalDay(addDays(args.date, horizonDays + 1), tz)

  const courses = await ctx.db
    .query("courses")
    .withIndex("by_student", (q) => q.eq("studentId", args.studentId))
    .take(MAX_COURSES)

  // Both ends bounded: a client-controlled date never opens an unbounded scan.
  const dated = await ctx.db
    .query("deadlines")
    .withIndex("by_student_dueAt", (q) =>
      q.eq("studentId", args.studentId).gte("dueAt", rangeStart).lte("dueAt", rangeEnd)
    )
    .take(MAX_DEADLINES)

  const undated = await ctx.db
    .query("deadlines")
    .withIndex("by_student_dueAt", (q) =>
      q.eq("studentId", args.studentId).lt("dueAt", BEFORE_ANY_TIME)
    )
    .take(MAX_UNDATED_DEADLINES)

  const todo = await ctx.db
    .query("tasks")
    .withIndex("by_student_status", (q) =>
      q.eq("studentId", args.studentId).eq("status", "todo")
    )
    .take(MAX_TASKS)

  const inProgress = await ctx.db
    .query("tasks")
    .withIndex("by_student_status", (q) =>
      q.eq("studentId", args.studentId).eq("status", "in_progress")
    )
    .take(MAX_TASKS)

  const pendingChanges = await ctx.db
    .query("changes")
    .withIndex("by_student_status", (q) =>
      q.eq("studentId", args.studentId).eq("status", "pending")
    )
    .take(MAX_PENDING)

  const signals = await ctx.db
    .query("studentSignals")
    .withIndex("by_student_observedAt", (q) => q.eq("studentId", args.studentId))
    .order("desc")
    .take(MAX_SIGNALS)

  const result = computeFeasibleActions({
    date: args.date,
    timezone: tz,
    now,
    student,
    courses,
    deadlines: [...dated, ...undated],
    tasks: [...todo, ...inProgress],
    pendingChanges,
    signals,
    horizonDays,
  })

  return { student, result }
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

const computeArgs = {
  studentId: v.id("students"),
  /** "YYYY-MM-DD" in the student's timezone. */
  date: v.string(),
  /**
   * Wall clock, passed in rather than read: a query is not rerun because time
   * advanced, so `Date.now()` inside one goes stale and defeats the cache.
   * Callers that have no clock opinion may omit it.
   */
  now: v.optional(v.number()),
  horizonDays: v.optional(v.number()),
}

/** Internal: the nightly pass and the Voice tool. No auth — callers are trusted. */
export const compute = internalQuery({
  args: computeArgs,
  returns: feasibleActionsV,
  handler: async (ctx, args) => (await loadFeasibleActions(ctx, args)).result,
})

/**
 * `api.planner.feasibleActions` (core.md, "What Core hands to Voice and Face").
 * Public: Face reads it directly. Identity comes from `ctx.auth` — `studentId`
 * is only a selector, and `requireStudent` proves the caller owns it.
 */
export const feasibleActions = query({
  args: computeArgs,
  returns: feasibleActionsV,
  handler: async (ctx, args) => {
    await requireStudent(ctx, args.studentId)
    return (await loadFeasibleActions(ctx, args)).result
  },
})
