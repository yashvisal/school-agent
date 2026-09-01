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
import { loadFeasibleActions } from "./planner"
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
  handler: async (ctx, args) => {
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
