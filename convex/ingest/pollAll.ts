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
    kinds: v.optional(
      v.array(v.union(v.literal("canvas"), v.literal("ical"), v.literal("site")))
    ),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    scheduled: v.number(),
    canvas: v.number(),
    ical: v.number(),
    site: v.number(),
  }),
  handler: async (ctx, args) => {
    // Course sites join the sweep; the two UPLOAD adapters (syllabus, schedule)
    // deliberately do not. An upload has no source to re-poll — the document
    // only changes when the student uploads a new one, which is an event, not a
    // schedule. Re-running them on a cron would re-extract identical markdown
    // every 30 minutes and bill for it.
    const kinds = args.kinds ?? ["canvas", "ical", "site"]
    const sources = await ctx.runQuery(internal.ingest.sources.listEnabled, {
      kinds,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    })

    let canvas = 0
    let ical = 0
    let site = 0
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
      } else if (source.kind === "site") {
        await ctx.scheduler.runAfter(0, internal.ingest.site.run, {
          sourceId: source._id,
        })
        site++
      }
    }

    return { scheduled: canvas + ical + site, canvas, ical, site }
  },
})
