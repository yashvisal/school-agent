import { v } from "convex/values"

import { internalQuery, mutation } from "./_generated/server"
import { requireIdentity } from "./lib/auth"
import { studentDocV } from "./lib/validators"

const DEFAULT_TIMEZONE = "America/New_York"

/**
 * Upsert the students row for the signed-in Clerk identity. Idempotent: calling
 * it again returns the same row (and updates the timezone if one is supplied),
 * so onboarding can call it on every load.
 *
 * Identity comes from `ctx.auth` — never from an argument.
 */
export const ensure = mutation({
  args: { timezone: v.optional(v.string()) },
  returns: v.id("students"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const existing = await ctx.db
      .query("students")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique()

    if (existing) {
      if (args.timezone && args.timezone !== existing.timezone) {
        await ctx.db.patch("students", existing._id, { timezone: args.timezone })
      }
      return existing._id
    }

    return await ctx.db.insert("students", {
      clerkId: identity.subject,
      timezone: args.timezone ?? DEFAULT_TIMEZONE,
      classBlocks: [],
      availability: { weekly: [], exceptions: [] },
      status: "active",
    })
  },
})

/** Internal: load a student by id (crons, adapters, agent tools). */
export const get = internalQuery({
  args: { studentId: v.id("students") },
  returns: v.union(v.null(), studentDocV),
  handler: async (ctx, args) => await ctx.db.get("students", args.studentId),
})
