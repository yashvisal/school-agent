import { v } from "convex/values"

import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import { internalAction, internalMutation, internalQuery } from "../_generated/server"
import { hashSnapshotPayload } from "../lib/diff"
import {
  canvasFixturePayload,
  FIXTURE_BASE_URL,
  FIXTURE_ICAL_URL,
  icalFixturePayload,
  isCanvasScenario,
  type CanvasScenarioName,
} from "./fixtures"

/**
 * DEV ONLY — the fixture semester, on a real deployment.
 *
 * Everything here is `internal*`, so none of it is reachable from a client; it
 * exists so CP2 can be exercised end to end with no Canvas token (core.md
 * "Test data & limitations"). It writes through the same
 * `internal.ingest.*.ingestPayload` mutations a real poll uses — the only thing
 * faked is the network.
 *
 *   npx convex run dev/seed:fixtureSemester
 *   npx convex run dev/seed:applyScenario '{"scenario":"moved"}'
 *   npx convex run dev/seed:reset
 */

export const DEV_CLERK_ID = "dev-fixture-student"
const DEV_TIMEZONE = "America/New_York"

/**
 * A plausible weekly schedule for the fixture student so the planner has
 * real windows to fit work into (CP2). Minutes from local midnight.
 * Classes: BIO201 MWF 10:05–10:55, CS201 TuTh 13:25–14:40, STA210 MW 15:05–16:20.
 * Availability: weekdays 9:00–22:00, Sat 10:00–18:00, Sun 12:00–22:00.
 */
const FIXTURE_CLASS_BLOCKS = [
  ...[1, 3, 5].map((d) => ({ dayOfWeek: d, startMin: 605, endMin: 655, label: "BIO201" })),
  ...[2, 4].map((d) => ({ dayOfWeek: d, startMin: 805, endMin: 880, label: "CS201" })),
  ...[1, 3].map((d) => ({ dayOfWeek: d, startMin: 905, endMin: 980, label: "STA210" })),
]
const FIXTURE_AVAILABILITY = {
  weekly: [
    ...[1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, startMin: 540, endMin: 1320 })),
    { dayOfWeek: 6, startMin: 600, endMin: 1080 },
    { dayOfWeek: 0, startMin: 720, endMin: 1320 },
  ],
  exceptions: [],
}

const targetsV = v.object({
  studentId: v.id("students"),
  canvasSourceId: v.id("sources"),
  icalSourceId: v.id("sources"),
})

type Targets = {
  studentId: Id<"students">
  canvasSourceId: Id<"sources">
  icalSourceId: Id<"sources">
}

/** Creates or reuses the fixture student and its two fixture-mode sources. */
export const provision = internalMutation({
  args: {
    clerkId: v.optional(v.string()),
    timezone: v.optional(v.string()),
  },
  returns: targetsV,
  handler: async (ctx, args): Promise<Targets> => {
    const clerkId = args.clerkId ?? DEV_CLERK_ID
    const timezone = args.timezone ?? DEV_TIMEZONE

    const existing = await ctx.db
      .query("students")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique()

    const studentId =
      existing?._id ??
      (await ctx.db.insert("students", {
        clerkId,
        timezone,
        classBlocks: FIXTURE_CLASS_BLOCKS,
        availability: FIXTURE_AVAILABILITY,
        status: "active",
      }))
    if (existing && existing.timezone !== timezone) {
      await ctx.db.patch("students", studentId, { timezone })
    }

    const sources = await ctx.db
      .query("sources")
      .withIndex("by_student", (q) => q.eq("studentId", studentId))
      .take(50)

    const canvasSourceId =
      sources.find((s) => s.kind === "canvas")?._id ??
      (await ctx.db.insert("sources", {
        studentId,
        kind: "canvas",
        config: { mode: "fixture", baseUrl: FIXTURE_BASE_URL },
        enabled: true,
        health: { status: "unknown", at: Date.now() },
      }))

    const icalSourceId =
      sources.find((s) => s.kind === "ical")?._id ??
      (await ctx.db.insert("sources", {
        studentId,
        kind: "ical",
        config: { mode: "fixture", url: FIXTURE_ICAL_URL },
        enabled: true,
        health: { status: "unknown", at: Date.now() },
      }))

    return { studentId, canvasSourceId, icalSourceId }
  },
})

export const targets = internalQuery({
  args: { clerkId: v.optional(v.string()) },
  returns: v.union(v.null(), targetsV),
  handler: async (ctx, args): Promise<Targets | null> => {
    const student = await ctx.db
      .query("students")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId ?? DEV_CLERK_ID))
      .unique()
    if (!student) return null
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(50)
    const canvas = sources.find((s) => s.kind === "canvas")
    const ical = sources.find((s) => s.kind === "ical")
    if (!canvas || !ical) return null
    return { studentId: student._id, canvasSourceId: canvas._id, icalSourceId: ical._id }
  },
})

const ingestSummaryV = v.object({
  created: v.boolean(),
  proposed: v.number(),
  applied: v.number(),
  pending: v.number(),
})

type IngestSummary = {
  created: boolean
  proposed: number
  applied: number
  pending: number
}

/** The adapters return more detail than the seed reports; project it down. */
const summarize = (result: {
  created: boolean
  proposed: number
  applied: number
  pending: number
}): IngestSummary => ({
  created: result.created,
  proposed: result.proposed,
  applied: result.applied,
  pending: result.pending,
})

/**
 * The whole baseline: three active courses, a concluded one, an unpublished
 * one, 23 published deadlines with submissions, materials, and the matching
 * Canvas iCal feed (which should dedupe to nothing new).
 */
export const fixtureSemester = internalAction({
  args: {
    clerkId: v.optional(v.string()),
    timezone: v.optional(v.string()),
  },
  returns: v.object({
    studentId: v.id("students"),
    canvas: ingestSummaryV,
    ical: ingestSummaryV,
  }),
  handler: async (ctx, args) => {
    const target: Targets = await ctx.runMutation(internal.dev.seed.provision, args)

    const canvasPayload = canvasFixturePayload()
    const canvas = summarize(
      await ctx.runMutation(internal.ingest.canvas.ingestPayload, {
        sourceId: target.canvasSourceId,
        payload: canvasPayload,
        contentHash: await hashSnapshotPayload(canvasPayload),
        label: "fixture: canvas/base",
      })
    )

    const icalPayload = icalFixturePayload()
    const ical = summarize(
      await ctx.runMutation(internal.ingest.ical.ingestPayload, {
        sourceId: target.icalSourceId,
        payload: icalPayload,
        contentHash: await hashSnapshotPayload(icalPayload),
        label: "fixture: ical/canvas",
      })
    )

    return { studentId: target.studentId, canvas, ical }
  },
})

/**
 * Ingests one synthetic change scenario on top of the baseline, so the change
 * feed shows exactly the diff that scenario describes
 * (`fixtures/changes/<scenario>/README.md` states the expected outcome).
 */
export const applyScenario = internalAction({
  args: {
    scenario: v.union(
      v.literal("moved"),
      v.literal("added"),
      v.literal("removed"),
      v.literal("submitted"),
      v.literal("graded"),
      v.literal("conflict")
    ),
    clerkId: v.optional(v.string()),
  },
  returns: v.object({
    scenario: v.string(),
    source: v.union(v.literal("canvas"), v.literal("ical")),
    result: ingestSummaryV,
  }),
  handler: async (ctx, args) => {
    const target: Targets | null = await ctx.runQuery(internal.dev.seed.targets, {
      ...(args.clerkId !== undefined ? { clerkId: args.clerkId } : {}),
    })
    if (!target) throw new Error("404: run dev/seed:fixtureSemester first")

    if (isCanvasScenario(args.scenario)) {
      const payload = canvasFixturePayload({
        scenario: args.scenario as CanvasScenarioName,
      })
      const result = summarize(
        await ctx.runMutation(internal.ingest.canvas.ingestPayload, {
          sourceId: target.canvasSourceId,
          payload,
          contentHash: await hashSnapshotPayload(payload),
          label: `fixture: changes/${args.scenario}`,
        })
      )
      return { scenario: args.scenario, source: "canvas" as const, result }
    }

    const payload = icalFixturePayload({ variant: "conflict" })
    const result = summarize(
      await ctx.runMutation(internal.ingest.ical.ingestPayload, {
        sourceId: target.icalSourceId,
        payload,
        contentHash: await hashSnapshotPayload(payload),
        label: "fixture: changes/conflict",
      })
    )
    return { scenario: args.scenario, source: "ical" as const, result }
  },
})

/** Deletes every row belonging to the fixture student, across all tables. */
export const reset = internalMutation({
  args: { clerkId: v.optional(v.string()) },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    const student = await ctx.db
      .query("students")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId ?? DEV_CLERK_ID))
      .unique()
    if (!student) return { deleted: 0 }

    let deleted = 0

    const sources = await ctx.db
      .query("sources")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(200)
    for (const source of sources) {
      const snapshots: Doc<"snapshots">[] = await ctx.db
        .query("snapshots")
        .withIndex("by_source_fetchedAt", (q) => q.eq("sourceId", source._id))
        .take(500)
      for (const snapshot of snapshots) {
        await ctx.db.delete("snapshots", snapshot._id)
        deleted++
      }
    }
    for (const source of sources) {
      await ctx.db.delete("sources", source._id)
      deleted++
    }

    const courses = await ctx.db
      .query("courses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(200)
    for (const course of courses) {
      const materials = await ctx.db
        .query("materials")
        .withIndex("by_course", (q) => q.eq("courseId", course._id))
        .take(500)
      for (const material of materials) {
        await ctx.db.delete("materials", material._id)
        deleted++
      }
    }
    for (const course of courses) {
      await ctx.db.delete("courses", course._id)
      deleted++
    }

    for (const row of await ctx.db
      .query("deadlines")
      .withIndex("by_student_dueAt", (q) => q.eq("studentId", student._id))
      .take(2000)) {
      await ctx.db.delete("deadlines", row._id)
      deleted++
    }
    for (const row of await ctx.db
      .query("changes")
      .withIndex("by_student_createdAt", (q) => q.eq("studentId", student._id))
      .take(2000)) {
      await ctx.db.delete("changes", row._id)
      deleted++
    }
    for (const row of await ctx.db
      .query("tasks")
      .withIndex("by_student_status", (q) => q.eq("studentId", student._id))
      .take(1000)) {
      await ctx.db.delete("tasks", row._id)
      deleted++
    }
    for (const row of await ctx.db
      .query("studentSignals")
      .withIndex("by_student_observedAt", (q) => q.eq("studentId", student._id))
      .take(1000)) {
      await ctx.db.delete("studentSignals", row._id)
      deleted++
    }
    for (const row of await ctx.db
      .query("planRuns")
      .withIndex("by_student_date", (q) => q.eq("studentId", student._id))
      .take(1000)) {
      await ctx.db.delete("planRuns", row._id)
      deleted++
    }
    for (const row of await ctx.db
      .query("usage")
      .withIndex("by_student_at", (q) => q.eq("studentId", student._id))
      .take(1000)) {
      await ctx.db.delete("usage", row._id)
      deleted++
    }

    await ctx.db.delete("students", student._id)
    deleted++

    return { deleted }
  },
})
