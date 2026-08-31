import { v } from "convex/values"

import { internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import { internalAction, internalMutation } from "../_generated/server"
import {
  canvasFixturePayload,
  isCanvasScenario,
  type CanvasScenarioName,
} from "../dev/fixtures"
import { fetchCanvasSnapshot } from "../lib/canvas/client"
import { normalizeCanvas } from "../lib/canvas/normalize"
import type { CanvasSnapshotPayload } from "../lib/canvas/types"
import { diffState, hashSnapshotPayload } from "../lib/diff"
import {
  applyProposals,
  courseIdIndex,
  loadCourses,
  storeSnapshot,
  upsertMaterials,
} from "../lib/ingest"
import { emptyNormalizedState } from "../lib/normalized"

/**
 * The Canvas adapter: fetch → snapshot → normalize → diff → changes
 * (core.md "Ingestion design").
 *
 * Canvas has no push API, so polling is the only option and diffing is required
 * anyway. Snapshots are the truth: the previous normalized state is always
 * re-derived from the previous snapshot rather than read back out of the
 * database, so a normalization bug fixed today re-explains yesterday's changes.
 */

const ingestResultV = v.object({
  snapshotId: v.id("snapshots"),
  /** False when the poll hashed identically to the last one — nothing changed. */
  created: v.boolean(),
  proposed: v.number(),
  applied: v.number(),
  pending: v.number(),
  skipped: v.number(),
  materials: v.number(),
})

type IngestResult = {
  snapshotId: Id<"snapshots">
  created: boolean
  proposed: number
  applied: number
  pending: number
  skipped: number
  materials: number
}

const isCanvasPayload = (payload: unknown): payload is CanvasSnapshotPayload =>
  !!payload &&
  typeof payload === "object" &&
  (payload as { kind?: unknown }).kind === "canvas" &&
  Array.isArray((payload as { courses?: unknown }).courses)

export const ingestPayload = internalMutation({
  args: {
    sourceId: v.id("sources"),
    payload: v.any(),
    contentHash: v.string(),
    label: v.optional(v.string()),
  },
  returns: ingestResultV,
  handler: async (ctx, args): Promise<IngestResult> => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) throw new Error("404: source not found")
    if (!isCanvasPayload(args.payload)) {
      throw new Error("ingest.canvas: payload is not a Canvas snapshot")
    }

    const { snapshotId, created, previous } = await storeSnapshot(ctx, {
      sourceId: args.sourceId,
      studentId: source.studentId,
      payload: args.payload,
      contentHash: args.contentHash,
      label: args.label,
      fetchedAt: args.payload.fetchedAt,
    })

    // Identical content: no snapshot, no diff, no changes. Just a fresher poll
    // timestamp (already written by storeSnapshot).
    if (!created) {
      return {
        snapshotId,
        created: false,
        proposed: 0,
        applied: 0,
        pending: 0,
        skipped: 0,
        materials: 0,
      }
    }

    const previousState =
      previous && isCanvasPayload(previous.payload)
        ? normalizeCanvas(previous.payload)
        : emptyNormalizedState()
    const nextState = normalizeCanvas(args.payload)

    const courseIds = courseIdIndex(await loadCourses(ctx, source.studentId))
    const snapshotIds = previous ? [previous._id, snapshotId] : [snapshotId]

    const outcome = await applyProposals(ctx, {
      studentId: source.studentId,
      proposals: diffState(previousState, nextState),
      origin: "canvas",
      snapshotIds,
      courseIds,
    })

    // Materials are raw captures, not student-state facts, so they are upserted
    // directly rather than routed through `changes` (see lib/ingest.ts).
    const materials = await upsertMaterials(ctx, {
      studentId: source.studentId,
      materials: nextState.materials,
      courseIds,
    })

    return {
      snapshotId,
      created: true,
      ...outcome,
      materials: materials.inserted + materials.updated,
    }
  },
})

/**
 * One poll of one Canvas source.
 *
 * `config.mode === "fixture"` uses the bundled spec-derived semester instead of
 * the network, which is what lets the whole pipeline (and the cron) run on a
 * dev deployment with no Canvas token at all — core.md "Test data": build every
 * adapter to the published spec now, validate on a real account later.
 */
export const poll = internalAction({
  args: { sourceId: v.id("sources") },
  returns: v.object({
    ok: v.boolean(),
    created: v.boolean(),
    proposed: v.number(),
    pending: v.number(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const source = await ctx.runQuery(internal.ingest.sources.get, {
      sourceId: args.sourceId,
    })
    if (!source) throw new Error("404: source not found")
    if (source.kind !== "canvas") {
      throw new Error(`ingest.canvas.poll: source ${args.sourceId} is ${source.kind}`)
    }

    try {
      const payload = await canvasPayloadFor(source.config)
      const contentHash = await hashSnapshotPayload(payload)
      const result: IngestResult = await ctx.runMutation(
        internal.ingest.canvas.ingestPayload,
        { sourceId: args.sourceId, payload, contentHash }
      )
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: "ok",
      })
      return {
        ok: true,
        created: result.created,
        proposed: result.proposed,
        pending: result.pending,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: "error",
        message,
      })
      await ctx.runMutation(internal.ingest.sources.markPolled, {
        sourceId: args.sourceId,
      })
      return { ok: false, created: false, proposed: 0, pending: 0, error: message }
    }
  },
})

async function canvasPayloadFor(config: unknown): Promise<CanvasSnapshotPayload> {
  const bag =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {}

  if (bag.mode === "fixture") {
    const scenario =
      typeof bag.scenario === "string" && isCanvasScenario(bag.scenario)
        ? (bag.scenario as CanvasScenarioName)
        : undefined
    return canvasFixturePayload(scenario ? { scenario } : {})
  }

  const baseUrl = typeof bag.baseUrl === "string" ? bag.baseUrl : ""
  const token = typeof bag.token === "string" ? bag.token : ""
  if (!baseUrl || !token) {
    throw new Error("canvas source config needs { baseUrl, token } or { mode: 'fixture' }")
  }
  return await fetchCanvasSnapshot(baseUrl, token)
}
