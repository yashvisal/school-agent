import { describe, expect, test } from "vitest"

import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { CLERK_ID, setupTest } from "./test.setup"

/**
 * The two-tier apply rule and approval semantics (plans/core.md).
 * These are the invariants every adapter and agent tool depends on.
 */

type Seeded = { studentId: Id<"students">; courseId: Id<"courses"> }

async function seed(t: ReturnType<typeof setupTest>): Promise<Seeded> {
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
      code: "CS201",
      sourceRefs: { canvasCourseId: "1001" },
      status: "active",
      provenance: { source: "canvas", sourceRef: "courses/1001", confidence: 1 },
    })
    return { studentId, courseId }
  })
}

const deadlineAfter = (courseId: Id<"courses">, overrides: Record<string, unknown> = {}) => ({
  courseId,
  title: "Pset 3",
  kind: "homework",
  dueAt: Date.UTC(2026, 8, 15, 3, 59),
  pointsPossible: 100,
  submissionStatus: "unsubmitted",
  externalIds: { canvasAssignmentId: "5001" },
  provenance: {
    source: "canvas",
    sourceRef: "assignments/5001",
    confidence: 1,
  },
  status: "active",
  ...overrides,
})

const countDeadlines = (t: ReturnType<typeof setupTest>) =>
  t.run(async (ctx) => (await ctx.db.query("deadlines").take(100)).length)

describe("two-tier apply rule", () => {
  test("canvas deadline_added is auto-tier and applies immediately", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const result = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId),
      origin: "canvas",
    })

    expect(result.status).toBe("applied")

    const { change, deadlines } = await t.run(async (ctx) => ({
      change: await ctx.db.get("changes", result.changeId),
      deadlines: await ctx.db.query("deadlines").take(10),
    }))

    expect(change?.tier).toBe("auto")
    expect(change?.resolvedVia).toBe("auto")
    expect(deadlines).toHaveLength(1)
    expect(deadlines[0].title).toBe("Pset 3")
    expect(deadlines[0].externalIds.canvasAssignmentId).toBe("5001")
    // The created row is linked back onto the change.
    expect(change?.entity.id).toBe(deadlines[0]._id)
  })

  test("ical origin is also auto-tier", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const result = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, {
        externalIds: { icalUid: "event-assignment-5001" },
        provenance: { source: "ical", sourceRef: "feed.ics", confidence: 1 },
      }),
      origin: "ical",
    })

    expect(result.status).toBe("applied")
    expect(await countDeadlines(t)).toBe(1)
  })

  test("a conflict from canvas downgrades to needs_approval", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const result = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId),
      origin: "canvas",
      conflict: true,
      reason: "canvas and syllabus disagree on the due date",
    })

    expect(result.status).toBe("pending")
    const change = await t.run((ctx) => ctx.db.get("changes", result.changeId))
    expect(change?.tier).toBe("needs_approval")
    expect(await countDeadlines(t)).toBe(0)
  })
})

describe("needs_approval lifecycle", () => {
  test("an LLM-interpreted change holds pending and touches nothing", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const result = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, {
        title: "Midterm",
        kind: "exam",
        externalIds: {},
        provenance: { source: "syllabus", sourceRef: "p.2", confidence: 0.8 },
      }),
      origin: "syllabus",
    })

    expect(result.status).toBe("pending")
    expect(await countDeadlines(t)).toBe(0)

    const pending = await t
      .withIdentity({ subject: CLERK_ID })
      .query(api.changes.listPending, { studentId, paginationOpts: { numItems: 200, cursor: null } })
    expect(pending.page).toHaveLength(1)
    expect(pending.page[0].tier).toBe("needs_approval")
    expect(pending.page[0].resolvedVia).toBeUndefined()
  })

  test("approve applies the held change", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    const { changeId } = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Midterm", kind: "exam" }),
      origin: "syllabus",
    })

    expect(await countDeadlines(t)).toBe(0)

    const approved = await as.mutation(api.changes.approve, { changeId, via: "web" })
    expect(approved.status).toBe("approved")

    const { change, deadlines } = await t.run(async (ctx) => ({
      change: await ctx.db.get("changes", changeId),
      deadlines: await ctx.db.query("deadlines").take(10),
    }))
    expect(change?.resolvedVia).toBe("web")
    expect(deadlines).toHaveLength(1)
    expect(deadlines[0].title).toBe("Midterm")

    // The queue is drained.
    expect(
      (await as.query(api.changes.listPending, { studentId, paginationOpts: { numItems: 200, cursor: null } })).page
    ).toHaveLength(0)
  })

  test("reject resolves without applying", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    const { changeId } = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Ghost exam" }),
      origin: "site",
    })

    const rejected = await as.mutation(api.changes.reject, { changeId })
    expect(rejected.status).toBe("rejected")
    expect(await countDeadlines(t)).toBe(0)

    const change = await t.run((ctx) => ctx.db.get("changes", changeId))
    expect(change?.status).toBe("rejected")
    expect(change?.resolvedAt).toBeTypeOf("number")
  })

  test("inline chat confirmation approves and applies in one step", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    // "midterm now Friday, right?" -> "yeah"
    const result = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Midterm", kind: "exam" }),
      origin: "chat",
      confirmedInline: true,
      evidence: { quotedReply: "yeah" },
    })

    expect(result.status).toBe("approved")

    const change = await t.run((ctx) => ctx.db.get("changes", result.changeId))
    expect(change?.tier).toBe("needs_approval")
    expect(change?.resolvedVia).toBe("chat")
    expect(await countDeadlines(t)).toBe(1)

    // It does NOT also wait in the web queue.
    const pending = await t
      .withIdentity({ subject: CLERK_ID })
      .query(api.changes.listPending, { studentId, paginationOpts: { numItems: 200, cursor: null } })
    expect(pending.page).toHaveLength(0)
  })
})

describe("applying updates to existing entities", () => {
  test("deadline_moved patches the due date, deadline_removed soft-deletes", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const added = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId),
      origin: "canvas",
    })
    const deadlineId = (await t.run((ctx) => ctx.db.get("changes", added.changeId)))!
      .entity.id!

    const movedTo = Date.UTC(2026, 8, 18, 3, 59)
    await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_moved",
      entity: { table: "deadlines", id: deadlineId },
      before: { dueAt: deadlineAfter(courseId).dueAt },
      after: { dueAt: movedTo },
      origin: "canvas",
    })

    let deadline = await t.run((ctx) =>
      ctx.db.get("deadlines", deadlineId as Id<"deadlines">)
    )
    expect(deadline?.dueAt).toBe(movedTo)
    expect(deadline?.title).toBe("Pset 3")

    await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_removed",
      entity: { table: "deadlines", id: deadlineId },
      origin: "canvas",
    })

    deadline = await t.run((ctx) =>
      ctx.db.get("deadlines", deadlineId as Id<"deadlines">)
    )
    expect(deadline?.status).toBe("removed")
  })

  test("re-proposing the same canvas assignment does not duplicate the deadline", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.changes.propose, {
        studentId,
        courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: deadlineAfter(courseId),
        origin: "canvas",
      })
    }

    expect(await countDeadlines(t)).toBe(1)
  })
})

describe("expireStale", () => {
  test("expires stale pending changes and never applies them", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const stale = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Stale syllabus guess" }),
      origin: "syllabus",
    })
    const fresh = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Fresh syllabus guess" }),
      origin: "syllabus",
    })

    // Backdate the first one past the horizon.
    const horizonMs = 7 * 24 * 60 * 60 * 1000
    await t.run(async (ctx) => {
      await ctx.db.patch("changes", stale.changeId, {
        createdAt: Date.now() - horizonMs - 1000,
      })
    })

    const expired = await t.mutation(internal.changes.expireStale, {
      studentId,
      olderThanMs: horizonMs,
    })
    expect(expired).toBe(1)

    const { staleDoc, freshDoc } = await t.run(async (ctx) => ({
      staleDoc: await ctx.db.get("changes", stale.changeId),
      freshDoc: await ctx.db.get("changes", fresh.changeId),
    }))
    expect(staleDoc?.status).toBe("expired")
    expect(staleDoc?.resolvedVia).toBe("expired")
    expect(freshDoc?.status).toBe("pending")

    // Expiry is a drop, not an apply.
    expect(await countDeadlines(t)).toBe(0)

    // An expired change can no longer be approved into existence.
    const reApprove = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.changes.approve, { changeId: stale.changeId, via: "web" })
    expect(reApprove.status).toBe("expired")
    expect(await countDeadlines(t)).toBe(0)
  })
})

describe("inline confirmation evidence", () => {
  test("confirmedInline without evidence is rejected, nothing lands", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    await expect(
      t.mutation(internal.changes.propose, {
        studentId,
        courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: deadlineAfter(courseId, { title: "Claimed approval" }),
        origin: "chat",
        confirmedInline: true,
      })
    ).rejects.toThrow(/400: confirmedInline requires evidence/)

    // A whitespace-only quote is no quote.
    await expect(
      t.mutation(internal.changes.propose, {
        studentId,
        courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: deadlineAfter(courseId, { title: "Claimed approval" }),
        origin: "chat",
        confirmedInline: true,
        evidence: { quotedReply: "   " },
      })
    ).rejects.toThrow(/400: confirmedInline requires evidence/)

    expect(await countDeadlines(t)).toBe(0)
    const changes = await t.run(async (ctx) => ctx.db.query("changes").take(10))
    expect(changes).toHaveLength(0)
  })

  test("the quoted reply is stored and visible in the feed", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Midterm moved" }),
      origin: "chat",
      confirmedInline: true,
      evidence: { quotedReply: "yeah", inboundMessageId: "msg_42" },
    })

    const feed = await t
      .withIdentity({ subject: CLERK_ID })
      .query(api.changes.listRecent, { studentId })
    // The Dashboard can render: confirmed in chat: "yeah".
    expect(feed[0].evidence).toEqual({ quotedReply: "yeah", inboundMessageId: "msg_42" })
    expect(feed[0].resolvedVia).toBe("chat")
  })

  test("a change without inline confirmation carries no evidence", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, { title: "Pending guess" }),
      origin: "syllabus",
      // Evidence supplied without confirmedInline is dropped, not stored.
      evidence: { quotedReply: "not actually a confirmation" },
    })

    const changes = await t.run(async (ctx) => ctx.db.query("changes").take(10))
    expect(changes[0].status).toBe("pending")
    expect(changes[0].evidence).toBeUndefined()
  })
})

describe("expireStale reaches past the front window", () => {
  test("stale rows behind a full window of fresh ones are still expired", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)
    const horizonMs = 7 * 24 * 60 * 60 * 1000

    // 210 fresh pending rows FIRST (they occupy the front of the index by
    // _creationTime), then 30 stale ones behind them — the exact shape the old
    // fixed take(200) window could never reach (CR 3892156162).
    await t.run(async (ctx) => {
      const base = {
        studentId,
        courseId,
        kind: "deadline_added" as const,
        entity: { table: "deadlines" as const },
        after: {},
        origin: "syllabus" as const,
        tier: "needs_approval" as const,
        status: "pending" as const,
        snapshotIds: [],
      }
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert("changes", { ...base, createdAt: Date.now() })
      }
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("changes", {
          ...base,
          createdAt: Date.now() - horizonMs - 60_000,
        })
      }
    })

    const expired = await t.mutation(internal.changes.expireStale, {
      studentId,
      olderThanMs: horizonMs,
    })
    expect(expired).toBe(30)

    // The fresh ones are untouched and fully listable through pagination.
    let cursor: string | null = null
    let seen = 0
    for (;;) {
      const page: { page: unknown[]; isDone: boolean; continueCursor: string } = await t
        .withIdentity({ subject: CLERK_ID })
        .query(api.changes.listPending, {
          studentId,
          paginationOpts: { numItems: 100, cursor },
        })
      seen += page.page.length
      if (page.isDone) break
      cursor = page.continueCursor
    }
    expect(seen).toBe(210)
  })
})

describe("tenancy — a change may only ever touch its own student", () => {
  /** A second student with their own course and deadline. */
  async function seedOther(t: ReturnType<typeof setupTest>) {
    return await t.run(async (ctx) => {
      const studentId = await ctx.db.insert("students", {
        clerkId: "user_test_stranger",
        timezone: "America/New_York",
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
      const courseId = await ctx.db.insert("courses", {
        studentId,
        name: "Their course",
        sourceRefs: {},
        status: "active",
        provenance: { source: "canvas", sourceRef: "courses/2002", confidence: 1 },
      })
      const deadlineId = await ctx.db.insert("deadlines", {
        studentId,
        courseId,
        title: "Their pset",
        kind: "homework",
        dueAt: Date.UTC(2026, 8, 20, 3, 59),
        submissionStatus: "unsubmitted",
        externalIds: {},
        provenance: { source: "canvas", sourceRef: "assignments/9", confidence: 1 },
        status: "active",
      })
      return { studentId, courseId, deadlineId }
    })
  }

  test("a change naming another student's deadline throws and writes nothing", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)
    const other = await seedOther(t)

    await expect(
      t.mutation(internal.changes.propose, {
        studentId,
        courseId,
        kind: "deadline_moved",
        entity: { table: "deadlines", id: other.deadlineId },
        after: { dueAt: Date.UTC(2027, 0, 1) },
        origin: "canvas",
      })
    ).rejects.toThrow(/403/)

    const { theirs, changes } = await t.run(async (ctx) => ({
      theirs: await ctx.db.get("deadlines", other.deadlineId),
      changes: await ctx.db.query("changes").take(10),
    }))
    // The whole mutation rolled back: their row is untouched, and the change
    // row that would have recorded the attempt was never committed either.
    expect(theirs?.dueAt).toBe(Date.UTC(2026, 8, 20, 3, 59))
    expect(changes).toHaveLength(0)
  })

  test("an insert under another student's course throws and writes nothing", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const other = await seedOther(t)

    await expect(
      t.mutation(internal.changes.propose, {
        studentId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: deadlineAfter(other.courseId, { title: "Smuggled in" }),
        origin: "canvas",
      })
    ).rejects.toThrow(/403/)

    // Only the other student's own seeded deadline remains; nothing was created.
    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(100))
    expect(deadlines.map((d) => d.studentId)).toEqual([other.studentId])
  })

  test("a chat_decision cannot patch another student's row", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const other = await seedOther(t)

    await expect(
      t.mutation(internal.changes.propose, {
        studentId,
        kind: "chat_decision",
        entity: { table: "students", id: other.studentId },
        after: { nightlyHourLocal: 23 },
        origin: "chat",
        confirmedInline: true,
      evidence: { quotedReply: "yeah" },
      })
    ).rejects.toThrow(/403/)

    const them = await t.run((ctx) => ctx.db.get("students", other.studentId))
    expect(them?.nightlyHourLocal).toBeUndefined()
  })

  test("a chat change reaches the schedule fields and nothing else", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)

    await t.mutation(internal.changes.propose, {
      studentId,
      kind: "availability_updated",
      entity: { table: "students", id: studentId },
      after: {
        // allowed
        nightlyHourLocal: 6,
        semesterEnd: "2026-12-18",
        classBlocks: [{ dayOfWeek: 1, startMin: 600, endMin: 675 }],
        // identity and routing — an interpreted sentence must not move these
        phone: "+15550000000",
        status: "paused",
        timezone: "Pacific/Auckland",
        clerkId: "user_someone_else",
      },
      origin: "chat",
      confirmedInline: true,
      evidence: { quotedReply: "yeah" },
    })

    const student = await t.run((ctx) => ctx.db.get("students", studentId))
    expect(student?.nightlyHourLocal).toBe(6)
    expect(student?.semesterEnd).toBe("2026-12-18")
    expect(student?.classBlocks).toHaveLength(1)
    expect(student?.phone).toBeUndefined()
    expect(student?.status).toBe("active")
    expect(student?.timezone).toBe("America/New_York")
    expect(student?.clerkId).toBe(CLERK_ID)
  })

  test("a manual change may set the phone, and it is normalized on the way in", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)

    await t.mutation(internal.changes.propose, {
      studentId,
      kind: "availability_updated",
      entity: { table: "students", id: studentId },
      after: { phone: "(555) 123-4567" },
      origin: "manual",
      confirmedInline: true,
      evidence: { quotedReply: "yeah" },
    })

    const student = await t.run((ctx) => ctx.db.get("students", studentId))
    // Stored in the same form `resolveStudent` looks up by.
    expect(student?.phone).toBe("+15551234567")
  })
})

describe("provenance", () => {
  test("an interpreted change cannot claim a structured source", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const { changeId } = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, {
        title: "Heard in chat",
        // A forged source AND an out-of-range confidence: neither survives.
        provenance: { source: "canvas", sourceRef: "assignments/5001", confidence: 7 },
      }),
      origin: "chat",
      confirmedInline: true,
      evidence: { quotedReply: "yeah" },
    })

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    // No source asserted a confidence, so none is stored — absent, not 0.5.
    expect(deadlines[0].provenance).toEqual({
      source: "chat",
      sourceRef: changeId,
    })
    expect(deadlines[0].provenance.confidence).toBeUndefined()
  })

  test("a chat change may supply a real confidence, but never a source", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const { changeId } = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      // The caller asserts a measured confidence AND a forged source; only the
      // number survives (CR 3897465420).
      after: deadlineAfter(courseId, {
        title: "Extracted from syllabus screenshot",
        provenance: { source: "canvas", sourceRef: "forged", confidence: 0.9 },
      }),
      origin: "chat",
      confirmedInline: true,
      evidence: { quotedReply: "yeah" },
    })

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines[0].provenance).toEqual({
      source: "chat",
      sourceRef: changeId,
      confidence: 0.9,
    })
  })

  test("an authoritative source keeps the provenance it supplied", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId),
      origin: "canvas",
    })

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines[0].provenance).toMatchObject({
      source: "canvas",
      sourceRef: "assignments/5001",
      confidence: 1,
    })
  })
})

describe("clearing a field", () => {
  test("a reopened submission drops the score it was graded with", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const added = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId, {
        submissionStatus: "graded",
        score: 18,
      }),
      origin: "canvas",
    })
    const deadlineId = (await t.run((ctx) => ctx.db.get("changes", added.changeId)))!
      .entity.id! as Id<"deadlines">
    expect(await t.run((ctx) => ctx.db.get("deadlines", deadlineId))).toMatchObject({
      score: 18,
    })

    // The grade is retracted upstream: the field is gone, which arrives as an
    // explicit null (Convex values cannot be `undefined` on the wire).
    await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_updated",
      entity: { table: "deadlines", id: deadlineId },
      after: deadlineAfter(courseId, {
        submissionStatus: "unsubmitted",
        score: null,
      }),
      origin: "canvas",
      reason: "Submission reopened",
    })

    const deadline = await t.run((ctx) => ctx.db.get("deadlines", deadlineId))
    expect(deadline?.submissionStatus).toBe("unsubmitted")
    // Not a stale 18/20 on work the student now has to redo.
    expect(deadline?.score).toBeUndefined()
  })

  test("null never clears a required field — it fails loudly instead", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const added = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId),
      origin: "canvas",
    })
    const deadlineId = (await t.run((ctx) => ctx.db.get("changes", added.changeId)))!
      .entity.id! as Id<"deadlines">

    await expect(
      t.mutation(internal.changes.propose, {
        studentId,
        courseId,
        kind: "deadline_updated",
        entity: { table: "deadlines", id: deadlineId },
        after: { title: null },
        origin: "canvas",
      })
    ).rejects.toThrow()

    expect(
      (await t.run((ctx) => ctx.db.get("deadlines", deadlineId)))?.title
    ).toBe("Pset 3")
  })
})

describe("authorization", () => {
  test("another identity cannot read or approve this student's changes", async () => {
    const t = setupTest()
    const { studentId, courseId } = await seed(t)

    const { changeId } = await t.mutation(internal.changes.propose, {
      studentId,
      courseId,
      kind: "deadline_added",
      entity: { table: "deadlines" },
      after: deadlineAfter(courseId),
      origin: "syllabus",
    })

    const stranger = t.withIdentity({ subject: "user_test_stranger" })
    await expect(
      stranger.query(api.changes.listPending, { studentId, paginationOpts: { numItems: 200, cursor: null } })
    ).rejects.toThrow(/403/)
    await expect(
      stranger.mutation(api.changes.approve, { changeId, via: "web" })
    ).rejects.toThrow(/403/)

    // Signed out is a 401, not a silent read.
    await expect(t.query(api.changes.listPending, { studentId, paginationOpts: { numItems: 200, cursor: null } })).rejects.toThrow(
      /401/
    )
  })
})
