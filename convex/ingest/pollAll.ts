import { v } from "convex/values"

import { internal } from "../_generated/api"
import { internalAction } from "../_generated/server"

/**
 * The polling sweep the cron drives (`convex/crons.ts`, every 30 minutes —
 * core.md: "Canvas has no push; polling is the only option; start 30 min").
 *
 * Each source is scheduled as its own action rather than awaited in a loop, so
 * one broken token or one slow instance cannot stall or fail the whole sweep;
 * every poll records its own `sources.health` either way. Scheduling is also
 * what keeps this inside the action time limit as the student count grows.
 */
export const pollAll = internalAction({
  args: {
    kinds: v.optional(v.array(v.union(v.literal("canvas"), v.literal("ical")))),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scheduled: v.number(),
    canvas: v.number(),
    ical: v.number(),
  }),
  handler: async (ctx, args) => {
    const kinds = args.kinds ?? ["canvas", "ical"]
    const sources = await ctx.runQuery(internal.ingest.sources.listEnabled, {
      kinds,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })

    let canvas = 0
    let ical = 0
    for (const source of sources) {
      if (source.kind === "canvas") {
        await ctx.scheduler.runAfter(0, internal.ingest.canvas.poll, {
          sourceId: source._id,
        })
        canvas++
      } else if (source.kind === "ical") {
        await ctx.scheduler.runAfter(0, internal.ingest.ical.poll, {
          sourceId: source._id,
        })
        ical++
      }
    }

    return { scheduled: canvas + ical, canvas, ical }
  },
})
