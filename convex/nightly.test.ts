import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { localDateToMs } from "./lib/time"
import { DEFAULT_NIGHTLY_HOUR, operationIdFor } from "./nightly"
import { CLERK_ID, OTHER_CLERK_ID, setupTest } from "./test.setup"

/**
 * The nightly precompute and the Voice trigger (core.md, "Nightly precompute";
 * vision §6.1).
 *
 * The failure this suite exists to prevent is a duplicate morning text. The pass
 * runs hourly and both ends can retry, so idempotency is asserted at every
 * layer: the `planRuns.operationId` row, the already-triggered short circuit,
 * and the absence of a second POST.
 *
 * The other half is that a deployment with no Voice attached — every dev
 * deployment until Spike A lands — must still compute and store a plan. Missing
 * Voice is `skipped`, not a failure.
 */

const TZ = "America/New_York"
const VOICE_URL = "https://voice.example.com"

/** 2026-09-14 is a Monday; the pass computes for Tuesday the 15th. */
const TODAY = "2026-09-14"
const TOMORROW = "2026-09-15"
const at = (date: string, minutes: number) => localDateToMs(date, minutes, TZ)

/** 4am local on the 14th — the default nightly hour. */
const NIGHTLY_NOW = at(TODAY, DEFAULT_NIGHTLY_HOUR * 60)

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, sessionId: "wrun_A", status: "accepted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  )
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("EVE_VOICE_URL", VOICE_URL)
  vi.stubEnv("EVE_VOICE_TOKEN", "eve-token")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

type Seeded = { studentId: Id<"students">; courseId: Id<"courses"> }

async function seed(
  t: ReturnType<typeof setupTest>,
  overrides: Record<string, unknown> = {}
): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const studentId = await ctx.db.insert("students", {
      clerkId: CLERK_ID,
      timezone: TZ,
      classBlocks: [],
      availability: {
        weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startMin: 9 * 60,
          endMin: 21 * 60,
        })),
        exceptions: [],
      },
      status: "active",
      ...overrides,
    })
    const courseId = await ctx.db.insert("courses", {
      studentId,
      name: "Compsci 201",
      sourceRefs: {},
      status: "active",
      provenance: { source: "canvas", sourceRef: "courses/1001", confidence: 1 },
    })
    return { studentId, courseId }
  })
}

const addDeadline = (t: ReturnType<typeof setupTest>, seeded: Seeded) =>
  t.run(async (ctx) =>
    ctx.db.insert("deadlines", {
      studentId: seeded.studentId,
      courseId: seeded.courseId,
      title: "Pset 3",
      kind: "homework",
      dueAt: at("2026-09-17", 23 * 60 + 59),
      submissionStatus: "unsubmitted",
      externalIds: {},
      provenance: { source: "canvas", sourceRef: "a/1", confidence: 1 },
      status: "active",
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

const runsFor = (t: ReturnType<typeof setupTest>) =>
  t.run(async (ctx) => ctx.db.query("planRuns").take(20))

// ---------------------------------------------------------------------------
// storeRun
// ---------------------------------------------------------------------------

describe("storeRun", () => {
  const payload = (studentId: Id<"students">, computedAt: number) => ({
    studentId,
    date: TOMORROW,
    computedAt,
    feasible: { date: TOMORROW, windows: [], options: [] },
    pendingAnnotations: [],
    signalsDigest: emptyDigest,
  })

  test("derives a stable operationId from the student and the date", () => {
    expect(operationIdFor("students_1", TOMORROW)).toBe(
      `nightly:students_1:${TOMORROW}`
    )
  })

  test("inserts one run, pending its trigger", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)

    const stored = await t.mutation(
      internal.nightly.storeRun,
      payload(studentId, NIGHTLY_NOW)
    )
    expect(stored.alreadyTriggered).toBe(false)

    const runs = await runsFor(t)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      date: TOMORROW,
      operationId: operationIdFor(studentId, TOMORROW),
      triggerStatus: "pending",
    })
  })

  test("is idempotent on operationId — a second call makes no second run", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)

    const first = await t.mutation(
      internal.nightly.storeRun,
      payload(studentId, NIGHTLY_NOW)
    )
    const second = await t.mutation(
      internal.nightly.storeRun,
      payload(studentId, NIGHTLY_NOW + 60_000)
    )

    expect(second.planRunId).toBe(first.planRunId)
    expect(await runsFor(t)).toHaveLength(1)
  })

  test("refreshes an undelivered run so the retry carries current facts", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)

    const first = await t.mutation(
      internal.nightly.storeRun,
      payload(studentId, NIGHTLY_NOW)
    )
    await t.mutation(internal.nightly.markTrigger, {
      planRunId: first.planRunId,
      triggerStatus: "failed",
      error: "eve returned 502",
    })

    const second = await t.mutation(internal.nightly.storeRun, {
      ...payload(studentId, NIGHTLY_NOW + 3_600_000),
      feasible: { date: TOMORROW, windows: [], options: [] },
    })

    expect(second.alreadyTriggered).toBe(false)
    const runs = await runsFor(t)
    expect(runs).toHaveLength(1)
    expect(runs[0].computedAt).toBe(NIGHTLY_NOW + 3_600_000)
    // The previous failure is cleared, not carried forward.
    expect(runs[0].triggerStatus).toBe("pending")
    expect(runs[0].error).toBeUndefined()
  })

  test("a delivered run is returned untouched — never re-sent", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)

    const first = await t.mutation(
      internal.nightly.storeRun,
      payload(studentId, NIGHTLY_NOW)
    )
    await t.mutation(internal.nightly.markTrigger, {
      planRunId: first.planRunId,
      triggerStatus: "triggered",
      voiceSessionId: "wrun_A",
    })

    const second = await t.mutation(
      internal.nightly.storeRun,
      payload(studentId, NIGHTLY_NOW + 3_600_000)
    )

    expect(second.alreadyTriggered).toBe(true)
    expect(second.voiceSessionId).toBe("wrun_A")
    const runs = await runsFor(t)
    expect(runs[0].computedAt).toBe(NIGHTLY_NOW) // snapshot preserved
  })

  test("different students and different days get their own runs", async () => {
    const t = setupTest()
    const a = await seed(t)
    const b = await t.run(async (ctx) =>
      ctx.db.insert("students", {
        clerkId: OTHER_CLERK_ID,
        timezone: TZ,
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
    )

    await t.mutation(internal.nightly.storeRun, payload(a.studentId, NIGHTLY_NOW))
    await t.mutation(internal.nightly.storeRun, payload(b, NIGHTLY_NOW))
    await t.mutation(internal.nightly.storeRun, {
      ...payload(a.studentId, NIGHTLY_NOW),
      date: "2026-09-16",
    })

    expect(await runsFor(t)).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// runForStudent
// ---------------------------------------------------------------------------

describe("runForStudent", () => {
  test("computes, stores, and triggers the Voice run", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    const result = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(result.triggerStatus).toBe("triggered")
    expect(result.voiceSessionId).toBe("wrun_A")
    expect(result.date).toBe(TOMORROW)

    const runs = await runsFor(t)
    expect(runs).toHaveLength(1)
    expect(runs[0].triggerStatus).toBe("triggered")
    expect(runs[0].voiceSessionId).toBe("wrun_A")
    expect(runs[0].error).toBeUndefined()

    // The stored plan is the real one, not a placeholder.
    const feasible = runs[0].feasible as { options: { title: string }[] }
    expect(feasible.options.map((o) => o.title)).toEqual(["Pset 3"])
  })

  test("POSTs the documented eve session contract", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${VOICE_URL}/eve/v1/session`)
    expect(init.method).toBe("POST")

    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer eve-token")
    expect(headers["content-type"]).toBe("application/json")

    const body = JSON.parse(init.body as string) as {
      message: string
      operationId: string
    }
    expect(body.operationId).toBe(operationIdFor(seeded.studentId, TOMORROW))
    expect(body.message).toContain("nightly_plan")
    expect(body.message).toContain(`studentId=${seeded.studentId}`)
    expect(body.message).toContain(`date=${TOMORROW}`)

    const runs = await runsFor(t)
    expect(body.message).toContain(`planRunId=${runs[0]._id}`)
  })

  test("a repeated pass for the same day does not POST again", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const first = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })
    const second = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW + 3_600_000,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.planRunId).toBe(first.planRunId)
    expect(second.triggerStatus).toBe("triggered")
    expect(second.voiceSessionId).toBe("wrun_A")
    expect(await runsFor(t)).toHaveLength(1)
  })

  test("no EVE_VOICE_URL is skipped, not failed — the plan is still stored", async () => {
    vi.stubEnv("EVE_VOICE_URL", "")
    const t = setupTest()
    const seeded = await seed(t)
    await addDeadline(t, seeded)

    const result = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(result.triggerStatus).toBe("skipped")
    expect(result.error).toBe("EVE_VOICE_URL not set")
    expect(fetchMock).not.toHaveBeenCalled()

    const runs = await runsFor(t)
    expect(runs).toHaveLength(1)
    expect(runs[0].triggerStatus).toBe("skipped")
    const feasible = runs[0].feasible as { options: unknown[] }
    expect(feasible.options).toHaveLength(1)
  })

  test("a non-2xx from eve is recorded as failed, with the status in the error", async () => {
    fetchMock.mockResolvedValue(
      new Response("upstream exploded", { status: 502 })
    )
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(result.triggerStatus).toBe("failed")
    expect(result.error).toContain("502")
    const runs = await runsFor(t)
    expect(runs[0].triggerStatus).toBe("failed")
  })

  test("a network error is recorded as failed rather than throwing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(result.triggerStatus).toBe("failed")
    expect(result.error).toContain("ECONNREFUSED")
  })

  test("a 2xx with an unreadable body still counts as triggered", async () => {
    fetchMock.mockResolvedValue(new Response("accepted", { status: 202 }))
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(result.triggerStatus).toBe("triggered")
    expect(result.voiceSessionId).toBeUndefined()
  })

  test("a failed trigger is retried by the next pass", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }))
    const t = setupTest()
    const seeded = await seed(t)

    const first = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })
    expect(first.triggerStatus).toBe("failed")

    const second = await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW + 3_600_000,
    })
    expect(second.triggerStatus).toBe("triggered")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await runsFor(t)).toHaveLength(1)
  })

  test("stale pending changes are expired before the plan is computed (rule 5)", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const stale = await t.run(async (ctx) =>
      ctx.db.insert("changes", {
        studentId: seeded.studentId,
        kind: "deadline_moved",
        entity: { table: "deadlines" },
        origin: "chat",
        tier: "needs_approval",
        status: "pending",
        snapshotIds: [],
        createdAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
      })
    )
    const fresh = await t.run(async (ctx) =>
      ctx.db.insert("changes", {
        studentId: seeded.studentId,
        kind: "deadline_moved",
        entity: { table: "deadlines" },
        origin: "chat",
        tier: "needs_approval",
        status: "pending",
        snapshotIds: [],
        createdAt: Date.now(),
      })
    )

    await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    const rows = await t.run(async (ctx) => ({
      stale: await ctx.db.get("changes", stale),
      fresh: await ctx.db.get("changes", fresh),
    }))
    expect(rows.stale?.status).toBe("expired")
    expect(rows.stale?.resolvedVia).toBe("expired")
    // Expired, never applied.
    expect(await t.run(async (ctx) => ctx.db.query("deadlines").take(5))).toHaveLength(0)
    expect(rows.fresh?.status).toBe("pending")
  })
})

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

describe("tick", () => {
  test("starts a run at the student's local nightly hour", async () => {
    const t = setupTest()
    await seed(t)

    const result = await t.action(internal.nightly.tick, { now: NIGHTLY_NOW })

    expect(result).toEqual({ considered: 1, started: 1 })
    const runs = await runsFor(t)
    expect(runs).toHaveLength(1)
    expect(runs[0].date).toBe(TOMORROW) // tomorrow, in the student's zone
    expect(runs[0].triggerStatus).toBe("triggered")
  })

  test("does nothing at any other hour", async () => {
    const t = setupTest()
    await seed(t)

    const result = await t.action(internal.nightly.tick, {
      now: at(TODAY, (DEFAULT_NIGHTLY_HOUR + 3) * 60),
    })

    expect(result).toEqual({ considered: 1, started: 0 })
    expect(await runsFor(t)).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("honours a student's chosen nightly hour", async () => {
    const t = setupTest()
    await seed(t, { nightlyHourLocal: 6 })

    expect(await t.action(internal.nightly.tick, { now: NIGHTLY_NOW })).toMatchObject({
      started: 0,
    })
    expect(
      await t.action(internal.nightly.tick, { now: at(TODAY, 6 * 60) })
    ).toMatchObject({ started: 1 })
  })

  test("each student fires on their own local clock, not the server's", async () => {
    const t = setupTest()
    await seed(t) // America/New_York
    await t.run(async (ctx) =>
      ctx.db.insert("students", {
        clerkId: OTHER_CLERK_ID,
        timezone: "America/Los_Angeles",
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
    )

    // 4am in New York is 1am in Los Angeles, so only the first student runs.
    const result = await t.action(internal.nightly.tick, { now: NIGHTLY_NOW })
    expect(result).toEqual({ considered: 2, started: 1 })

    const runs = await runsFor(t)
    expect(runs).toHaveLength(1)
    const student = await t.run(async (ctx) =>
      ctx.db.get("students", runs[0].studentId)
    )
    expect(student?.timezone).toBe(TZ)
  })

  test("paused students are never considered", async () => {
    const t = setupTest()
    await seed(t, { status: "paused" })

    const result = await t.action(internal.nightly.tick, { now: NIGHTLY_NOW })
    expect(result).toEqual({ considered: 0, started: 0 })
    expect(await runsFor(t)).toHaveLength(0)
  })

  test("a second tick in the same hour does not start a second run", async () => {
    const t = setupTest()
    await seed(t)

    await t.action(internal.nightly.tick, { now: NIGHTLY_NOW })
    const second = await t.action(internal.nightly.tick, { now: NIGHTLY_NOW + 60_000 })

    expect(second.started).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await runsFor(t)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// findRun / runNow
// ---------------------------------------------------------------------------

describe("findRun", () => {
  test("resolves a run by its operationId, and null when there is none", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const operationId = operationIdFor(seeded.studentId, TOMORROW)

    expect(await t.query(internal.nightly.findRun, { operationId })).toBeNull()

    await t.action(internal.nightly.runForStudent, {
      studentId: seeded.studentId,
      date: TOMORROW,
      now: NIGHTLY_NOW,
    })

    expect(await t.query(internal.nightly.findRun, { operationId })).toMatchObject({
      triggerStatus: "triggered",
      voiceSessionId: "wrun_A",
    })
  })
})

describe("runNow", () => {
  test("defaults to tomorrow in the student's own timezone", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.action(internal.nightly.runNow, {
      studentId: seeded.studentId,
      now: at(TODAY, 22 * 60),
    })

    expect(result.date).toBe(TOMORROW)
    expect(result.triggerStatus).toBe("triggered")
  })

  test("accepts an explicit date", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const result = await t.action(internal.nightly.runNow, {
      studentId: seeded.studentId,
      date: "2026-09-18",
      now: NIGHTLY_NOW,
    })

    expect(result.date).toBe("2026-09-18")
    const runs = await runsFor(t)
    expect(runs[0].operationId).toBe(operationIdFor(seeded.studentId, "2026-09-18"))
  })

  test("an unknown student is a 404", async () => {
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
      t.action(internal.nightly.runNow, { studentId: ghost })
    ).rejects.toThrow(/404/)
  })
})
