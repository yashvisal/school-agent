import { describe, expect, test } from "vitest"

import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { localDateToMs } from "./lib/time"
import { CLERK_ID, setupTest } from "./test.setup"
import { PLAN_CACHE_MAX_AGE_MS, normalizePhone } from "./voice"

/**
 * The three Voice tools plus the usage log — the entire surface eve reaches
 * (vision §10 "the tool boundary is the seam", core.md "the three Voice tools").
 *
 * What these tests protect:
 * - `proposeChange` honours the two-tier rule, so Voice can never write state
 *   without either an authoritative source or the student's word (rule 1).
 * - `recordSignal` stores provenance, so a remark is always traceable to the
 *   conversation it came from.
 * - `getFeasibleActions` serves the nightly snapshot, so the morning text and
 *   every follow-up in that conversation describe the same day.
 */

const TZ = "America/New_York"
const DATE = "2026-09-14" // Monday
const at = (date: string, minutes: number) => localDateToMs(date, minutes, TZ)
const NOW = at(DATE, 6 * 60)

type Seeded = { studentId: Id<"students">; courseId: Id<"courses"> }

async function seed(t: ReturnType<typeof setupTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const studentId = await ctx.db.insert("students", {
      clerkId: CLERK_ID,
      timezone: TZ,
      phone: "+15551234567",
      classBlocks: [
        { dayOfWeek: 1, startMin: 10 * 60, endMin: 11 * 60 + 15, label: "CS201" },
      ],
      availability: {
        weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startMin: 9 * 60,
          endMin: 21 * 60,
        })),
        exceptions: [],
      },
      status: "active",
    })
    const courseId = await ctx.db.insert("courses", {
      studentId,
      name: "Compsci 201",
      code: "CS201",
      sourceRefs: { canvasCourseId: "1001" },
      gradingScheme: { categories: [{ name: "Problem Sets", weight: 0.3 }] },
      status: "active",
      provenance: { source: "canvas", sourceRef: "courses/1001", confidence: 1 },
    })
    return { studentId, courseId }
  })
}

const addDeadline = (
  t: ReturnType<typeof setupTest>,
  seeded: Seeded,
  overrides: Record<string, unknown> = {}
) =>
  t.run(async (ctx) =>
    ctx.db.insert("deadlines", {
      studentId: seeded.studentId,
      courseId: seeded.courseId,
      title: "Pset 3",
      kind: "homework",
      dueAt: at("2026-09-17", 23 * 60 + 59),
      pointsPossible: 25,
      category: "Problem Sets",
      submissionStatus: "unsubmitted",
      externalIds: { canvasAssignmentId: "5001" },
      provenance: { source: "canvas", sourceRef: "assignments/5001", confidence: 1 },
      status: "active",
      ...overrides,
    })
  )

const emptyDigest = {
  availability: [],
  pacing: [],
  preference: [],
  difficulty: [],
  life_event: [],
  other: [],
}

/**
 * A complete `Option`. The cached path is validated against the same `returns`
 * validator as the live one, so a snapshot that has drifted out of shape fails
 * loudly here rather than reaching Voice as a half-built plan.
 */
const snapshotOption = {
  title: "from the snapshot",
  kind: "homework" as const,
  estEffortMin: 120,
  estEffortConfidence: "low" as const,
  effortSource: "prior" as const,
  fits: [{ windowIndex: 0, startMin: 540, endMin: 600 }],
  remainingWindowsBeforeDue: 3,
  facts: ["due Thu Sep 17 11:59pm (in 3 days)"],
}

// ---------------------------------------------------------------------------
// getFeasibleActions
// ---------------------------------------------------------------------------

describe("getFeasibleActions", () => {
  test("computes live when there is no stored run", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })

    expect(plan.cached).toBe(false)
    expect(plan.planRunId).toBeUndefined()
    expect(plan.timezone).toBe(TZ)
    expect(plan.date).toBe(DATE)
    expect(plan.options).toHaveLength(1)
    expect(plan.options[0].title).toBe("Pset 3")
    // The class block splits the day, so there is a window either side of it.
    expect(plan.windows).toHaveLength(2)
  })

  test("serves the nightly planRuns snapshot when it is fresh", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    const planRunId = await t.run(async (ctx) =>
      ctx.db.insert("planRuns", {
        studentId: seeded.studentId,
        date: DATE,
        computedAt: NOW - 60_000,
        feasible: {
          date: DATE,
          windows: [{ startMin: 540, endMin: 600, durationMin: 60 }],
          options: [snapshotOption],
        },
        pendingAnnotations: [{ changeId: "c1", kind: "deadline_moved", summary: "s" }],
        signalsDigest: { ...emptyDigest, pacing: ["said 2h, took 4h"] },
        operationId: `nightly:${seeded.studentId}:${DATE}`,
        triggerStatus: "triggered",
      })
    )

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })

    expect(plan.cached).toBe(true)
    expect(plan.planRunId).toBe(planRunId)
    expect(plan.computedAt).toBe(NOW - 60_000)
    expect(plan.options).toEqual([snapshotOption])
    expect(plan.signalsDigest.pacing).toEqual(["said 2h, took 4h"])
    expect(plan.pending).toHaveLength(1)
  })

  test("recomputes when the stored run is older than the cache window", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    await t.run(async (ctx) =>
      ctx.db.insert("planRuns", {
        studentId: seeded.studentId,
        date: DATE,
        computedAt: NOW - PLAN_CACHE_MAX_AGE_MS - 1,
        feasible: {
          date: DATE,
          windows: [],
          options: [{ ...snapshotOption, title: "stale" }],
        },
        pendingAnnotations: [],
        signalsDigest: emptyDigest,
        operationId: `nightly:${seeded.studentId}:${DATE}`,
        triggerStatus: "triggered",
      })
    )

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })

    expect(plan.cached).toBe(false)
    expect(plan.options.map((o) => o.title)).toEqual(["Pset 3"])
  })

  test("a pending change annotates the option but never moves the plan", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    const applied = at("2026-09-17", 23 * 60 + 59)

    await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: {
        kind: "deadline_moved",
        entity: { table: "deadlines", id: deadlineId },
        after: { dueAt: at("2026-09-18", 23 * 60 + 59) },
      },
    })

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })

    expect(plan.options[0].dueAt).toBe(applied)
    expect(plan.options[0].pending?.[0]).toContain("Fri Sep 18")
    expect(plan.pending).toHaveLength(1)
  })

  test("a change landing after the snapshot invalidates it", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    await t.run(async (ctx) =>
      ctx.db.insert("planRuns", {
        studentId: seeded.studentId,
        date: DATE,
        computedAt: NOW - 60_000,
        feasible: {
          date: DATE,
          windows: [{ startMin: 540, endMin: 600, durationMin: 60 }],
          options: [snapshotOption],
        },
        pendingAnnotations: [],
        signalsDigest: emptyDigest,
        operationId: `nightly:${seeded.studentId}:${DATE}`,
        triggerStatus: "triggered",
      })
    )

    // Something the student said since the plan was computed. (`createdAt` is
    // set to the simulated clock; the suite plans a day in 2026.)
    const { changeId } = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: { kind: "chat_decision", entity: { table: "tasks" } },
    })
    await t.run(async (ctx) =>
      ctx.db.patch("changes", changeId, { createdAt: NOW - 30_000 })
    )

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })

    // Recomputed on today's facts, and it does not cite a run it did not use.
    expect(plan.cached).toBe(false)
    expect(plan.planRunId).toBeUndefined()
    expect(plan.options.map((o) => o.title)).toEqual(["Pset 3"])
  })

  test("a change resolved after the snapshot invalidates it too", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    // Proposed BEFORE the plan, approved after it: only `resolvedAt` moved.
    const { changeId } = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: { kind: "chat_decision", entity: { table: "tasks" } },
    })
    await t.run(async (ctx) => {
      await ctx.db.patch("changes", changeId, { createdAt: NOW - 120_000 })
      await ctx.db.insert("planRuns", {
        studentId: seeded.studentId,
        date: DATE,
        computedAt: NOW - 60_000,
        feasible: { date: DATE, windows: [], options: [snapshotOption] },
        pendingAnnotations: [],
        signalsDigest: emptyDigest,
        operationId: `nightly:${seeded.studentId}:${DATE}`,
        triggerStatus: "triggered",
      })
      await ctx.db.patch("changes", changeId, {
        status: "approved",
        resolvedAt: NOW - 30_000,
        resolvedVia: "chat",
      })
    })

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })
    expect(plan.cached).toBe(false)
  })

  test("an unknown student is a 404, not an empty plan", async () => {
    const t = setupTest()
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("students", {
        clerkId: "user_ghost",
        timezone: TZ,
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
      await ctx.db.delete("students", id)
      return id
    })
    await expect(
      t.query(internal.voice.getFeasibleActions, { studentId: ghost, date: DATE })
    ).rejects.toThrow(/404/)
  })
})

// ---------------------------------------------------------------------------
// proposeChange
// ---------------------------------------------------------------------------

describe("proposeChange", () => {
  test("chat origin without inline confirmation is held pending, not applied", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "Midterm", kind: "exam", dueAt: at("2026-09-25", 12 * 60) },
        reason: "student mentioned it in chat",
      },
    })

    expect(result.tier).toBe("needs_approval")
    expect(result.status).toBe("pending")

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(0)
  })

  test("an inline chat confirmation approves and applies in the same exchange", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "Midterm", kind: "exam", dueAt: at("2026-09-25", 12 * 60) },
        confirmedInline: true,
      evidence: { quotedReply: "yeah" },
      },
    })

    // Rule 1: equal to a web tap, and it does NOT also wait in the queue.
    expect(result.tier).toBe("needs_approval")
    expect(result.status).toBe("approved")

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(1)
    expect(deadlines[0].title).toBe("Midterm")

    const pending = await t.run(async (ctx) =>
      ctx.db
        .query("changes")
        .withIndex("by_student_status", (q) =>
          q.eq("studentId", seeded.studentId).eq("status", "pending")
        )
        .take(10)
    )
    expect(pending).toHaveLength(0)
  })

  test("origin defaults to chat — Voice never claims an authoritative source", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const { changeId } = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: { kind: "chat_decision", entity: { table: "tasks" } },
    })

    const change = await t.run(async (ctx) => ctx.db.get("changes", changeId))
    expect(change?.origin).toBe("chat")
    expect(change?.tier).toBe("needs_approval")
  })

  test("Voice can never reach the auto tier, however it dresses the change", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    // `origin` is not part of the tool's surface at all: the argument validator
    // rejects it, and even if it did not, the mutation forces `chat`.
    await expect(
      t.mutation(internal.voice.proposeChange, {
        studentId: seeded.studentId,
        change: {
          courseId: seeded.courseId,
          kind: "deadline_added",
          entity: { table: "deadlines" },
          after: { title: "From Canvas", kind: "homework" },
          origin: "canvas",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      })
    ).rejects.toThrow()

    const result = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "From Canvas", kind: "homework" },
      },
    })
    expect(result.tier).toBe("needs_approval")
    expect(result.status).toBe("pending")

    const change = await t.run(async (ctx) => ctx.db.get("changes", result.changeId))
    expect(change?.origin).toBe("chat")
    expect(await t.run(async (ctx) => ctx.db.query("deadlines").take(10))).toHaveLength(0)
  })

  test("a Voice change never writes provenance claiming a structured source", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    // The student confirms inline, so this one *does* land — carrying a
    // caller-supplied provenance that claims Canvas said it.
    const result = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: {
          title: "Midterm",
          kind: "exam",
          provenance: { source: "canvas", sourceRef: "assignments/9999", confidence: 1 },
        },
        confirmedInline: true,
      evidence: { quotedReply: "yeah" },
      },
    })
    expect(result.tier).toBe("needs_approval")

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(1)
    expect(deadlines[0].provenance.source).toBe("chat")
    expect(deadlines[0].provenance.sourceRef).toBe(result.changeId)
    // The forged SOURCE is replaced; the in-range numeric confidence is the
    // one thing a caller may assert (CR 3897465420).
    expect(deadlines[0].provenance.confidence).toBe(1)
  })

  test("the reported tier matches the row that was written", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const { changeId, tier } = await t.mutation(internal.voice.proposeChange, {
      studentId: seeded.studentId,
      change: { kind: "chat_decision", entity: { table: "tasks" } },
    })
    const change = await t.run(async (ctx) => ctx.db.get("changes", changeId))
    expect(change?.tier).toBe(tier)
  })
})

// ---------------------------------------------------------------------------
// recordSignal
// ---------------------------------------------------------------------------

describe("recordSignal", () => {
  test("stores the text as told, with chat provenance", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const signalId = await t.mutation(internal.voice.recordSignal, {
      studentId: seeded.studentId,
      signal: {
        kind: "pacing",
        text: "  said 2h, took 4h on CS pset 3  ",
        refs: { courseId: seeded.courseId },
        observedAt: NOW,
        sessionId: "wrun_A",
        confidence: 0.8,
      },
    })

    const signal = await t.run(async (ctx) => ctx.db.get("studentSignals", signalId))
    expect(signal).toMatchObject({
      kind: "pacing",
      text: "said 2h, took 4h on CS pset 3",
      origin: "chat",
      observedAt: NOW,
      refs: { courseId: seeded.courseId },
      provenance: { source: "chat", sourceRef: "wrun_A", confidence: 0.8 },
    })
  })

  test("defaults provenance and observedAt when Voice omits them", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const before = Date.now()

    const signalId = await t.mutation(internal.voice.recordSignal, {
      studentId: seeded.studentId,
      signal: { kind: "life_event", text: "flying home Friday" },
    })

    const signal = await t.run(async (ctx) => ctx.db.get("studentSignals", signalId))
    expect(signal?.provenance.source).toBe("chat")
    expect(signal?.provenance.sourceRef).toBe("voice")
    // No asserted confidence -> none stored (absent, not a fabricated 0.6).
    expect(signal?.provenance.confidence).toBeUndefined()
    expect(signal?.refs).toEqual({})
    expect(signal?.observedAt).toBeGreaterThanOrEqual(before)
  })

  test("an out-of-range confidence is dropped rather than stored", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const signalId = await t.mutation(internal.voice.recordSignal, {
      studentId: seeded.studentId,
      signal: { kind: "other", text: "note", confidence: 42 },
    })
    const signal = await t.run(async (ctx) => ctx.db.get("studentSignals", signalId))
    expect(signal?.provenance.confidence).toBeUndefined()
  })

  test("empty text is rejected — a signal with no content is not a signal", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await expect(
      t.mutation(internal.voice.recordSignal, {
        studentId: seeded.studentId,
        signal: { kind: "other", text: "   " },
      })
    ).rejects.toThrow(/must not be empty/)
  })

  test("a recorded pacing signal reaches the next plan", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    await t.mutation(internal.voice.recordSignal, {
      studentId: seeded.studentId,
      signal: {
        kind: "pacing",
        text: "said 2h, took 4h on CS pset 3",
        refs: { courseId: seeded.courseId },
        observedAt: NOW,
      },
    })

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })
    expect(plan.options[0].estEffortMin).toBe(240)
    expect(plan.options[0].effortSource).toBe("signal")
    expect(plan.signalsDigest.pacing).toEqual(["said 2h, took 4h on CS pset 3"])
  })
})

// ---------------------------------------------------------------------------
// logUsage
// ---------------------------------------------------------------------------

describe("logUsage", () => {
  test("records a call against the student, defaulting the surface to voice", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const usageId = await t.mutation(internal.voice.logUsage, {
      studentId: seeded.studentId,
      model: "anthropic/claude-opus-4-7",
      promptTokens: 1200,
      completionTokens: 180,
      costUsd: 0.0234,
      sessionId: "wrun_A",
      at: NOW,
    })

    const usage = await t.run(async (ctx) => ctx.db.get("usage", usageId))
    expect(usage).toMatchObject({
      surface: "voice",
      model: "anthropic/claude-opus-4-7",
      promptTokens: 1200,
      completionTokens: 180,
      costUsd: 0.0234,
      sessionId: "wrun_A",
      at: NOW,
    })
  })

  test("nonsense token counts are floored rather than stored", async () => {
    const t = setupTest()
    const usageId = await t.mutation(internal.voice.logUsage, {
      model: "m",
      promptTokens: -5,
      completionTokens: 10.7,
      costUsd: -1,
    })
    const usage = await t.run(async (ctx) => ctx.db.get("usage", usageId))
    expect(usage?.promptTokens).toBe(0)
    expect(usage?.completionTokens).toBe(10)
    expect(usage?.costUsd).toBeUndefined()
    expect(usage?.studentId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveStudent
// ---------------------------------------------------------------------------

describe("resolveStudent", () => {
  test("finds a student by their phone number", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const resolved = await t.query(internal.voice.resolveStudent, {
      phone: "+15551234567",
    })
    expect(resolved).toEqual({
      studentId: seeded.studentId,
      timezone: TZ,
      status: "active",
    })
  })

  test("normalizes the number Photon hands over", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    for (const phone of ["(555) 123-4567", "555-123-4567", "1 555 123 4567"]) {
      const resolved = await t.query(internal.voice.resolveStudent, { phone })
      expect(resolved?.studentId).toBe(seeded.studentId)
    }
  })

  test("finds a student by their Clerk id", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const resolved = await t.query(internal.voice.resolveStudent, { clerkId: CLERK_ID })
    expect(resolved?.studentId).toBe(seeded.studentId)
  })

  test("two students on one number is a 409, not a coin flip", async () => {
    const t = setupTest()
    await seed(t)
    await t.run(async (ctx) =>
      ctx.db.insert("students", {
        clerkId: "user_twin",
        timezone: TZ,
        phone: "+15551234567",
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
    )

    await expect(
      t.query(internal.voice.resolveStudent, { phone: "(555) 123-4567" })
    ).rejects.toThrow(/409/)
  })

  test("an unknown identifier resolves to null, never to someone else", async () => {
    const t = setupTest()
    await seed(t)
    expect(
      await t.query(internal.voice.resolveStudent, { phone: "+15559999999" })
    ).toBeNull()
    expect(
      await t.query(internal.voice.resolveStudent, { clerkId: "user_nobody" })
    ).toBeNull()
    expect(await t.query(internal.voice.resolveStudent, {})).toBeNull()
  })
})

describe("normalizePhone", () => {
  test("produces E.164 for the shapes a human or Photon can supply", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567")
    expect(normalizePhone("5551234567")).toBe("+15551234567")
    // 00 is the international access prefix; E.164 spells it "+".
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958")
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958")
  })

  test("leaves a number it cannot read alone rather than inventing digits", () => {
    expect(normalizePhone("not a phone")).toBe("not a phone")
  })
})
