import { v } from "convex/values"

import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalAction, internalMutation, internalQuery } from "./_generated/server"
import type { FeasibleActions } from "./lib/planner"
import { DEFAULT_HORIZON_DAYS } from "./lib/planner"
import { addDays, localDate, localParts } from "./lib/time"
import { studentDocV, triggerStatusV } from "./lib/validators"

/**
 * Nightly precompute → Voice trigger (core.md, "Nightly precompute"; vision §6.1).
 *
 * Division of labour: **Convex decides who gets a run and what is true; eve
 * decides what to say.** This file computes tomorrow's feasible set, stores it as
 * a `planRuns` snapshot, and pokes eve's session endpoint with an idempotent
 * `operationId`. It composes nothing.
 *
 * Idempotency is layered, because the cron runs hourly and both ends can retry:
 * - `planRuns.operationId` (`nightly:<studentId>:<date>`) is unique per student-day;
 *   `storeRun` returns the existing row rather than making a second one.
 * - A run already `triggered` never POSTs again.
 * - eve's `POST /eve/v1/session` honours the same `operationId` for create-once
 *   semantics, so even a double POST returns the first session.
 *
 * A deployment with no Voice attached (every dev deployment, until Spike A lands)
 * records `triggerStatus: "skipped"` and carries on. Missing Voice is not a
 * failed plan.
 */

/** Local hour the pass runs when the student has not chosen one. */
export const DEFAULT_NIGHTLY_HOUR = 4

/** Pending changes older than the planning horizon are expired, never applied (rule 5). */
const PENDING_TTL_MS = DEFAULT_HORIZON_DAYS * 24 * 60 * 60 * 1000

/**
 * Explicit shapes for the same-file `ctx.run*` calls below. TypeScript cannot
 * infer through a self-referential `internal.nightly.*` reference, so every such
 * result is annotated (see the Convex guidelines, "Function calling").
 */
export type TriggerStatus = "pending" | "triggered" | "failed" | "skipped"

export type RunResult = {
  planRunId: Id<"planRuns">
  date: string
  triggerStatus: TriggerStatus
  voiceSessionId?: string
  error?: string
}

const runResultV = v.object({
  planRunId: v.id("planRuns"),
  date: v.string(),
  triggerStatus: triggerStatusV,
  voiceSessionId: v.optional(v.string()),
  error: v.optional(v.string()),
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const MAX_ACTIVE_STUDENTS = 500

export const activeStudents = internalQuery({
  args: {},
  returns: v.array(studentDocV),
  handler: async (ctx) =>
    await ctx.db
      .query("students")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(MAX_ACTIVE_STUDENTS),
})

export const findRun = internalQuery({
  args: { operationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      planRunId: v.id("planRuns"),
      triggerStatus: triggerStatusV,
      voiceSessionId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("planRuns")
      .withIndex("by_operationId", (q) => q.eq("operationId", args.operationId))
      .first()
    if (!run) return null
    return {
      planRunId: run._id,
      triggerStatus: run.triggerStatus,
      voiceSessionId: run.voiceSessionId,
    }
  },
})

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export const operationIdFor = (studentId: string, date: string) =>
  `nightly:${studentId}:${date}`

/**
 * Inserts (or refreshes) the `planRuns` snapshot for a student-day. Idempotent on
 * `by_operationId`: a run that already reached eve is returned untouched, so a
 * retried pass can never produce a second morning text.
 */
export const storeRun = internalMutation({
  args: {
    studentId: v.id("students"),
    date: v.string(),
    computedAt: v.number(),
    feasible: v.any(),
    pendingAnnotations: v.any(),
    signalsDigest: v.any(),
  },
  returns: v.object({
    planRunId: v.id("planRuns"),
    alreadyTriggered: v.boolean(),
    voiceSessionId: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const operationId = operationIdFor(args.studentId, args.date)
    const existing = await ctx.db
      .query("planRuns")
      .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
      .first()

    if (existing) {
      if (existing.triggerStatus === "triggered") {
        return {
          planRunId: existing._id,
          alreadyTriggered: true,
          voiceSessionId: existing.voiceSessionId,
        }
      }
      // Not yet delivered: refresh the snapshot so the retry sends today's facts.
      await ctx.db.patch("planRuns", existing._id, {
        computedAt: args.computedAt,
        feasible: args.feasible,
        pendingAnnotations: args.pendingAnnotations,
        signalsDigest: args.signalsDigest,
        triggerStatus: "pending",
        error: undefined,
      })
      return { planRunId: existing._id, alreadyTriggered: false }
    }

    const planRunId = await ctx.db.insert("planRuns", {
      studentId: args.studentId,
      date: args.date,
      computedAt: args.computedAt,
      feasible: args.feasible,
      pendingAnnotations: args.pendingAnnotations,
      signalsDigest: args.signalsDigest,
      operationId,
      triggerStatus: "pending",
    })
    return { planRunId, alreadyTriggered: false }
  },
})

export const markTrigger = internalMutation({
  args: {
    planRunId: v.id("planRuns"),
    triggerStatus: triggerStatusV,
    voiceSessionId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch("planRuns", args.planRunId, {
      triggerStatus: args.triggerStatus,
      voiceSessionId: args.voiceSessionId,
      error: args.error,
    })
    return null
  },
})

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

/**
 * Hourly. Every active student whose local clock just struck their nightly hour
 * and who has no run for tomorrow yet gets one. Hourly-and-idempotent rather
 * than one cron per timezone: timezones are per-student data, not deployment
 * config, and a missed hour self-heals on the next tick of the same local day.
 */
export const tick = internalAction({
  args: { now: v.optional(v.number()) },
  returns: v.object({ considered: v.number(), started: v.number() }),
  handler: async (ctx, args): Promise<{ considered: number; started: number }> => {
    const now = args.now ?? Date.now()
    const students: Doc<"students">[] = await ctx.runQuery(
      internal.nightly.activeStudents,
      {}
    )

    let started = 0
    for (const student of students) {
      let hour: number
      let date: string
      try {
        hour = localParts(now, student.timezone).hour
        date = addDays(localDate(now, student.timezone), 1)
      } catch {
        continue // an unusable timezone is a data problem, not a reason to stall
      }
      if (hour !== (student.nightlyHourLocal ?? DEFAULT_NIGHTLY_HOUR)) continue

      const existing: {
        planRunId: Id<"planRuns">
        triggerStatus: TriggerStatus
        voiceSessionId?: string
      } | null = await ctx.runQuery(internal.nightly.findRun, {
        operationId: operationIdFor(student._id, date),
      })
      if (existing) continue

      await ctx.runAction(internal.nightly.runForStudent, {
        studentId: student._id,
        date,
        now,
      })
      started++
    }
    return { considered: students.length, started }
  },
})

/**
 * One student, one day: drain stale pending changes, compute the plan, store it,
 * then trigger the Voice run.
 */
export const runForStudent = internalAction({
  args: {
    studentId: v.id("students"),
    date: v.string(),
    now: v.optional(v.number()),
  },
  returns: runResultV,
  handler: async (ctx, args): Promise<RunResult> => {
    const now = args.now ?? Date.now()

    // (a) Rule 5 — nothing rots in the queue past the horizon.
    await ctx.runMutation(internal.changes.expireStale, {
      studentId: args.studentId,
      olderThanMs: PENDING_TTL_MS,
    })

    // (b) The plan, on applied facts only.
    const plan: FeasibleActions = await ctx.runQuery(internal.planner.compute, {
      studentId: args.studentId,
      date: args.date,
      now,
    })

    // (c) The snapshot. Idempotent on operationId.
    const stored: {
      planRunId: Id<"planRuns">
      alreadyTriggered: boolean
      voiceSessionId?: string
    } = await ctx.runMutation(internal.nightly.storeRun, {
      studentId: args.studentId,
      date: args.date,
      computedAt: now,
      feasible: { date: plan.date, windows: plan.windows, options: plan.options },
      pendingAnnotations: plan.pending,
      signalsDigest: plan.signalsDigest,
    })

    if (stored.alreadyTriggered) {
      return {
        planRunId: stored.planRunId,
        date: args.date,
        triggerStatus: "triggered" as const,
        voiceSessionId: stored.voiceSessionId,
      }
    }

    // (d) The trigger.
    const outcome = await triggerVoice({
      studentId: args.studentId,
      date: args.date,
      planRunId: stored.planRunId,
    })
    await ctx.runMutation(internal.nightly.markTrigger, {
      planRunId: stored.planRunId,
      triggerStatus: outcome.triggerStatus,
      voiceSessionId: outcome.voiceSessionId,
      error: outcome.error,
    })

    return { planRunId: stored.planRunId, date: args.date, ...outcome }
  },
})

/**
 * Manual entry point for testing:
 * `npx convex run nightly:runNow '{"studentId": "..."}'`
 * Defaults to tomorrow in the student's own timezone.
 */
export const runNow = internalAction({
  args: {
    studentId: v.id("students"),
    date: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  returns: runResultV,
  handler: async (ctx, args): Promise<RunResult> => {
    const now = args.now ?? Date.now()
    const student: Doc<"students"> | null = await ctx.runQuery(internal.students.get, {
      studentId: args.studentId,
    })
    if (!student) throw new Error("404: student not found")
    const date = args.date ?? addDays(localDate(now, student.timezone), 1)

    const result: RunResult = await ctx.runAction(internal.nightly.runForStudent, {
      studentId: args.studentId,
      date,
      now,
    })
    return result
  },
})

// ---------------------------------------------------------------------------
// eve session trigger
// ---------------------------------------------------------------------------

type TriggerOutcome = {
  triggerStatus: "triggered" | "failed" | "skipped"
  voiceSessionId?: string
  error?: string
}

/**
 * `POST /eve/v1/session` with `{ message, operationId }` and a bearer token
 * (`node_modules/eve/docs/channels/eve.mdx`). The same `operationId` under the
 * same principal returns the session eve already created, so a retry from either
 * side is a no-op rather than a second text.
 *
 * The message is a machine-readable trigger line, not prose: composition is
 * eve's job, and Voice reads the plan back through `getFeasibleActions`.
 */
async function triggerVoice(args: {
  studentId: Id<"students">
  date: string
  planRunId: Id<"planRuns">
}): Promise<TriggerOutcome> {
  const baseUrl = process.env.EVE_VOICE_URL
  if (!baseUrl) {
    return { triggerStatus: "skipped", error: "EVE_VOICE_URL not set" }
  }
  const token = process.env.EVE_VOICE_TOKEN

  const operationId = operationIdFor(args.studentId, args.date)
  const message = `nightly_plan studentId=${args.studentId} date=${args.date} planRunId=${args.planRunId}`

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/eve/v1/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message, operationId }),
    })

    const text = await response.text()
    if (!response.ok) {
      return {
        triggerStatus: "failed",
        error: `eve returned ${response.status}: ${text.slice(0, 500)}`,
      }
    }

    let sessionId: string | undefined
    try {
      const parsed: unknown = JSON.parse(text)
      const bag = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
      if (typeof bag.sessionId === "string") sessionId = bag.sessionId
    } catch {
      // A 2xx with an unreadable body still means the run was accepted.
    }
    return { triggerStatus: "triggered", voiceSessionId: sessionId }
  } catch (error) {
    return {
      triggerStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
