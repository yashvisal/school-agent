import { v } from "convex/values"

import { internalMutation, query } from "./_generated/server"
import { requireStudent } from "./lib/auth"
import {
  provenanceV,
  signalKindV,
  signalOriginV,
  studentSignalFields,
} from "./lib/validators"

/**
 * `studentSignals` — what the student said or did, as said or done.
 *
 * Written from day one by every surface (core.md, "State model"). Never
 * aggregated into a stored score: the text *is* the record, and interpretation
 * belongs to the agent (vision §4b / §9). The planner reads them as hints —
 * pacing signals adjust effort priors, everything else lands in the digest.
 */

export const signalRefsV = v.object({
  courseId: v.optional(v.id("courses")),
  deadlineId: v.optional(v.id("deadlines")),
  taskId: v.optional(v.id("tasks")),
})

export const signalDocV = v.object({
  _id: v.id("studentSignals"),
  _creationTime: v.number(),
  ...studentSignalFields,
})

/** Internal: Voice (`recordSignal`), the workspace agent, and Face all write here. */
export const record = internalMutation({
  args: {
    studentId: v.id("students"),
    kind: signalKindV,
    text: v.string(),
    refs: v.optional(signalRefsV),
    origin: signalOriginV,
    observedAt: v.optional(v.number()),
    provenance: v.optional(provenanceV),
  },
  returns: v.id("studentSignals"),
  handler: async (ctx, args) => {
    const text = args.text.trim()
    if (!text) throw new Error("signal text must not be empty")
    const observedAt =
      args.observedAt !== undefined && Number.isFinite(args.observedAt)
        ? args.observedAt
        : Date.now()

    return await ctx.db.insert("studentSignals", {
      studentId: args.studentId,
      kind: args.kind,
      text,
      refs: args.refs ?? {},
      origin: args.origin,
      observedAt,
      provenance: args.provenance ?? {
        source: args.origin === "chat" ? "chat" : "manual",
        sourceRef: args.origin,
        confidence: 0.5,
      },
    })
  },
})

/** Newest first. Face's "recently discussed" view reads this. */
export const list = query({
  args: {
    studentId: v.id("students"),
    limit: v.optional(v.number()),
  },
  returns: v.array(signalDocV),
  handler: async (ctx, args) => {
    await requireStudent(ctx, args.studentId)
    const limit =
      args.limit === undefined || !Number.isFinite(args.limit) || args.limit < 1
        ? 50
        : Math.min(Math.floor(args.limit), 200)
    return await ctx.db
      .query("studentSignals")
      .withIndex("by_student_observedAt", (q) => q.eq("studentId", args.studentId))
      .order("desc")
      .take(limit)
  },
})
