import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { CLERK_ID, OTHER_CLERK_ID, setupTest } from "./test.setup"

/**
 * Settings — the student editing their own row (vision §7, core.md "State
 * model").
 *
 * Two failures this suite exists to prevent. First, a Settings form that
 * bypasses the change feed: every field here moves through `changes` with
 * origin `manual`, proposed and approved in the same mutation, so the student
 * can see in one place that they, not a source, moved their own semester.
 * Second, a phone that nothing can reach — an unnormalized number breaks the
 * `by_phone` lookup Voice resolves inbound messages through, a shared number
 * makes two students unreachable, and an unregistered number cannot be texted
 * by a Photon shared line at all.
 */

const TZ = "America/New_York"
const PHONE = "+15551230000"
const VOICE_URL = "https://voice.example.com"

const WEEKDAYS = {
  weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    dayOfWeek,
    startMin: 9 * 60,
    endMin: 21 * 60,
  })),
  exceptions: [],
}

async function seed(
  t: ReturnType<typeof setupTest>,
  overrides: Record<string, unknown> = {}
): Promise<Id<"students">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("students", {
      clerkId: CLERK_ID,
      timezone: TZ,
      classBlocks: [],
      availability: { weekly: [], exceptions: [] },
      status: "active",
      ...overrides,
    })
  )
}

const changesFor = (t: ReturnType<typeof setupTest>, studentId: Id<"students">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("changes")
      .withIndex("by_student_status", (q) => q.eq("studentId", studentId))
      .collect()
  )

const load = (t: ReturnType<typeof setupTest>, studentId: Id<"students">) =>
  t.run(async (ctx) => ctx.db.get("students", studentId))

/**
 * Saving a phone SCHEDULES the Photon registration, so every test in this file
 * runs with `fetch` and the Voice env stubbed — a stray scheduled action must
 * never reach the network — and any test that moves a phone drains the
 * scheduler itself rather than leaving work for the next one.
 */
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: "registered", userId: "usr_A" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  )
  vi.stubGlobal("fetch", fetchMock)
  vi.stubEnv("EVE_VOICE_URL", VOICE_URL)
  vi.stubEnv("VOICE_TRIGGER_SECRET", "trigger-secret")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

/** `updatePrefs` schedules the registration; a test must drain it to see it. */
const drain = async (t: ReturnType<typeof setupTest>) => {
  vi.useFakeTimers()
  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  } finally {
    vi.useRealTimers()
  }
}

describe("updatePrefs", () => {
  test("a signed-out caller cannot touch anyone's settings", async () => {
    const t = setupTest()
    await seed(t)
    await expect(t.mutation(api.students.updatePrefs, { timezone: TZ })).rejects.toThrow(
      "401"
    )
  })

  test("a signed-in student with no row is told to provision first", async () => {
    const t = setupTest()
    const as = t.withIdentity({ subject: CLERK_ID })
    await expect(as.mutation(api.students.updatePrefs, { timezone: TZ })).rejects.toThrow(
      "404"
    )
  })

  test("writes the fields and exactly one approved change carrying the diff", async () => {
    const t = setupTest()
    const studentId = await seed(t, { semesterStart: "2026-08-24" })
    const as = t.withIdentity({ subject: CLERK_ID })

    const result = await as.mutation(api.students.updatePrefs, {
      morningHourLocal: 7,
      availability: WEEKDAYS,
      checkInPreference: "fewer",
      semesterStart: "2026-08-25",
      semesterEnd: "2026-12-11",
    })

    expect(result.studentId).toBe(studentId)
    expect(result.changed).toEqual([
      "morningHourLocal",
      "availability",
      "checkInPreference",
      "semesterStart",
      "semesterEnd",
    ])

    const student = await load(t, studentId)
    expect(student?.morningHourLocal).toBe(7)
    expect(student?.checkInPreference).toBe("fewer")
    expect(student?.semesterStart).toBe("2026-08-25")
    expect(student?.semesterEnd).toBe("2026-12-11")
    expect(student?.availability.weekly).toHaveLength(5)

    const changes = await changesFor(t, studentId)
    expect(changes).toHaveLength(1)
    const [change] = changes
    expect(change.status).toBe("approved")
    expect(change.origin).toBe("manual")
    expect(change.resolvedVia).toBe("web")
    expect(change.entity).toEqual({ table: "students", id: studentId })
    // Only the fields that moved, and `before` omits what was never set.
    expect(change.before).toEqual({
      availability: { weekly: [], exceptions: [] },
      semesterStart: "2026-08-24",
    })
    expect(change.after).toEqual({
      morningHourLocal: 7,
      availability: WEEKDAYS,
      checkInPreference: "fewer",
      semesterStart: "2026-08-25",
      semesterEnd: "2026-12-11",
    })
  })

  test("a schedule-only edit is availability_updated; identity fields make it other", async () => {
    const t = setupTest()
    const studentId = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    await as.mutation(api.students.updatePrefs, { availability: WEEKDAYS })
    await as.mutation(api.students.updatePrefs, { timezone: "America/Chicago" })

    const kinds = (await changesFor(t, studentId)).map((change) => change.kind)
    expect(kinds).toEqual(["availability_updated", "other"])
  })

  test("re-submitting the same values changes nothing and writes no change", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      timezone: TZ,
      availability: WEEKDAYS,
      morningHourLocal: 7,
      phone: PHONE,
    })
    const as = t.withIdentity({ subject: CLERK_ID })

    const result = await as.mutation(api.students.updatePrefs, {
      timezone: TZ,
      availability: WEEKDAYS,
      morningHourLocal: 7,
      phone: "(555) 123-0000",
    })

    expect(result.changed).toEqual([])
    expect(await changesFor(t, studentId)).toHaveLength(0)
  })

  test("a phone is normalized before it is stored or compared", async () => {
    const t = setupTest()
    const studentId = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    const result = await as.mutation(api.students.updatePrefs, {
      phone: "(555) 123-0000",
    })

    expect(result.changed).toEqual(["phone"])
    expect((await load(t, studentId))?.phone).toBe(PHONE)
    const [change] = await changesFor(t, studentId)
    expect(change.after).toEqual({ phone: PHONE })
    await drain(t)
  })

  test("a number with no usable digits is refused", async () => {
    const t = setupTest()
    await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })
    await expect(
      as.mutation(api.students.updatePrefs, { phone: "call me maybe" })
    ).rejects.toThrow("400")
  })

  test("a number another student already holds is a 409", async () => {
    const t = setupTest()
    const studentId = await seed(t)
    await t.run(async (ctx) =>
      ctx.db.insert("students", {
        clerkId: OTHER_CLERK_ID,
        timezone: TZ,
        phone: PHONE,
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
    )
    const as = t.withIdentity({ subject: CLERK_ID })

    await expect(
      as.mutation(api.students.updatePrefs, { phone: "555-123-0000" })
    ).rejects.toThrow("409: phone already in use")
    expect((await load(t, studentId))?.phone).toBeUndefined()
  })

  test("keeping your own number is not a collision with yourself", async () => {
    const t = setupTest()
    await seed(t, { phone: PHONE })
    const as = t.withIdentity({ subject: CLERK_ID })
    await expect(
      as.mutation(api.students.updatePrefs, { phone: PHONE, morningHourLocal: 8 })
    ).resolves.toMatchObject({ changed: ["morningHourLocal"] })
  })

  test("an unusable timezone is refused before anything is written", async () => {
    const t = setupTest()
    const studentId = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    await expect(
      as.mutation(api.students.updatePrefs, {
        timezone: "Mars/Olympus_Mons",
        morningHourLocal: 9,
      })
    ).rejects.toThrow("400")

    const student = await load(t, studentId)
    expect(student?.timezone).toBe(TZ)
    expect(student?.morningHourLocal).toBeUndefined()
    expect(await changesFor(t, studentId)).toHaveLength(0)
  })

  test("the morning hour must be a whole hour of the day", async () => {
    const t = setupTest()
    await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })
    for (const morningHourLocal of [-1, 24, 7.5]) {
      await expect(
        as.mutation(api.students.updatePrefs, { morningHourLocal })
      ).rejects.toThrow("400")
    }
  })

  test("semester dates must be real calendar days", async () => {
    const t = setupTest()
    await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })
    await expect(
      as.mutation(api.students.updatePrefs, { semesterEnd: "2026-02-30" })
    ).rejects.toThrow("400")
    await expect(
      as.mutation(api.students.updatePrefs, { semesterStart: "next tuesday" })
    ).rejects.toThrow("400")
  })

  /**
   * The planner subtracts these blocks from the day, so a block its arithmetic
   * cannot read is not cosmetic: a negative window, a day number that matches
   * nothing, or a fractional minute all poison the feasible set silently.
   */
  describe("availability blocks are checked before they are stored", () => {
    const block = (overrides: Record<string, number>) => ({
      dayOfWeek: 1,
      startMin: 9 * 60,
      endMin: 17 * 60,
      ...overrides,
    })

    const bad: [string, unknown][] = [
      ["a day outside the week", { weekly: [block({ dayOfWeek: 7 })], exceptions: [] }],
      ["a fractional day", { weekly: [block({ dayOfWeek: 1.5 })], exceptions: [] }],
      ["a negative start", { weekly: [block({ startMin: -30 })], exceptions: [] }],
      ["an end past midnight", { weekly: [block({ endMin: 1441 })], exceptions: [] }],
      ["a fractional minute", { weekly: [block({ startMin: 90.5 })], exceptions: [] }],
      [
        "a block that ends before it starts",
        { weekly: [block({ startMin: 17 * 60, endMin: 9 * 60 })], exceptions: [] },
      ],
      [
        "a zero-length block",
        { weekly: [block({ startMin: 600, endMin: 600 })], exceptions: [] },
      ],
      [
        "an exception on a day that does not exist",
        { weekly: [], exceptions: [{ date: "2026-02-30", blocks: [] }] },
      ],
      [
        "an exception carrying a bad block",
        { weekly: [], exceptions: [{ date: "2026-09-15", blocks: [block({ endMin: 0 })] }] },
      ],
    ]

    for (const [what, availability] of bad) {
      test(what, async () => {
        const t = setupTest()
        const studentId = await seed(t)
        await expect(
          t.withIdentity({ subject: CLERK_ID }).mutation(api.students.updatePrefs, {
            availability: availability as typeof WEEKDAYS,
          })
        ).rejects.toThrow("400")
        expect((await load(t, studentId))?.availability.weekly).toHaveLength(0)
        expect(await changesFor(t, studentId)).toHaveLength(0)
      })
    }

    test("a block that runs to midnight is fine", async () => {
      const t = setupTest()
      await seed(t)
      await expect(
        t.withIdentity({ subject: CLERK_ID }).mutation(api.students.updatePrefs, {
          availability: {
            weekly: [block({ dayOfWeek: 0, startMin: 0, endMin: 1440 })],
            exceptions: [{ date: "2026-09-15", blocks: [] }],
          },
        })
      ).resolves.toMatchObject({ changed: ["availability"] })
    })

    test("the message names the block that is wrong", async () => {
      const t = setupTest()
      await seed(t)
      await expect(
        t.withIdentity({ subject: CLERK_ID }).mutation(api.students.updatePrefs, {
          availability: { weekly: [block({}), block({ dayOfWeek: 9 })], exceptions: [] },
        })
      ).rejects.toThrow("availability.weekly[1].dayOfWeek")
    })
  })

  test("a stranger's settings are unreachable — identity picks the row", async () => {
    const t = setupTest()
    const mine = await seed(t)
    const theirs = await t.run(async (ctx) =>
      ctx.db.insert("students", {
        clerkId: OTHER_CLERK_ID,
        timezone: TZ,
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
    )

    await t
      .withIdentity({ subject: OTHER_CLERK_ID })
      .mutation(api.students.updatePrefs, { morningHourLocal: 6 })

    expect((await load(t, theirs))?.morningHourLocal).toBe(6)
    expect((await load(t, mine))?.morningHourLocal).toBeUndefined()
  })
})

describe("registerContact", () => {
  test("POSTs the contact route and records the registration", async () => {
    const t = setupTest()
    const studentId = await seed(t, { phone: PHONE })

    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: PHONE,
    })

    expect(outcome.status).toBe("registered")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${VOICE_URL}/eve/agents/voice/eve/v1/contact`)
    expect(init.headers["x-voice-trigger-secret"]).toBe("trigger-secret")
    expect(JSON.parse(init.body)).toEqual({ phone: PHONE })

    const student = await load(t, studentId)
    expect(student?.photonRegistration?.status).toBe("registered")
    expect(student?.photonRegistration?.at).toBeGreaterThan(0)
    expect(student?.photonRegistration?.error).toBeUndefined()
  })

  test("a non-2xx from Voice is a recorded failure, not a thrown one", async () => {
    const t = setupTest()
    const studentId = await seed(t, { phone: PHONE })
    fetchMock.mockResolvedValue(new Response("photon down", { status: 502 }))

    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: PHONE,
    })

    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("502")
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("failed")
  })

  test("a transport error is a recorded failure", async () => {
    const t = setupTest()
    const studentId = await seed(t, { phone: PHONE })
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))

    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: PHONE,
    })

    expect(outcome).toMatchObject({ status: "failed", error: "ECONNREFUSED" })
  })

  test("no Voice attached to this deployment is skipped, not failed", async () => {
    const t = setupTest()
    const studentId = await seed(t, { phone: PHONE })
    vi.stubEnv("EVE_VOICE_URL", "")

    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: PHONE,
    })

    expect(outcome).toMatchObject({ status: "skipped", error: "EVE_VOICE_URL not set" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("skipped")
  })

  test("a missing secret never POSTs a number unauthenticated", async () => {
    const t = setupTest()
    const studentId = await seed(t, { phone: PHONE })
    vi.stubEnv("VOICE_TRIGGER_SECRET", "")

    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: PHONE,
    })

    expect(outcome).toMatchObject({
      status: "skipped",
      error: "VOICE_TRIGGER_SECRET not set",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("an outcome for a number the student no longer has is dropped", async () => {
    const t = setupTest()
    const OLD = "+15559990000"
    const studentId = await seed(t, { phone: PHONE })

    // The registration for the previous number lands after the student has
    // already saved a new one: it must not label the new number.
    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: OLD,
    })

    expect(outcome.status).toBe("registered")
    expect((await load(t, studentId))?.photonRegistration).toBeUndefined()
  })

  test("changing the phone clears the old number's registration", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      phone: "+15559990000",
      photonRegistration: { status: "registered", at: 1 },
    })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })

    // Cleared the moment the number moves — before the new registration lands,
    // Settings must not claim we can text a number nobody registered.
    expect((await load(t, studentId))?.photonRegistration).toBeUndefined()
    await drain(t)
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("registered")
  })

  test("re-saving the same number retries a registration that did not land", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      phone: PHONE,
      photonRegistration: { status: "failed", at: 1, error: "eve was down" },
    })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })
    await drain(t)

    // Nothing about the student changed, so no change row — but the retry ran.
    expect(result.changed).toEqual([])
    expect(await changesFor(t, studentId)).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("registered")
  })

  test("re-saving a number that is already registered does not POST again", async () => {
    const t = setupTest()
    await seed(t, {
      phone: PHONE,
      photonRegistration: { status: "registered", at: 1 },
    })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })
    await drain(t)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("saving a phone in Settings schedules the registration", async () => {
    const t = setupTest()
    const studentId = await seed(t)

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })
    await drain(t)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("registered")
  })

  test("an edit that does not touch the phone schedules nothing", async () => {
    const t = setupTest()
    await seed(t, { phone: PHONE })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { morningHourLocal: 6 })
    await drain(t)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
