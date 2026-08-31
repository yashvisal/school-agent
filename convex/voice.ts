import { v } from "convex/values"

import { internalMutation, internalQuery } from "./_generated/server"
import { proposeChangeInternal, tierFor } from "./lib/changes"
import {
  changeEntityV,
  changeKindV,
  changeStatusV,
  originV,
  signalKindV,
  surfaceV,
  tierV,
} from "./lib/validators"
import { feasibleActionsV, loadFeasibleActions } from "./planner"
import { signalRefsV } from "./signals"

/**
 * The Voice tool surface — the ENTIRE reach eve's Voice agent has into Core
 * (vision §10 "the tool boundary is the seam", core.md "the three Voice tools").
 *
 *   getFeasibleActions  read the plan   — never the raw tables
 *   proposeChange       write state     — always through `changes`
 *   recordSignal        write learning  — `studentSignals`, text as told
 *
 * Nothing else is reachable. These are `internal*` functions: Voice runs outside
 * Convex and calls them over the HTTP routes in `convex/http.ts`, which
 * authenticate with `CORE_AGENT_SECRET`. Keeping them internal means the public
 * API surface stays exactly what Face needs and nothing more.
 *
 * `logUsage` below is the fourth route but NOT a planning tool: it is the
 * mandatory per-call cost record (vision §10 cost posture), not a way to see or
 * change the plan. The seam is three tools; this is bookkeeping.
 */

// ---------------------------------------------------------------------------
// getFeasibleActions
// ---------------------------------------------------------------------------

/** A nightly precompute this fresh is reused instead of recomputed. */
export const PLAN_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000

export const voiceFeasibleV = v.object({
  /** Set when this came from a stored nightly run; the Voice run cites it. */
  planRunId: v.optional(v.id("planRuns")),
  computedAt: v.number(),
  cached: v.boolean(),
  timezone: v.string(),
  ...feasibleActionsV.fields,
})

/**
 * The plan for `date`. Serves the nightly `planRuns` snapshot when one was
 * computed within `PLAN_CACHE_MAX_AGE_MS`, so the morning text and any follow-up
 * in the same conversation describe the same day; otherwise recomputes live.
 */
export const getFeasibleActions = internalQuery({
  args: {
    studentId: v.id("students"),
    date: v.string(),
    now: v.optional(v.number()),
  },
  returns: voiceFeasibleV,
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()

    const run = await ctx.db
      .query("planRuns")
      .withIndex("by_student_date", (q) =>
        q.eq("studentId", args.studentId).eq("date", args.date)
      )
      .order("desc")
      .first()

    if (run && now - run.computedAt <= PLAN_CACHE_MAX_AGE_MS) {
      const student = await ctx.db.get("students", args.studentId)
      if (!student) throw new Error("404: student not found")
      const feasible = run.feasible as {
        date: string
        windows: unknown[]
        options: unknown[]
      }
      return {
        planRunId: run._id,
        computedAt: run.computedAt,
        cached: true,
        timezone: student.timezone,
        date: feasible.date ?? run.date,
        windows: feasible.windows ?? [],
        options: feasible.options ?? [],
        pending: run.pendingAnnotations ?? [],
        signalsDigest: run.signalsDigest,
      } as typeof voiceFeasibleV.type
    }

    const { student, result } = await loadFeasibleActions(ctx, {
      studentId: args.studentId,
      date: args.date,
      now,
    })
    return {
      planRunId: run?._id,
      computedAt: now,
      cached: false,
      timezone: student.timezone,
      ...result,
    }
  },
})

// ---------------------------------------------------------------------------
// proposeChange
// ---------------------------------------------------------------------------

export const voiceChangeV = v.object({
  courseId: v.optional(v.id("courses")),
  kind: changeKindV,
  entity: changeEntityV,
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  /** Defaults to `chat` — anything Voice proposes was interpreted from a message. */
  origin: v.optional(originV),
  reason: v.optional(v.string()),
  conflict: v.optional(v.boolean()),
  /**
   * The student confirmed it in the same exchange. Rule 1: an inline chat
   * confirmation is a first-class approval, equal to a web tap — it applies and
   * does NOT also wait in the web queue.
   */
  confirmedInline: v.optional(v.boolean()),
})

/**
 * The only write path Voice has into student state. Everything lands in
 * `changes` and is tiered there (core.md, "Two-tier apply rule"): chat-origin
 * changes are `needs_approval`, applied immediately only when `confirmedInline`.
 */
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
    const origin = args.change.origin ?? "chat"
    const { changeId, status } = await proposeChangeInternal(ctx, {
      studentId: args.studentId,
      courseId: args.change.courseId,
      kind: args.change.kind,
      entity: args.change.entity,
      before: args.change.before,
      after: args.change.after,
      origin,
      reason: args.change.reason,
      conflict: args.change.conflict,
      confirmedInline: args.change.confirmedInline,
    })
    return { changeId, status, tier: tierFor(origin, args.change.conflict) }
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
  handler: async (ctx, args) => {
    const text = args.signal.text.trim()
    if (!text) throw new Error("signal text must not be empty")

    const confidence =
      args.signal.confidence !== undefined &&
      Number.isFinite(args.signal.confidence) &&
      args.signal.confidence >= 0 &&
      args.signal.confidence <= 1
        ? args.signal.confidence
        : 0.6

    const observedAt =
      args.signal.observedAt !== undefined && Number.isFinite(args.signal.observedAt)
        ? args.signal.observedAt
        : Date.now()

    return await ctx.db.insert("studentSignals", {
      studentId: args.studentId,
      kind: args.signal.kind,
      text,
      refs: args.signal.refs ?? {},
      origin: "chat",
      observedAt,
      provenance: {
        source: "chat",
        sourceRef: args.signal.sessionId ?? "voice",
        confidence,
      },
    })
  },
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
  },
  returns: v.id("usage"),
  handler: async (ctx, args) => {
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
      const phone = normalizePhone(args.phone)
      student = await ctx.db
        .query("students")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .first()
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
 * E.164-ish: digits with a leading `+`. Photon hands us `+15551234567`; a human
 * typing into onboarding may not. Stored numbers are normalized the same way.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "")
  if (!digits) return raw.trim()
  return `+${digits.length === 10 ? `1${digits}` : digits}`
}
