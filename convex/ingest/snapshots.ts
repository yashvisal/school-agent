import { v } from "convex/values"

import { internalMutation, internalQuery } from "../_generated/server"
import { latestSnapshot, storeSnapshot } from "../lib/ingest"
import { snapshotFields } from "../lib/validators"

/**
 * Immutable snapshots (core.md "State model"): every fetch is stored, but a
 * snapshot row is written **only when the content hash differs from the latest
 * one for that source**. Identical polls just bump `sources.lastPolledAt`.
 *
 * That is what keeps the table from growing by one row every 30 minutes forever
 * while still guaranteeing that any change in the feed has a snapshot pair
 * explaining it.
 */

const snapshotDocV = v.object({
  _id: v.id("snapshots"),
  _creationTime: v.number(),
  ...snapshotFields,
})

export const store = internalMutation({
  args: {
    sourceId: v.id("sources"),
    studentId: v.id("students"),
    payload: v.any(),
    contentHash: v.string(),
    label: v.optional(v.string()),
    fetchedAt: v.optional(v.number()),
  },
  returns: v.object({
    snapshotId: v.id("snapshots"),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    if (args.contentHash.length === 0) throw new Error("contentHash must be non-empty")
    const { snapshotId, created } = await storeSnapshot(ctx, args)
    return { snapshotId, created }
  },
})

export const latest = internalQuery({
  args: { sourceId: v.id("sources") },
  returns: v.union(v.null(), snapshotDocV),
  handler: async (ctx, args) => await latestSnapshot(ctx, args.sourceId),
})
