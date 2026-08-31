import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { Id } from "./_generated/dataModel"
import { timingSafeEqual } from "./lib/httpAuth"
import { localDateToMs } from "./lib/time"
import { CLERK_ID, setupTest } from "./test.setup"

/**
 * The agent HTTP surface (`convex/http.ts`) — how eve reaches Core.
 *
 * This is the only publicly-addressable door to the Voice tools, so the tests
 * that matter most are the negative ones: no bearer, wrong bearer, junk body,
 * malformed id. Each must be a clean, specific status rather than a 500 that
 * leaks a stack trace or, worse, a 200 that wrote something.
 */

const SECRET = "test-core-agent-secret-0123456789"
const TZ = "America/New_York"
const DATE = "2026-09-14"
const at = (date: string, minutes: number) => localDateToMs(date, minutes, TZ)

beforeEach(() => {
  vi.stubEnv("CORE_AGENT_SECRET", SECRET)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

type Seeded = { studentId: Id<"students">; courseId: Id<"courses"> }

async function seed(t: ReturnType<typeof setupTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const studentId = await ctx.db.insert("students", {
      clerkId: CLERK_ID,
      timezone: TZ,
      phone: "+15551234567",
      classBlocks: [],
      availability: {
        weekly: [{ dayOfWeek: 1, startMin: 9 * 60, endMin: 21 * 60 }],
        exceptions: [],
      },
      status: "active",
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

const post = (
  t: ReturnType<typeof setupTest>,
  path: string,
  body: unknown,
  init: { auth?: string | null; raw?: string } = {}
) =>
  t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.auth === null
        ? {}
        : { authorization: init.auth ?? `Bearer ${SECRET}` }),
    },
    body: init.raw ?? JSON.stringify(body),
  })

const ROUTES = [
  "/voice/getFeasibleActions",
  "/voice/proposeChange",
  "/voice/recordSignal",
  "/voice/logUsage",
  "/voice/resolveStudent",
  "/voice/recordInbound",
] as const

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("auth", () => {
  for (const path of ROUTES) {
    test(`${path} rejects a request with no Authorization header`, async () => {
      const t = setupTest()
      const response = await post(t, path, {}, { auth: null })
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: "unauthorized",
      })
    })
  }

  test("rejects a wrong bearer token", async () => {
    const t = setupTest()
    const response = await post(
      t,
      "/voice/resolveStudent",
      { phone: "+15551234567" },
      { auth: "Bearer not-the-secret" }
    )
    expect(response.status).toBe(401)
  })

  test("rejects a token that is a prefix of the real one", async () => {
    const t = setupTest()
    const response = await post(
      t,
      "/voice/resolveStudent",
      {},
      { auth: `Bearer ${SECRET.slice(0, -1)}` }
    )
    expect(response.status).toBe(401)
  })

  test("rejects a non-Bearer scheme carrying the right secret", async () => {
    const t = setupTest()
    const response = await post(t, "/voice/resolveStudent", {}, { auth: SECRET })
    expect(response.status).toBe(401)
  })

  test("fails closed when the deployment has no CORE_AGENT_SECRET set", async () => {
    vi.stubEnv("CORE_AGENT_SECRET", "")
    const t = setupTest()
    const response = await post(t, "/voice/resolveStudent", { phone: "+1555" })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/CORE_AGENT_SECRET/)
  })

  test("accepts the scheme case-insensitively, as HTTP requires", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(
      t,
      "/voice/resolveStudent",
      { phone: "+15551234567" },
      { auth: `bearer ${SECRET}` }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { studentId: string }
    expect(body.studentId).toBe(seeded.studentId)
  })
})

describe("timingSafeEqual", () => {
  test("matches only exactly equal strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true)
    expect(timingSafeEqual("abc", "abd")).toBe(false)
    expect(timingSafeEqual("abc", "ab")).toBe(false)
    expect(timingSafeEqual("", "")).toBe(true)
    expect(timingSafeEqual("", "a")).toBe(false)
  })

  test("handles multi-byte characters without a length shortcut", () => {
    expect(timingSafeEqual("é", "é")).toBe(true)
    expect(timingSafeEqual("é", "e")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Body handling
// ---------------------------------------------------------------------------

describe("body validation", () => {
  for (const path of ROUTES) {
    test(`${path} returns 400 on a malformed JSON body`, async () => {
      const t = setupTest()
      const response = await post(t, path, undefined, { raw: "{not json" })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: string }
      expect(body.error).toMatch(/valid JSON/)
    })

    test(`${path} returns 400 when the body is not an object`, async () => {
      const t = setupTest()
      const response = await post(t, path, undefined, { raw: "[1,2,3]" })
      expect(response.status).toBe(400)
    })
  }

  test("auth is checked before the body is parsed", async () => {
    const t = setupTest()
    const response = await post(t, "/voice/proposeChange", undefined, {
      auth: null,
      raw: "{not json",
    })
    expect(response.status).toBe(401)
  })

  test("getFeasibleActions rejects a date that is not YYYY-MM-DD", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/getFeasibleActions", {
      studentId: seeded.studentId,
      date: "September 14th",
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/YYYY-MM-DD/)
  })

  test("getFeasibleActions rejects a date that never happened", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    // Right shape, wrong calendar: `Date.UTC` would silently roll this into March.
    for (const date of ["2026-02-31", "2026-13-01", "2026-00-10"]) {
      const response = await post(t, "/voice/getFeasibleActions", {
        studentId: seeded.studentId,
        date,
      })
      expect(response.status).toBe(400)
    }
    // A real leap day still passes.
    const leap = await post(t, "/voice/getFeasibleActions", {
      studentId: seeded.studentId,
      date: "2028-02-29",
    })
    expect(leap.status).toBe(200)
  })

  test("a missing required field is a 400 naming the field", async () => {
    const t = setupTest()
    await seed(t)
    const response = await post(t, "/voice/getFeasibleActions", { date: DATE })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/studentId/)
  })

  test("a malformed studentId is a clean 400, not an opaque 500", async () => {
    const t = setupTest()
    await seed(t)
    const response = await post(t, "/voice/getFeasibleActions", {
      studentId: "not-an-id",
      date: DATE,
    })
    expect(response.status).toBe(400)
  })

  test("logUsage requires the fields that make a usage row meaningful", async () => {
    const t = setupTest()
    const response = await post(t, "/voice/logUsage", { model: "m" })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/promptTokens/)
  })

  test("resolveStudent requires at least one identifier", async () => {
    const t = setupTest()
    const response = await post(t, "/voice/resolveStudent", {})
    expect(response.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe("getFeasibleActions", () => {
  test("returns the plan for the day", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    await t.run(async (ctx) =>
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

    const response = await post(t, "/voice/getFeasibleActions", {
      studentId: seeded.studentId,
      date: DATE,
      now: at(DATE, 6 * 60),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      plan: { date: string; options: { title: string }[]; timezone: string }
    }
    expect(body.ok).toBe(true)
    expect(body.plan.date).toBe(DATE)
    expect(body.plan.timezone).toBe(TZ)
    expect(body.plan.options.map((o) => o.title)).toEqual(["Pset 3"])
  })
})

describe("proposeChange", () => {
  test("holds a chat change pending and reports its tier", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const response = await post(t, "/voice/proposeChange", {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "Midterm", kind: "exam" },
      },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      status: string
      tier: string
      changeId: string
    }
    expect(body).toMatchObject({
      ok: true,
      status: "pending",
      tier: "needs_approval",
    })

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(0)
  })

  test("an inline confirmation applies through the route", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    // The cited confirming message is in the inbound log (as the Photon
    // channel's recordInbound call would have put it).
    await t.run(async (ctx) => {
      await ctx.db.insert("inboundMessages", {
        studentId: seeded.studentId,
        phone: "+15551234567",
        messageId: "msg_123",
        dedupeKey: "photon:msg_123",
        text: "yeah friday works",
        receivedAt: Date.now(),
      })
    })

    const response = await post(t, "/voice/proposeChange", {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "Midterm", kind: "exam" },
        confirmedInline: true,
        evidence: { quotedReply: "yeah friday works", inboundMessageId: "msg_123" },
      },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { status: string }
    expect(body.status).toBe("approved")

    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(1)

    // The evidence rides on the change row for the Dashboard feed.
    const changes = await t.run(async (ctx) => ctx.db.query("changes").take(10))
    expect(changes[0].evidence).toEqual({
      quotedReply: "yeah friday works",
      inboundMessageId: "msg_123",
    })
  })

  test("an inline confirmation WITHOUT evidence is a 400", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/proposeChange", {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "Midterm", kind: "exam" },
        confirmedInline: true,
      },
    })
    expect(response.status).toBe(400)
    // Nothing landed: no approval without the student's quoted words.
    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(0)
  })

  test("a change that is not an object is a 400", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/proposeChange", {
      studentId: seeded.studentId,
      change: "deadline moved",
    })
    expect(response.status).toBe(400)
  })

  test("an invalid change kind is a 400 from the validator, and writes nothing", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/proposeChange", {
      studentId: seeded.studentId,
      change: { kind: "deadline_teleported", entity: { table: "deadlines" } },
    })
    expect(response.status).toBe(400)
    const changes = await t.run(async (ctx) => ctx.db.query("changes").take(10))
    expect(changes).toHaveLength(0)
  })

  test("a fabricated inboundMessageId is a 400 through the route", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/proposeChange", {
      studentId: seeded.studentId,
      change: {
        courseId: seeded.courseId,
        kind: "deadline_added",
        entity: { table: "deadlines" },
        after: { title: "Midterm", kind: "exam" },
        confirmedInline: true,
        evidence: { quotedReply: "yeah", inboundMessageId: "msg_fabricated" },
      },
    })
    expect(response.status).toBe(400)
    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toHaveLength(0)
  })
})

describe("recordInbound", () => {
  test("logs, counts toward warmed, and dedupes a redelivery", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const first = await post(t, "/voice/recordInbound", {
      phone: "+15551234567",
      messageId: "msg_a",
      text: "hey",
    })
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      duplicate: false,
      studentId: seeded.studentId,
      warmed: false,
    })

    // Photon redelivery of the same message: dropped, not double-counted.
    const replay = await post(t, "/voice/recordInbound", {
      phone: "+15551234567",
      messageId: "msg_a",
      text: "hey",
    })
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      duplicate: true,
    })

    await post(t, "/voice/recordInbound", { phone: "+15551234567", messageId: "msg_b" })
    const third = await post(t, "/voice/recordInbound", {
      phone: "+15551234567",
      messageId: "msg_c",
    })
    // Third distinct inbound message: the contact is warmed.
    await expect(third.json()).resolves.toMatchObject({ ok: true, warmed: true })

    const student = await t.run(async (ctx) => ctx.db.get("students", seeded.studentId))
    expect(student?.inboundCount).toBe(3)
  })

  test("an unknown number is still logged (for dedupe), with no student", async () => {
    const t = setupTest()
    await seed(t)
    const response = await post(t, "/voice/recordInbound", {
      phone: "+15550000000",
      messageId: "msg_x",
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { studentId?: string; duplicate: boolean }
    expect(body.duplicate).toBe(false)
    expect(body.studentId).toBeUndefined()
  })

  test("a missing phone or messageId is a 400", async () => {
    const t = setupTest()
    const noPhone = await post(t, "/voice/recordInbound", { messageId: "msg_y" })
    expect(noPhone.status).toBe(400)
    const noId = await post(t, "/voice/recordInbound", { phone: "+15551234567" })
    expect(noId.status).toBe(400)
  })
})

describe("recordSignal", () => {
  test("writes the signal and returns its id", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const response = await post(t, "/voice/recordSignal", {
      studentId: seeded.studentId,
      signal: {
        kind: "pacing",
        text: "said 2h, took 4h on CS pset 3",
        refs: { courseId: seeded.courseId },
        sessionId: "wrun_A",
      },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: boolean; signalId: string }
    expect(body.ok).toBe(true)

    const signal = await t.run(async (ctx) =>
      ctx.db.get("studentSignals", body.signalId as Id<"studentSignals">)
    )
    expect(signal?.text).toBe("said 2h, took 4h on CS pset 3")
    expect(signal?.provenance.sourceRef).toBe("wrun_A")
  })

  test("an empty signal text is a 400 — a caller mistake, not a server fault", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/recordSignal", {
      studentId: seeded.studentId,
      signal: { kind: "other", text: "  " },
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    // The coded prefix is consumed by the mapper, not echoed at the caller.
    expect(body.error).toBe("signal text must not be empty")
    const signals = await t.run(async (ctx) => ctx.db.query("studentSignals").take(10))
    expect(signals).toHaveLength(0)
  })
})

describe("error mapping", () => {
  test("a coded error becomes its status, with the prefix stripped", async () => {
    const t = setupTest()
    await seed(t)
    // Two students share one number: `resolveStudent` throws `409: ...`.
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

    const response = await post(t, "/voice/resolveStudent", { phone: "+15551234567" })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe("more than one student has that phone number")
  })

  test("an unrecognised error is a 500 that says nothing about the inside", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    // A student row whose timezone the planner cannot read: an internal fault
    // with no coded prefix, exactly the class of error that must not leak.
    await t.run(async (ctx) =>
      ctx.db.patch("students", seeded.studentId, { timezone: "Mars/Olympus_Mons" })
    )

    const response = await post(t, "/voice/getFeasibleActions", {
      studentId: seeded.studentId,
      date: DATE,
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "internal error",
    })
    // Logged where it is useful, rather than returned where it is not.
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe("logUsage", () => {
  test("records an LLM call", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const response = await post(t, "/voice/logUsage", {
      studentId: seeded.studentId,
      model: "anthropic/claude-opus-4-7",
      promptTokens: 1200,
      completionTokens: 180,
      costUsd: 0.0234,
      sessionId: "wrun_A",
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { usageId: string }
    const usage = await t.run(async (ctx) =>
      ctx.db.get("usage", body.usageId as Id<"usage">)
    )
    expect(usage).toMatchObject({
      surface: "voice",
      model: "anthropic/claude-opus-4-7",
      promptTokens: 1200,
    })
  })

  test("a replay with the same idempotencyKey returns the existing row, not a second", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const row = {
      studentId: seeded.studentId,
      model: "anthropic/claude-sonnet-5",
      promptTokens: 14236,
      completionTokens: 79,
      sessionId: "wrun_A",
      idempotencyKey: "wrun_A:turn_0:0",
    }

    const first = (await (await post(t, "/voice/logUsage", row)).json()) as { usageId: string }
    // The hook's retry: same key, same step, response to the first POST lost.
    const second = (await (await post(t, "/voice/logUsage", row)).json()) as { usageId: string }

    expect(second.usageId).toBe(first.usageId)
    const rows = await t.run(async (ctx) => ctx.db.query("usage").take(10))
    expect(rows).toHaveLength(1)

    // A different step is a different call, and a new row.
    await post(t, "/voice/logUsage", { ...row, idempotencyKey: "wrun_A:turn_0:1" })
    expect(await t.run(async (ctx) => ctx.db.query("usage").take(10))).toHaveLength(2)
  })

  test("works without a studentId, so a pre-resolution call is still costed", async () => {
    const t = setupTest()
    const response = await post(t, "/voice/logUsage", {
      model: "classifier",
      promptTokens: 40,
      completionTokens: 5,
    })
    expect(response.status).toBe(200)
  })
})

describe("resolveStudent", () => {
  test("maps a phone number to a student and timezone", async () => {
    const t = setupTest()
    const seeded = await seed(t)

    const response = await post(t, "/voice/resolveStudent", {
      phone: "(555) 123-4567",
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      studentId: seeded.studentId,
      timezone: TZ,
      status: "active",
    })
  })

  test("maps a Clerk id to the same student", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const response = await post(t, "/voice/resolveStudent", { clerkId: CLERK_ID })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { studentId: string }
    expect(body.studentId).toBe(seeded.studentId)
  })

  test("an unknown number is a 404, never someone else's student", async () => {
    const t = setupTest()
    await seed(t)
    const response = await post(t, "/voice/resolveStudent", { phone: "+15559999999" })
    expect(response.status).toBe(404)
  })
})

describe("routing", () => {
  test("an unrouted path is not served", async () => {
    const t = setupTest()
    const response = await post(t, "/voice/deleteEverything", {})
    expect(response.status).toBe(404)
  })

  test("GET is not accepted on a POST route", async () => {
    const t = setupTest()
    const response = await t.fetch("/voice/resolveStudent", {
      method: "GET",
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(response.status).toBe(404)
  })
})
