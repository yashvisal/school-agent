import { v } from "convex/values"

import { internalMutation } from "./_generated/server"
import { surfaceV } from "./lib/validators"

/**
 * The cost ledger (core.md "State model": `usage` — "**Written on every LLM
 * call from day one**; the only cost record that survives a runtime change";
 * CLAUDE.md hard constraint).
 *
 * Internal only. Every LLM call in Core happens inside an action, so the write
 * is a `ctx.runMutation` immediately after the call — including when the call
 * FAILED validation, because a failed extraction still burned tokens (see
 * `lib/extraction/llm.ts`). Voice logs its own usage through the tool route in
 * `convex/voice.ts`; this is the ingestion/planner side of the same table.
 */
export const log = internalMutation({
  args: {
    studentId: v.optional(v.id("students")),
    surface: surfaceV,
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    costUsd: v.optional(v.number()),
    sessionId: v.optional(v.string()),
    at: v.optional(v.number()),
  },
  returns: v.id("usage"),
  handler: async (ctx, args) => {
    // Token counts are provider-reported and land here unvalidated; a NaN or a
    // negative would corrupt every sum over the table, so they are floored
    // rather than trusted.
    const clean = (value: number) =>
      Number.isFinite(value) && value > 0 ? Math.round(value) : 0

    return await ctx.db.insert("usage", {
      ...(args.studentId ? { studentId: args.studentId } : {}),
      surface: args.surface,
      model: args.model,
      promptTokens: clean(args.promptTokens),
      completionTokens: clean(args.completionTokens),
      ...(args.costUsd !== undefined && Number.isFinite(args.costUsd) && args.costUsd >= 0
        ? { costUsd: args.costUsd }
        : {}),
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      at: args.at !== undefined && Number.isFinite(args.at) ? args.at : Date.now(),
    })
  },
})
