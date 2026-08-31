import { paginationOptsValidator, paginationResultValidator } from "convex/server"
import { v } from "convex/values"

import { internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { internalAction, internalMutation, internalQuery } from "./_generated/server"
import type { FeasibleActions } from "./lib/planner"
import { DEFAULT_HORIZON_DAYS } from "./lib/planner"
import { addDays, localDate, localParts } from "./lib/time"
import {
  pendingAnnotationV,
  planFeasibleV,
  signalsDigestV,
  studentDocV,
  triggerStatusV,
} from "./lib/validators"

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
 *   `storeRun` refreshes the existing row rather than making a second one.
 * - A run already `triggered` never POSTs again.
 * - A run that `failed` (eve down) or is stuck `pending` IS retried, by a later
 *   tick within `RETRY_WINDOW_HOURS` of the student's nightly hour.
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

/** One page of the active roster. Sized for a comfortable query, not a cap. */
const STUDENT_PAGE_SIZE = 200

/** Backstop on the cursor loop; 100 pages is 20k students. */
const MAX_STUDENT_PAGES = 100

/**
 * Paginated, not `.take(N)`: a fixed cap silently drops every student past it
 * from the nightly pass, and nothing records the truncation (CR 3892156231).
 * `tick` walks the cursor to the end of the roster.
 */
export const activeStudents = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(studentDocV),
  handler: async (ctx, args) =>
    await ctx.db
      .query("students")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .paginate(args.paginationOpts),
})

export const findRun = internalQuery({
  args: { operationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      planRunId: v.id("planRuns"),
      triggerStatus: triggerStatusV,
      computedAt: v.number(),
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
      computedAt: run.computedAt,
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
    // Validated at the write boundary, so a malformed snapshot is rejected here
    // rather than surfacing later as a failed Voice read (CR 3892156235).
    feasible: planFeasibleV,
    pendingAnnotations: v.array(pendingAnnotationV),
    signalsDigest: signalsDigestV,
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

/**
 * Records a student the pass could not even date: an unusable `timezone` means
 * no local hour and no "tomorrow", so there is no plan to compute. It is a data
 * problem, and the fix is for someone to see it — a silent `continue` leaves a
 * student who never gets a morning text and no trace of why (CR 3892156241).
 * Keyed on the UTC day so one bad row produces one marker per day, not per tick.
 */
export const markUnusableTimezone = internalMutation({
  args: {
    studentId: v.id("students"),
    date: v.string(),
    computedAt: v.number(),
    error: v.string(),
  },
  returns: v.id("planRuns"),
  handler: async (ctx, args) => {
    const operationId = operationIdFor(args.studentId, args.date)
    const existing = await ctx.db
      .query("planRuns")
      .withIndex("by_operationId", (q) => q.eq("operationId", operationId))
      .first()
    if (existing) {
      await ctx.db.patch("planRuns", existing._id, {
        triggerStatus: "skipped",
        error: args.error,
      })
      return existing._id
    }
    return await ctx.db.insert("planRuns", {
      studentId: args.studentId,
      date: args.date,
      computedAt: args.computedAt,
      feasible: { date: args.date, windows: [], options: [] },
      pendingAnnotations: [],
      signalsDigest: {
        availability: [],
        pacing: [],
        preference: [],
        difficulty: [],
        life_event: [],
        other: [],
      },
      operationId,
      triggerStatus: "skipped",
      error: args.error,
    })
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

/** A run left `pending` this long was interrupted mid-flight; retry it. */
export const STUCK_PENDING_MS = 60 * 60 * 1000

/**
 * How many hours after the nightly hour the pass keeps checking for a run to
 * recover. Bounded so the extra `findRun` read is paid on a handful of ticks a
 * day rather than all 24.
 */
export const RETRY_WINDOW_HOURS = 6

/**
 * Whether this tick should (re)start the pass for a student-day.
 *
 * `triggered` and `skipped` are terminal — the student either got their text or
 * this deployment has no Voice to send one. A `failed` run is the whole point of
 * running hourly: eve was down, and the next pass retries (CR 3892156113). A run
 * still `pending` an hour later never reached its trigger and is retried too.
 */
function shouldRun(
  existing: { triggerStatus: TriggerStatus; computedAt: number } | null,
  now: number
): boolean {
  if (!existing) return true
  if (existing.triggerStatus === "triggered" || existing.triggerStatus === "skipped") {
    return false
  }
  if (existing.triggerStatus === "failed") return true
  return now - existing.computedAt > STUCK_PENDING_MS
}

/**
 * Hourly. Every active student whose local clock just struck their nightly hour
 * and whose run for tomorrow is missing, failed, or stuck gets one. Hourly-and-
 * idempotent rather than one cron per timezone: timezones are per-student data,
 * not deployment config.
 *
 * Each student's run is *scheduled*, not awaited: a slow or hanging eve trigger
 * for one student must not delay or starve the rest of the roster in the same
 * tick (CR 3892161920). `planRuns.operationId` still makes a double tick a no-op.
 */
export const tick = internalAction({
  args: { now: v.optional(v.number()) },
  returns: v.object({ considered: v.number(), started: v.number() }),
  handler: async (ctx, args): Promise<{ considered: number; started: number }> => {
    const now = args.now ?? Date.now()

    let considered = 0
    let started = 0
    let cursor: string | null = null

    for (let page = 0; page < MAX_STUDENT_PAGES; page++) {
      const roster: {
        page: Doc<"students">[]
        isDone: boolean
        continueCursor: string
      } = await ctx.runQuery(internal.nightly.activeStudents, {
        paginationOpts: { numItems: STUDENT_PAGE_SIZE, cursor },
      })
      considered += roster.page.length

      for (const student of roster.page) {
        let hour: number
        let date: string
        try {
          hour = localParts(now, student.timezone).hour
          date = addDays(localDate(now, student.timezone), 1)
        } catch (error) {
          // A data problem, not a reason to stall — but it is recorded, so a
          // student who silently never gets a text is discoverable.
          console.error(
            `nightly: student ${student._id} has an unusable timezone ${JSON.stringify(
              student.timezone
            )}`,
            error
          )
          await ctx.runMutation(internal.nightly.markUnusableTimezone, {
            studentId: student._id,
            date: localDate(now, "UTC"),
            computedAt: now,
            error: `unusable timezone: ${student.timezone}`,
          })
          continue
        }
        // A first run starts exactly on the student's local nightly hour. For
        // the few hours after it, the pass still *looks* — but only to retry a
        // run that failed or got stuck, never to start a day's first one late.
        const nightlyHour = student.nightlyHourLocal ?? DEFAULT_NIGHTLY_HOUR
        const hoursSince = hour - nightlyHour
        if (hoursSince < 0 || hoursSince > RETRY_WINDOW_HOURS) continue

        const existing: {
          planRunId: Id<"planRuns">
          triggerStatus: TriggerStatus
          computedAt: number
          voiceSessionId?: string
        } | null = await ctx.runQuery(internal.nightly.findRun, {
          operationId: operationIdFor(student._id, date),
        })
        if (hoursSince > 0 && !existing) continue // late tick, nothing to recover
        if (!shouldRun(existing, now)) continue

        await ctx.scheduler.runAfter(0, internal.nightly.runForStudent, {
          studentId: student._id,
          date,
          now,
        })
        started++
      }

      if (roster.isDone) break
      cursor = roster.continueCursor
    }

    return { considered, started }
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

/** How long the eve session POST may take before it is a failure. */
export const EVE_TRIGGER_TIMEOUT_MS = 15_000

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
  // Fails closed, like `checkBearer` on the way in: a deployment that set the URL
  // but forgot the token must not POST a student's trigger unauthenticated and
  // then present a config mistake as a transport failure (CR 3892156246).
  if (!token) {
    return { triggerStatus: "skipped", error: "EVE_VOICE_TOKEN not set" }
  }

  const operationId = operationIdFor(args.studentId, args.date)
  const message = `nightly_plan studentId=${args.studentId} date=${args.date} planRunId=${args.planRunId}`

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/eve/v1/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ message, operationId }),
      // An application-level deadline: an eve that accepts the connection and
      // never answers must not hold a scheduled run open (CR 3892156254). A
      // timeout aborts the fetch and is recorded as `failed`, so the next
      // hourly pass retries it.
      signal: AbortSignal.timeout(EVE_TRIGGER_TIMEOUT_MS),
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
