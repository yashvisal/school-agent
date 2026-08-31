import { describe, expect, test } from "vitest"

import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { CLERK_ID, setupTest } from "./test.setup"

/**
 * Mid-semester onboarding: one prompt settles the backlog (core.md). What these
 * tests protect: Canvas-answered rows never re-ask; resolution goes through
 * `changes` (audit trail, the only write path); a stranger can't settle another
 * student's semester.
 */

const DAY = 24 * 60 * 60 * 1000

async function seed(t: ReturnType<typeof setupTest>) {
  return await t.run(async (ctx) => {
    const studentId = await ctx.db.insert("students", {
      clerkId: CLERK_ID,
      timezone: "America/New_York",
      classBlocks: [],
      availability: { weekly: [], exceptions: [] },
      status: "active",
    })
    const courseId = await ctx.db.insert("courses", {
      studentId,
      name: "Compsci 201",
      sourceRefs: {},
      status: "active",
      provenance: { source: "canvas", sourceRef: "courses/1", confidence: 1 },
    })
    return { studentId, courseId }
  })
}

const addDeadline = (
  t: ReturnType<typeof setupTest>,
  seeded: { studentId: Id<"students">; courseId: Id<"courses"> },
  overrides: Record<string, unknown>
) =>
  t.run(async (ctx) =>
    ctx.db.insert("deadlines", {
      studentId: seeded.studentId,
      courseId: seeded.courseId,
      title: "Pset",
      kind: "homework",
      dueAt: Date.now() - 7 * DAY,
      submissionStatus: "unsubmitted",
      externalIds: {},
      provenance: { source: "canvas", sourceRef: "a/1", confidence: 1 },
      status: "active",
      ...overrides,
    })
  )

describe("pastDeadlineReview", () => {
  test("lists only past-due rows the sources could not settle", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const open = await addDeadline(t, seeded, { title: "Unsettled" })
    await addDeadline(t, seeded, { title: "Canvas said done", submissionStatus: "submitted" })
    await addDeadline(t, seeded, { title: "Graded", submissionStatus: "graded" })
    await addDeadline(t, seeded, { title: "Future", dueAt: Date.now() + 7 * DAY })
    await addDeadline(t, seeded, { title: "Undated", dueAt: undefined })
    await addDeadline(t, seeded, { title: "Removed", status: "removed" })

    const review = await t
      .withIdentity({ subject: CLERK_ID })
      .query(api.onboarding.pastDeadlineReview, { studentId: seeded.studentId })

    expect(review.count).toBe(1)
    expect(review.deadlines[0]._id).toBe(open)
  })
})

describe("resolvePastDeadlines", () => {
  test("done -> submitted, missed -> missing, both through changes", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const done = await addDeadline(t, seeded, { title: "Did it on paper" })
    const missed = await addDeadline(t, seeded, { title: "Skipped it" })
    const as = t.withIdentity({ subject: CLERK_ID })

    const r1 = await as.mutation(api.onboarding.resolvePastDeadlines, {
      studentId: seeded.studentId,
      deadlineIds: [done],
      as: "done",
    })
    const r2 = await as.mutation(api.onboarding.resolvePastDeadlines, {
      studentId: seeded.studentId,
      deadlineIds: [missed],
      as: "missed",
    })
    expect(r1).toEqual({ resolved: 1, skipped: 0 })
    expect(r2).toEqual({ resolved: 1, skipped: 0 })

    const rows = await t.run(async (ctx) => ({
      done: await ctx.db.get("deadlines", done),
      missed: await ctx.db.get("deadlines", missed),
      changes: await ctx.db.query("changes").take(10),
    }))
    expect(rows.done?.submissionStatus).toBe("submitted")
    expect(rows.missed?.submissionStatus).toBe("missing")
    // The audit trail: manual origin, approved via web, one row per deadline.
    expect(rows.changes).toHaveLength(2)
    for (const change of rows.changes) {
      expect(change.origin).toBe("manual")
      expect(change.status).toBe("approved")
      expect(change.resolvedVia).toBe("web")
    }
  })

  test("settled, foreign, and future rows are skipped, not clobbered", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const settled = await addDeadline(t, seeded, { submissionStatus: "graded" })
    // Future work must never be marked done through this path (CR 3898632581).
    const future = await addDeadline(t, seeded, { dueAt: Date.now() + 7 * DAY })
    // Another student's row in the batch is skipped, not thrown (CR 3898632562).
    const foreign = await t.run(async (ctx) => {
      const otherStudent = await ctx.db.insert("students", {
        clerkId: "user_other",
        timezone: "America/New_York",
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
      const otherCourse = await ctx.db.insert("courses", {
        studentId: otherStudent,
        name: "Other 101",
        sourceRefs: {},
        status: "active",
        provenance: { source: "canvas", sourceRef: "courses/9", confidence: 1 },
      })
      return await ctx.db.insert("deadlines", {
        studentId: otherStudent,
        courseId: otherCourse,
        title: "Not yours",
        kind: "homework",
        dueAt: Date.now() - 7 * DAY,
        submissionStatus: "unsubmitted",
        externalIds: {},
        provenance: { source: "canvas", sourceRef: "a/9", confidence: 1 },
        status: "active",
      })
    })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.onboarding.resolvePastDeadlines, {
        studentId: seeded.studentId,
        deadlineIds: [settled, future, foreign],
        as: "done",
      })
    expect(result).toEqual({ resolved: 0, skipped: 3 })
    const rows = await t.run(async (ctx) => ({
      settled: await ctx.db.get("deadlines", settled),
      future: await ctx.db.get("deadlines", future),
      foreign: await ctx.db.get("deadlines", foreign),
    }))
    expect(rows.settled?.submissionStatus).toBe("graded")
    expect(rows.future?.submissionStatus).toBe("unsubmitted")
    expect(rows.foreign?.submissionStatus).toBe("unsubmitted")
  })

  test("a stranger cannot settle another student's semester", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const d = await addDeadline(t, seeded, {})
    await expect(
      t
        .withIdentity({ subject: "user_stranger" })
        .mutation(api.onboarding.resolvePastDeadlines, {
          studentId: seeded.studentId,
          deadlineIds: [d],
          as: "done",
        })
    ).rejects.toThrow(/403/)
  })
})

describe("approveMany", () => {
  test("another student's pending change is skipped, not approved", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    // The tenant-isolation branch (CR 3898824600): a foreign id in the batch
    // must neither approve nor abort the caller's own approvals.
    const { foreignChange, ownChange } = await t.run(async (ctx) => {
      const otherStudent = await ctx.db.insert("students", {
        clerkId: "user_other",
        timezone: "America/New_York",
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
      const mkChange = (studentId: Id<"students">) =>
        ctx.db.insert("changes", {
          studentId,
          kind: "chat_decision" as const,
          entity: { table: "deadlines" as const },
          after: {},
          origin: "syllabus" as const,
          tier: "needs_approval" as const,
          status: "pending" as const,
          snapshotIds: [],
          createdAt: Date.now(),
        })
      return {
        foreignChange: await mkChange(otherStudent),
        ownChange: await mkChange(seeded.studentId),
      }
    })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.changes.approveMany, {
        changeIds: [foreignChange, ownChange],
        via: "web",
      })
    expect(result).toEqual({ approved: 1, skipped: 1 })
    const rows = await t.run(async (ctx) => ({
      foreign: await ctx.db.get("changes", foreignChange),
      own: await ctx.db.get("changes", ownChange),
    }))
    expect(rows.foreign?.status).toBe("pending")
    expect(rows.own?.status).toBe("approved")
  })


  test("approves pending rows in bulk; resolved rows count as skipped", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    const ids: Id<"changes">[] = await t.run(async (ctx) => {
      const out: Id<"changes">[] = []
      for (let i = 0; i < 3; i++) {
        out.push(
          await ctx.db.insert("changes", {
            studentId: seeded.studentId,
            courseId: seeded.courseId,
            kind: "deadline_added",
            entity: { table: "deadlines" },
            after: {
              courseId: seeded.courseId,
              title: `Syllabus item ${i}`,
              kind: "homework",
              submissionStatus: "unknown",
              externalIds: {},
              status: "active",
            },
            origin: "syllabus",
            tier: "needs_approval",
            status: i === 2 ? "rejected" : "pending",
            snapshotIds: [],
            createdAt: Date.now(),
          })
        )
      }
      return out
    })

    const result = await as.mutation(api.changes.approveMany, {
      changeIds: ids,
      via: "web",
    })
    expect(result).toEqual({ approved: 2, skipped: 1 })

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines.map((d) => d.title).sort()).toEqual([
      "Syllabus item 0",
      "Syllabus item 1",
    ])
  })
})
