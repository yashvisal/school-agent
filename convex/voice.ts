import { v } from "convex/values"

import type { Id } from "./_generated/dataModel"
import type { QueryCtx } from "./_generated/server"
import { internalMutation, internalQuery } from "./_generated/server"
import { proposeChangeInternal, tierFor } from "./lib/changes"
import { normalizePhone } from "./lib/phone"
import { normalizeConfidence, recordSignalInternal } from "./lib/signals"
import {
  changeEntityV,
  changeKindV,
  changeStatusV,
  inlineEvidenceV,
  planV,
  signalKindV,
  surfaceV,
  tierV,
} from "./lib/validators"
import { formatClock, localDate, localMinutes } from "./lib/time"
import { loadFeasibleActions } from "./planner"
import { signalRefsV } from "./signals"

/**
 * The Voice tool surface — the ENTIRE reach eve's Voice agent has into Core
 * (vision §10 "the tool boundary is the seam", core.md "the three Voice tools").
 *
 *   getFeasibleActions  read the plan   — never the raw tables
 *   proposeChange       write state     — always through `changes`
 *   commitPlan          write the plan  — the picks it just named, verified
 *   recordSignal        write learning  — `studentSignals`, text as told
 *
 * Nothing else is reachable. These are `internal*` functions: Voice runs outside
 * Convex and calls them over the HTTP routes in `convex/http.ts`, which
 * authenticate with `CORE_AGENT_SECRET`. Keeping them internal means the public
 * API surface stays exactly what Face needs and nothing more.
 *
 * `logUsage` below is a fifth route but NOT a planning tool: it is the mandatory
 * per-call cost record (vision §10 cost posture), not a way to see or change the
 * plan. The seam is four tools; this is bookkeeping.
 */

// ---------------------------------------------------------------------------
// getFeasibleActions
// ---------------------------------------------------------------------------

/** A nightly precompute this fresh is reused instead of recomputed. */
export const PLAN_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** The response shape, declared once in `lib/validators.ts`. Re-exported here. */
export const voiceFeasibleV = planV

/**
 * True when anything landed in `changes` after the snapshot was computed.
 *
 * A cached plan is only safe to serve while the facts it was built on still
 * hold. A change created since — or, more importantly, *resolved* since (an
 * approval in chat, a rejection, an auto-applied Canvas poll) — means the
 * snapshot describes a day that no longer exists, and Voice would answer a
 * follow-up with facts the student has already corrected.
 */
async function changedSince(
  ctx: QueryCtx,
  studentId: Id<"students">,
  computedAt: number
): Promise<boolean> {
  const created = await ctx.db
    .query("changes")
    .withIndex("by_student_createdAt", (q) =>
      q.eq("studentId", studentId).gt("createdAt", computedAt)
    )
    .first()
  if (created) return true

  const resolved = await ctx.db
    .query("changes")
    .withIndex("by_student_resolvedAt", (q) =>
      q.eq("studentId", studentId).gt("resolvedAt", computedAt)
    )
    .first()
  return resolved !== null
}

/**
 * The plan for `date`. Serves the nightly `planRuns` snapshot when one was
 * computed within `PLAN_CACHE_MAX_AGE_MS` *and* nothing has changed since, so
 * the morning text and any follow-up in the same conversation describe the same
 * day; otherwise recomputes live.
 */
export const getFeasibleActions = internalQuery({
  args: {
    studentId: v.id("students"),
    date: v.string(),
    now: v.optional(v.number()),
  },
  returns: planV,
  handler: async (ctx, args) => await loadPlan(ctx, args),
})

/**
 * The cache-aware plan load, shared by `getFeasibleActions` and `commitPlan`.
 *
 * `commitPlan` verifies every pick against the feasible set, and it must be the
 * SAME set the agent was shown or the verification is theatre: the agent would
 * be told "9–11 fits" by a cached snapshot and refused by a live recompute.
 * One function, one cache rule (CLAUDE.md: the tool boundary is the seam).
 */
async function loadPlan(
  ctx: QueryCtx,
  args: { studentId: Id<"students">; date: string; now?: number }
): Promise<typeof planV.type> {
  const now = args.now ?? Date.now()

  const run = await ctx.db
    .query("planRuns")
    .withIndex("by_student_date", (q) =>
      q.eq("studentId", args.studentId).eq("date", args.date)
    )
    .order("desc")
    .first()

  const fresh =
    run !== null &&
    now - run.computedAt <= PLAN_CACHE_MAX_AGE_MS &&
    !(await changedSince(ctx, args.studentId, run.computedAt))

  if (run && fresh) {
    const student = await ctx.db.get("students", args.studentId)
    if (!student) throw new Error("404: student not found")
    // Annotated rather than cast: a new required field on `planV` must fail to
    // compile here, not fail its `returns` validator at runtime (CR 3892156276).
    const cached: typeof planV.type = {
      planRunId: run._id,
      computedAt: run.computedAt,
      cached: true,
      timezone: student.timezone,
      date: run.feasible.date,
      windows: run.feasible.windows,
      options: run.feasible.options,
      pending: run.pendingAnnotations,
      signalsDigest: run.signalsDigest,
    }
    return cached
  }

  const { student, result } = await loadFeasibleActions(ctx, {
    studentId: args.studentId,
    date: args.date,
    now,
  })
  // No `planRunId`: this plan did not come from the stored run, and citing a
  // snapshot that was not used would misstate its provenance (CR 3892156287).
  return {
    planRunId: undefined,
    computedAt: now,
    cached: false,
    timezone: student.timezone,
    ...result,
  }
}

// ---------------------------------------------------------------------------
// proposeChange
// ---------------------------------------------------------------------------

export const voiceChangeV = v.object({
  courseId: v.optional(v.id("courses")),
  kind: changeKindV,
  entity: changeEntityV,
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  reason: v.optional(v.string()),
  conflict: v.optional(v.boolean()),
  /**
   * The student confirmed it in the same exchange. Rule 1: an inline chat
   * confirmation is a first-class approval, equal to a web tap — it applies and
   * does NOT also wait in the web queue.
   */
  confirmedInline: v.optional(v.boolean()),
  /**
   * REQUIRED with `confirmedInline`. Accountability, not proof: the quoted
   * reply is shown in the change feed ("confirmed in chat: 'yeah'") so a
   * claimed approval is visible and contestable (VOICE_TOOLS.md §4).
   */
  evidence: v.optional(inlineEvidenceV),
})

/**
 * The only write path Voice has into student state. Everything lands in
 * `changes` and is tiered there (core.md, "Two-tier apply rule"): chat-origin
 * changes are `needs_approval`, applied immediately only when `confirmedInline`.
 *
 * **`origin` is not a caller choice.** It is forced to `chat` here: everything
 * Voice proposes was interpreted from a message, and `tierFor` maps `canvas` and
 * `ical` to the `auto` tier, so an accepted origin would let Voice apply a change
 * to student state with no source evidence and no approval — self-elevation past
 * the whole two-tier rule (CR 3892156302). `lib/changes.ts` independently
 * overwrites any `after.provenance` claiming a structured source.
 */
const VOICE_ORIGIN = "chat" as const

export const proposeChange = internalMutation({
  args: {
    studentId: v.id("students"),
    change: voiceChangeV,
  },
  returns: v.object({
    changeId: v.id("changes"),
    status: changeStatusV,
    tier: tierV,
  }),
  handler: async (ctx, args) => {
    const { changeId, status } = await proposeChangeInternal(ctx, {
      studentId: args.studentId,
      courseId: args.change.courseId,
      kind: args.change.kind,
      entity: args.change.entity,
      before: args.change.before,
      after: args.change.after,
      origin: VOICE_ORIGIN,
      reason: args.change.reason,
      conflict: args.change.conflict,
      confirmedInline: args.change.confirmedInline,
      evidence: args.change.evidence,
    })
    return { changeId, status, tier: tierFor(VOICE_ORIGIN, args.change.conflict) }
  },
})

// ---------------------------------------------------------------------------
// commitPlan
// ---------------------------------------------------------------------------

/**
 * One block the agent named in the thread. Identified the way the agent saw it:
 * an existing `taskId`, else the `deadlineId` the work belongs to, else the
 * `title` + `courseId` of a free-standing task. Times are minutes from local
 * midnight, and are verified against the feasible set before anything is written.
 */
export const planPickV = v.object({
  taskId: v.optional(v.id("tasks")),
  deadlineId: v.optional(v.id("deadlines")),
  title: v.optional(v.string()),
  courseId: v.optional(v.id("courses")),
  startMin: v.number(),
  endMin: v.number(),
})

/** The morning text names 1–3 things. A "plan" longer than that is a list. */
export const MAX_PICKS = 3

/** Bound on the unplan sweep; a semester is a few hundred tasks. */
const MAX_TASK_SCAN = 1000

/**
 * `origin` is not a caller choice here either. `commitPlan` is the ONLY thing in
 * Core that emits `planner`, and it does so having just re-verified every pick
 * against its own feasible set — that verification is what earns the `auto`
 * tier (`lib/changes.ts`, `AUTHORITATIVE_ORIGINS`). The generic
 * `/voice/proposeChange` route still forces `chat`, so Voice cannot reach this
 * origin by asking for it.
 */
const PLANNER_ORIGIN = "planner" as const

type Plan = typeof planV.type
type PlanOption = Plan["options"][number]
type PlanPick = typeof planPickV.type

const describePick = (pick: PlanPick, option?: PlanOption): string => {
  const label =
    option?.title ?? pick.title ?? pick.taskId ?? pick.deadlineId ?? "that block"
  return `"${label}" ${formatClock(pick.startMin)}–${formatClock(pick.endMin)}`
}

/**
 * A pick must carry exactly one complete identity. Reported separately from "no
 * such option", because they are different mistakes: a half-named pick (a bare
 * `title` with no `courseId`) is a malformed request, and saying it "matches
 * nothing in the feasible set" would send the agent looking for the wrong bug.
 */
function identityProblem(pick: PlanPick): string | null {
  if (pick.taskId || pick.deadlineId) return null
  if (pick.title && pick.courseId) return null
  if (pick.title || pick.courseId) {
    return "names work by title without a courseId (or the other way round); free-standing work needs both"
  }
  return "identifies no work: give a taskId, else a deadlineId, else title + courseId"
}

/**
 * The option this pick names, or `undefined`. Ids first, because they are
 * unambiguous; the title match is the fallback for free-standing work, which the
 * agent may only have a name for.
 */
function matchOption(plan: Plan, pick: PlanPick): PlanOption | undefined {
  if (pick.taskId) return plan.options.find((o) => o.taskId === pick.taskId)
  if (pick.deadlineId) {
    return plan.options.find((o) => o.deadlineId === pick.deadlineId)
  }
  if (pick.title && pick.courseId) {
    return plan.options.find(
      (o) =>
        o.deadlineId === undefined &&
        o.title === pick.title &&
        o.courseId === pick.courseId
    )
  }
  return undefined
}

/**
 * Why this block is not committable, or `null`.
 *
 * The hard guarantees of §3 are re-established here rather than trusted: the
 * block must sit inside a free window this option can use — availability minus
 * class blocks minus the past, exactly as `fits` was derived — and must end by
 * the due minute on the due day. An `overdue` option offers no window at all.
 *
 * It is checked against the window a `fit` points at rather than the fit's own
 * span, deliberately. A `fit` is the planner's *suggested* slot: it starts at
 * the head of the window and runs one effort estimate long, so two things in one
 * afternoon would have to overlap, and a 9pm block in a 9am–10pm window would be
 * refused for no reason. The window and the due time are what the guarantees are
 * actually about, and both are enforced exactly.
 */
function blockProblem(
  plan: Plan,
  option: PlanOption,
  pick: PlanPick,
  date: string,
  timezone: string
): string | null {
  if (!Number.isInteger(pick.startMin) || !Number.isInteger(pick.endMin)) {
    return "has a non-integer time; startMin and endMin are whole minutes from local midnight"
  }
  if (pick.startMin < 0 || pick.endMin > 1440 || pick.endMin <= pick.startMin) {
    return "is not a real block on that day"
  }
  if (option.overdue || option.fits.length === 0) {
    return `has no free window on ${date}`
  }

  const cutoffMin =
    option.dueAt !== undefined && localDate(option.dueAt, timezone) === date
      ? localMinutes(option.dueAt, timezone)
      : 1440

  for (const fit of option.fits) {
    const window = plan.windows[fit.windowIndex]
    if (!window) continue
    const latest = Math.min(window.endMin, cutoffMin)
    if (pick.startMin >= window.startMin && pick.endMin <= latest) return null
  }
  return `is not inside a free window for that work on ${date}`
}

/**
 * The change-feed reason for a task's new block.
 *
 * A task moving BETWEEN days is the retention moment this product exists for —
 * "didn't do it friday, do it saturday" — so it is allowed, in either direction
 * (yesterday's slipped work pulled forward, tomorrow's work pulled into today).
 * What it must not be is silent: the day it came off is named, so the feed shows
 * a move rather than a task that mysteriously appeared on a new date. The
 * `before` on the change carries that day's block as well.
 */
function reasonFor(previous: string | undefined, date: string): string {
  if (!previous) return `planned in the thread for ${date}`
  if (previous === date) return `replanned in the thread for ${date}`
  return `replanned from ${previous} in the thread for ${date}`
}

/**
 * Commit the plan the agent just told the student — the missing half of the
 * seam (decided 2026-09-05).
 *
 * Until this existed, the morning text was the only record of the day: no
 * `tasks` row, an empty Today panel, a check-in with nothing to ask about, and a
 * replan that could not see what it was replacing. The agent choosing among
 * options Core computed *is* the plan, so it applies immediately at origin
 * `planner` rather than waiting for an approval nobody would give.
 *
 * Two properties make that safe:
 *
 * 1. **Every pick is verified against Core's own feasible set** before anything
 *    is written, and the whole commit is refused if any of them fails — never a
 *    class block, never past the due time, never work that is not in the set.
 * 2. **A commit is authoritative for its date.** Agent-created tasks previously
 *    planned for that day and not re-picked come back UNPLANNED — not skipped;
 *    the student never said no. Student-created tasks are never touched.
 *
 * Idempotent: re-committing the same picks compares before to after and writes
 * no second change.
 */
export const commitPlan = internalMutation({
  args: {
    studentId: v.id("students"),
    date: v.string(),
    /** The run the plan was read from, for traceability. Verified to be theirs. */
    planRunId: v.optional(v.id("planRuns")),
    picks: v.array(planPickV),
    now: v.optional(v.number()),
  },
  returns: v.object({
    committed: v.array(
      v.object({
        taskId: v.id("tasks"),
        deadlineId: v.optional(v.id("deadlines")),
        title: v.string(),
        plannedFor: v.string(),
        plannedStartMin: v.number(),
        plannedEndMin: v.number(),
      })
    ),
    unplanned: v.number(),
  }),
  handler: async (ctx, args) => {
    const student = await ctx.db.get("students", args.studentId)
    if (!student) throw new Error("404: student not found")
    if (args.picks.length < 1 || args.picks.length > MAX_PICKS) {
      throw new Error(
        `400: commitPlan takes 1-${MAX_PICKS} picks; got ${args.picks.length}`
      )
    }
    if (args.planRunId) {
      const run = await ctx.db.get("planRuns", args.planRunId)
      if (!run || run.studentId !== args.studentId) {
        throw new Error("400: planRunId is not a run for this student")
      }
      if (run.date !== args.date) {
        throw new Error(`400: planRunId is the run for ${run.date}, not ${args.date}`)
      }
    }

    // The same cache rule `getFeasibleActions` serves the agent from, so the set
    // being verified against is the set the agent was shown.
    const plan = await loadPlan(ctx, {
      studentId: args.studentId,
      date: args.date,
      now: args.now,
    })

    // Verify EVERYTHING before writing anything. A half-committed day is worse
    // than a refused one: the student was told a plan, and the plan is one thing.
    const verified: { pick: PlanPick; option: PlanOption }[] = []
    const named = new Set<string>()
    for (const pick of args.picks) {
      const malformed = identityProblem(pick)
      if (malformed) throw new Error(`400: pick ${describePick(pick)} ${malformed}`)

      const option = matchOption(plan, pick)
      if (!option) {
        throw new Error(
          `400: pick ${describePick(pick)} matches nothing in the feasible set for ${args.date}`
        )
      }
      const key =
        option.taskId ?? option.deadlineId ?? `${option.courseId ?? ""}:${option.title}`
      if (named.has(key)) {
        throw new Error(`400: pick ${describePick(pick, option)} names the same work twice`)
      }
      named.add(key)
      const problem = blockProblem(plan, option, pick, args.date, student.timezone)
      if (problem) {
        throw new Error(`400: pick ${describePick(pick, option)} ${problem}`)
      }
      // A day is a sequence, not a set. Two blocks claiming the same minutes is
      // not a plan the student can act on — and the agent said them one after
      // another, so an overlap means it lost track of the clock, not that it
      // meant to double-book.
      for (const earlier of verified) {
        const from = Math.max(earlier.pick.startMin, pick.startMin)
        const to = Math.min(earlier.pick.endMin, pick.endMin)
        if (from < to) {
          throw new Error(
            `400: picks ${describePick(earlier.pick, earlier.option)} and ` +
              `${describePick(pick, option)} overlap ` +
              `(${formatClock(from)}–${formatClock(to)})`
          )
        }
      }
      verified.push({ pick, option })
    }

    const committed: {
      taskId: Id<"tasks">
      deadlineId?: Id<"deadlines">
      title: string
      plannedFor: string
      plannedStartMin: number
      plannedEndMin: number
    }[] = []
    const kept = new Set<string>()

    for (const { pick, option } of verified) {
      const block = {
        plannedFor: args.date,
        plannedStartMin: pick.startMin,
        plannedEndMin: pick.endMin,
        estEffortMin: option.estEffortMin,
        estEffortConfidence: option.estEffortConfidence,
      }

      if (option.taskId) {
        const taskId = option.taskId as Id<"tasks">
        const task = await ctx.db.get("tasks", taskId)
        // The option came out of this student's own plan, so this cannot happen
        // through the tool; it is the same tenancy floor `applyChange` holds.
        if (!task || task.studentId !== args.studentId) {
          throw new Error("403: entity does not belong to student")
        }
        kept.add(taskId)

        const unchanged =
          task.plannedFor === block.plannedFor &&
          task.plannedStartMin === block.plannedStartMin &&
          task.plannedEndMin === block.plannedEndMin &&
          task.estEffortMin === block.estEffortMin &&
          task.estEffortConfidence === block.estEffortConfidence
        if (!unchanged) {
          await proposeChangeInternal(ctx, {
            studentId: args.studentId,
            courseId: task.courseId,
            kind: "task_updated",
            entity: { table: "tasks", id: taskId },
            before: {
              plannedFor: task.plannedFor ?? null,
              plannedStartMin: task.plannedStartMin ?? null,
              plannedEndMin: task.plannedEndMin ?? null,
            },
            after: block,
            origin: PLANNER_ORIGIN,
            planRunId: args.planRunId,
            reason: reasonFor(task.plannedFor, args.date),
          })
        }
        committed.push({
          taskId,
          deadlineId: task.deadlineId,
          title: task.title,
          plannedFor: args.date,
          plannedStartMin: pick.startMin,
          plannedEndMin: pick.endMin,
        })
        continue
      }

      // No task yet: the option is a deadline the student has never scheduled.
      const { changeId } = await proposeChangeInternal(ctx, {
        studentId: args.studentId,
        courseId: option.courseId as Id<"courses"> | undefined,
        kind: "task_created",
        entity: { table: "tasks" },
        after: {
          deadlineId: option.deadlineId,
          courseId: option.courseId,
          title: option.title,
          type: "do",
          status: "todo",
          createdBy: "agent",
          ...block,
        },
        origin: PLANNER_ORIGIN,
        planRunId: args.planRunId,
        reason: `planned in the thread for ${args.date}`,
      })
      const change = await ctx.db.get("changes", changeId)
      const taskId = change?.entity.id as Id<"tasks"> | undefined
      if (!taskId) throw new Error("500: task_created did not produce a task")
      kept.add(taskId)
      committed.push({
        taskId,
        deadlineId: option.deadlineId as Id<"deadlines"> | undefined,
        title: option.title,
        plannedFor: args.date,
        plannedStartMin: pick.startMin,
        plannedEndMin: pick.endMin,
      })
    }

    // Authoritative for the date: what the agent planned here and dropped there
    // stops being planned. Only work the agent itself put on the day, and only
    // while it is still open — a done or skipped task's planned day is a record
    // of what happened, not a plan to revise.
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_student_status", (q) => q.eq("studentId", args.studentId))
      .take(MAX_TASK_SCAN)

    let unplanned = 0
    for (const task of tasks) {
      if (task.plannedFor !== args.date) continue
      if (task.createdBy !== "agent") continue
      if (task.status !== "todo" && task.status !== "in_progress") continue
      if (kept.has(task._id)) continue
      await proposeChangeInternal(ctx, {
        studentId: args.studentId,
        courseId: task.courseId,
        kind: "task_updated",
        entity: { table: "tasks", id: task._id },
        before: {
          plannedFor: task.plannedFor,
          plannedStartMin: task.plannedStartMin ?? null,
          plannedEndMin: task.plannedEndMin ?? null,
        },
        // `null` is "unset this field" on apply — unplanned, not skipped.
        after: { plannedFor: null, plannedStartMin: null, plannedEndMin: null },
        origin: PLANNER_ORIGIN,
        planRunId: args.planRunId,
        reason: `unplanned for ${args.date} — replaced by the plan committed in the thread`,
      })
      unplanned++
    }

    return { committed, unplanned }
  },
})

// ---------------------------------------------------------------------------
// recordSignal
// ---------------------------------------------------------------------------

export const voiceSignalV = v.object({
  kind: signalKindV,
  text: v.string(),
  refs: v.optional(signalRefsV),
  observedAt: v.optional(v.number()),
  /** The eve session the remark came from, for provenance. */
  sessionId: v.optional(v.string()),
  /** 0..1 — how sure the model is it read the student right. */
  confidence: v.optional(v.number()),
})

/** What Voice learned, stored as told. Origin is always `chat`. */
export const recordSignal = internalMutation({
  args: {
    studentId: v.id("students"),
    signal: voiceSignalV,
  },
  returns: v.id("studentSignals"),
  handler: async (ctx, args) =>
    // One write path, shared with `internal.signals.record` (CR 3892156309).
    await recordSignalInternal(ctx, {
      studentId: args.studentId,
      kind: args.signal.kind,
      text: args.signal.text,
      refs: args.signal.refs,
      origin: "chat",
      observedAt: args.signal.observedAt,
      provenance: {
        source: "chat",
        sourceRef: args.signal.sessionId ?? "voice",
        // Absent when Voice did not assert one — never a fabricated default.
        ...(normalizeConfidence(args.signal.confidence) !== undefined
          ? { confidence: normalizeConfidence(args.signal.confidence) }
          : {}),
      },
    }),
})

// ---------------------------------------------------------------------------
// logUsage — not a planning tool; the mandatory cost record
// ---------------------------------------------------------------------------

/**
 * Every LLM call Voice makes writes one row here (CLAUDE.md hard constraint,
 * vision §10). It is the only cost record that survives a runtime change, so it
 * is written from Core rather than kept in eve.
 */
export const logUsage = internalMutation({
  args: {
    studentId: v.optional(v.id("students")),
    surface: v.optional(surfaceV),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsd: v.optional(v.number()),
    sessionId: v.optional(v.string()),
    at: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.id("usage"),
  handler: async (ctx, args) => {
    // Idempotent on the caller's key: the Voice hook retries a failed write,
    // and a POST that landed but lost its response must return the row it
    // already made rather than meter the same model call twice.
    // An empty/blank key is no key: it must neither dedupe against other blank
    // keys nor be persisted, or a retry would still make a second row.
    const idempotencyKey = args.idempotencyKey?.trim() || undefined
    if (idempotencyKey) {
      const existing = await ctx.db
        .query("usage")
        .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", idempotencyKey))
        .first()
      if (existing) return existing._id
    }
    const tokens = (n: number) =>
      Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
    return await ctx.db.insert("usage", {
      studentId: args.studentId,
      surface: args.surface ?? "voice",
      model: args.model,
      promptTokens: tokens(args.promptTokens),
      completionTokens: tokens(args.completionTokens),
      costUsd:
        args.costUsd !== undefined && Number.isFinite(args.costUsd) && args.costUsd >= 0
          ? args.costUsd
          : undefined,
      sessionId: args.sessionId,
      at: args.at !== undefined && Number.isFinite(args.at) ? args.at : Date.now(),
      idempotencyKey,
    })
  },
})

// ---------------------------------------------------------------------------
// resolveStudent — phone ↔ student, so an inbound text finds its owner
// ---------------------------------------------------------------------------

export const resolveStudent = internalQuery({
  args: {
    phone: v.optional(v.string()),
    clerkId: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      studentId: v.id("students"),
      timezone: v.string(),
      status: v.union(v.literal("active"), v.literal("paused")),
    })
  ),
  handler: async (ctx, args) => {
    let student = null
    if (args.clerkId) {
      student = await ctx.db
        .query("students")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId!))
        .unique()
    } else if (args.phone) {
      // `by_phone` is not a unique index and `phone` is optional, so two rows
      // can carry the same normalized number. Resolving that to whichever the
      // index happens to yield first would hand one student's plan to another
      // (CR 3892156326) — it is a 409 for a human to fix, never a guess.
      const phone = normalizePhone(args.phone)
      const matches = await ctx.db
        .query("students")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .take(2)
      if (matches.length > 1) {
        throw new Error("409: more than one student has that phone number")
      }
      student = matches[0] ?? null
    }
    if (!student) return null
    return {
      studentId: student._id,
      timezone: student.timezone,
      status: student.status,
    }
  },
})

/**
 * Re-exported from `lib/phone.ts`, which is also what the *write* path uses
 * (`lib/changes.ts` normalizes `phone` before it patches a student row), so a
 * stored number and a looked-up one always agree.
 */
export { normalizePhone }
