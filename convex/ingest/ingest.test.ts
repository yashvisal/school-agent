import { describe, expect, test } from "vitest"

import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import { canvasFixturePayload } from "../dev/fixtures"
import { DEV_CLERK_ID } from "../dev/seed"
import { setupTest } from "../test.setup"

/**
 * The ingestion slice end to end, on the spec-derived fixture semester:
 * seed → snapshot → normalize → diff → changes → applied state.
 *
 * This is core.md's exit test for ingestion, minus a live Canvas: complete,
 * correct deadlines with provenance, and a change feed that correctly reports
 * every synthetic change.
 */

type T = ReturnType<typeof setupTest>

const deadlines = (t: T) =>
  t.run(async (ctx) => await ctx.db.query("deadlines").take(500))
const changes = (t: T) => t.run(async (ctx) => await ctx.db.query("changes").take(500))
const snapshots = (t: T) =>
  t.run(async (ctx) => await ctx.db.query("snapshots").take(100))

const byCanvasId = (rows: Doc<"deadlines">[]) =>
  new Map(rows.map((row) => [row.externalIds.canvasAssignmentId, row]))

async function seed(t: T) {
  return await t.action(internal.dev.seed.fixtureSemester, {})
}

describe("fixture semester", () => {
  test("seeds courses, deadlines and materials with provenance", async () => {
    const t = setupTest()
    const result = await seed(t)

    expect(result.canvas.created).toBe(true)
    // 5 course_added + 23 deadline_added, all auto-tier and applied.
    expect(result.canvas.proposed).toBe(28)
    expect(result.canvas.applied).toBe(28)
    expect(result.canvas.pending).toBe(0)

    const courses = await t.run(async (ctx) => await ctx.db.query("courses").take(50))
    expect(courses).toHaveLength(5)
    expect(courses.find((c) => c.code === "HIST101")?.status).toBe("concluded")
    expect(courses.find((c) => c.code === "CHEM101")?.status).toBe("hidden")

    const rows = await deadlines(t)
    expect(rows).toHaveLength(23)
    const pset = byCanvasId(rows).get("5101")
    expect(pset?.title).toBe("Assignment 1: Sorting")
    expect(pset?.dueAt).toBe(Date.UTC(2026, 8, 15, 3, 59))
    expect(pset?.submissionStatus).toBe("graded")
    expect(pset?.provenance).toEqual({
      source: "canvas",
      sourceRef: "/api/v1/courses/1002/assignments/5101",
      confidence: 1,
    })
    expect(pset?.status).toBe("active")

    const materials = await t.run(
      async (ctx) => await ctx.db.query("materials").take(100)
    )
    expect(materials).toHaveLength(21)

    // Every change is a durable, replayable row pointing at its snapshot.
    const feed = await changes(t)
    expect(feed).toHaveLength(28)
    expect(feed.every((c) => c.origin === "canvas")).toBe(true)
    expect(feed.every((c) => c.tier === "auto" && c.status === "applied")).toBe(true)
    expect(feed.every((c) => c.snapshotIds.length >= 1)).toBe(true)
  })

  test("the Canvas iCal feed dedupes to nothing: exact join on the UID", async () => {
    const t = setupTest()
    const result = await seed(t)

    // 4 assignment events, all matched by canvasAssignmentId; 2 class meetings.
    expect(result.ical.created).toBe(true)
    expect(result.ical.proposed).toBe(0)
    expect(result.ical.pending).toBe(0)

    const rows = await deadlines(t)
    expect(rows).toHaveLength(23)
    const canvasIds = rows.map((r) => r.externalIds.canvasAssignmentId)
    expect(new Set(canvasIds).size).toBe(canvasIds.length)
    // No row was created straight from the feed alongside its Canvas twin.
    expect(rows.filter((r) => r.externalIds.icalUid && !r.externalIds.canvasAssignmentId))
      .toHaveLength(0)
  })

  test("re-ingesting the same payload writes no snapshot and no changes", async () => {
    const t = setupTest()
    await seed(t)
    const before = { snapshots: (await snapshots(t)).length, changes: (await changes(t)).length }

    const again = await seed(t)
    expect(again.canvas.created).toBe(false)
    expect(again.canvas.proposed).toBe(0)
    expect(again.ical.created).toBe(false)

    expect((await snapshots(t)).length).toBe(before.snapshots)
    expect((await changes(t)).length).toBe(before.changes)

    // The poll still happened, so the source is freshly stamped.
    const sources = await t.run(async (ctx) => await ctx.db.query("sources").take(10))
    expect(sources.every((s) => typeof s.lastPolledAt === "number")).toBe(true)
  })
})

describe("scenarios", () => {
  test("moved: one applied deadline_moved, and the row actually moves", async () => {
    const t = setupTest()
    await seed(t)
    const baseline = (await changes(t)).length

    const result = await t.action(internal.dev.seed.applyScenario, { scenario: "moved" })
    expect(result.source).toBe("canvas")
    expect(result.result.created).toBe(true)
    expect(result.result.proposed).toBe(1)

    const feed = await changes(t)
    expect(feed).toHaveLength(baseline + 1)
    const change = feed[feed.length - 1]
    expect(change.kind).toBe("deadline_moved")
    expect(change.tier).toBe("auto")
    expect(change.status).toBe("applied")
    expect(change.snapshotIds).toHaveLength(2)

    const row = byCanvasId(await deadlines(t)).get("5103")
    expect(row?.dueAt).toBe(Date.UTC(2026, 9, 16, 3, 59))
    expect(change.entity.id).toBe(row?._id)
  })

  test("added / removed / submitted / graded each land exactly one change", async () => {
    for (const [scenario, kind, canvasId] of [
      ["added", "deadline_added", "5110"],
      ["removed", "deadline_removed", "5104"],
      ["submitted", "submitted", "5103"],
      ["graded", "grade_posted", "5102"],
    ] as const) {
      const t = setupTest()
      await seed(t)
      const baseline = (await changes(t)).length

      await t.action(internal.dev.seed.applyScenario, { scenario })
      const feed = await changes(t)
      expect(feed).toHaveLength(baseline + 1)
      const change = feed[feed.length - 1]
      expect(change.kind).toBe(kind)
      expect(change.status).toBe("applied")

      const rows = byCanvasId(await deadlines(t))
      const row = rows.get(canvasId)
      expect(row).toBeDefined()
      if (kind === "deadline_added") expect(rows.size).toBe(24)
      if (kind === "deadline_removed") expect(row?.status).toBe("removed")
      if (kind === "submitted") expect(row?.submissionStatus).toBe("submitted")
      if (kind === "grade_posted") {
        expect(row?.submissionStatus).toBe("graded")
        expect(row?.score).toBe(88)
      }
    }
  })

  test("conflict: held pending, and the deadline does NOT move", async () => {
    const t = setupTest()
    await seed(t)
    const original = byCanvasId(await deadlines(t)).get("5101")
    expect(original?.dueAt).toBe(Date.UTC(2026, 8, 15, 3, 59))

    const result = await t.action(internal.dev.seed.applyScenario, {
      scenario: "conflict",
    })
    expect(result.source).toBe("ical")
    expect(result.result.proposed).toBe(1)
    expect(result.result.pending).toBe(1)

    const feed = await changes(t)
    const change = feed[feed.length - 1]
    expect(change.kind).toBe("deadline_moved")
    expect(change.origin).toBe("ical")
    expect(change.conflict).toBe(true)
    expect(change.tier).toBe("needs_approval")
    expect(change.status).toBe("pending")
    expect(change.reason).toContain("Canvas")

    // Pending changes are never applied (core.md, two-tier apply rule).
    const after = byCanvasId(await deadlines(t)).get("5101")
    expect(after?.dueAt).toBe(Date.UTC(2026, 8, 15, 3, 59))
  })
})

describe("a non-Canvas feed", () => {
  test("becomes deadlines carrying an icalUid and no Canvas id", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const sourceId: Id<"sources"> = await t.run(
      async (ctx) =>
        await ctx.db.insert("sources", {
          studentId: seeded.studentId,
          kind: "ical",
          config: { mode: "fixture", variant: "generic" },
          enabled: true,
          health: { status: "unknown", at: 0 },
        })
    )

    const poll = await t.action(internal.ingest.ical.poll, { sourceId })
    expect(poll.ok).toBe(true)

    const rows = await deadlines(t)
    const fromFeed = rows.filter(
      (row) => row.externalIds.icalUid && !row.externalIds.canvasAssignmentId
    )
    // 4 events, one of which fuzzy-matches an existing Canvas deadline.
    expect(fromFeed).toHaveLength(3)
    for (const row of fromFeed) {
      expect(row.externalIds.canvasAssignmentId).toBeUndefined()
      expect(row.provenance.source).toBe("ical")
    }
    expect(fromFeed.map((r) => r.title).sort()).toEqual([
      "Scholarship application deadline",
      "Stats study group",
      "Term paper outline",
    ])

    // The one that matched an existing Canvas row did not duplicate it.
    expect(
      rows.filter((r) => r.title === "Homework 3: Multiple Regression")
    ).toHaveLength(1)

    // `[STA210]` resolves to the real course; the rest land in a per-feed course.
    const courses = await t.run(async (ctx) => await ctx.db.query("courses").take(50))
    const outline = rows.find((r) => r.title === "Term paper outline")
    expect(courses.find((c) => c._id === outline?.courseId)?.code).toBe("STA210")
    expect(courses.some((c) => c.name.startsWith("Calendar"))).toBe(true)
  })
})

describe("the fixture student", () => {
  test("reset removes every row it created", async () => {
    const t = setupTest()
    await seed(t)
    await t.action(internal.dev.seed.applyScenario, { scenario: "moved" })

    const { deleted } = await t.mutation(internal.dev.seed.reset, {})
    expect(deleted).toBeGreaterThan(50)

    expect(await deadlines(t)).toHaveLength(0)
    expect(await changes(t)).toHaveLength(0)
    expect(await snapshots(t)).toHaveLength(0)
    expect(
      await t.run(async (ctx) => await ctx.db.query("students").take(10))
    ).toHaveLength(0)
  })

  test("the seed is idempotent: it reuses the student and its sources", async () => {
    const t = setupTest()
    const first = await seed(t)
    const second = await seed(t)
    expect(second.studentId).toBe(first.studentId)
    const sources = await t.run(async (ctx) => await ctx.db.query("sources").take(20))
    expect(sources).toHaveLength(2)
    expect(
      await t.run(async (ctx) => await ctx.db.query("students").take(10))
    ).toHaveLength(1)
    expect(canvasFixturePayload().courses).toHaveLength(5)
    expect(DEV_CLERK_ID).toBe("dev-fixture-student")
  })
})
