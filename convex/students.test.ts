import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { REGISTRATION_RETRY_MS } from "./students"
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
    // The unchanged number still has no registration on file, so the re-save
    // schedules one — drained here rather than left for a later test.
    await drain(t)
  })

  test("the same week described differently is not a change", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      availability: {
        weekly: [
          { dayOfWeek: 1, startMin: 540, endMin: 1260 },
          { dayOfWeek: 3, startMin: 600, endMin: 720, label: "gym" },
        ],
        exceptions: [
          { date: "2026-09-15", blocks: [{ dayOfWeek: 2, startMin: 0, endMin: 60 }] },
          { date: "2026-09-14", blocks: [] },
        ],
      },
    })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, {
        availability: {
          // Same week: blocks reordered, keys written in another order, and the
          // exceptions listed the other way round.
          weekly: [
            { endMin: 720, label: "gym", startMin: 600, dayOfWeek: 3 },
            { endMin: 1260, startMin: 540, dayOfWeek: 1 },
          ],
          exceptions: [
            { date: "2026-09-14", blocks: [] },
            { blocks: [{ startMin: 0, endMin: 60, dayOfWeek: 2 }], date: "2026-09-15" },
          ],
        },
      })

    expect(result.changed).toEqual([])
    expect(await changesFor(t, studentId)).toHaveLength(0)
  })

  test("a real difference in the grid is still a change", async () => {
    const t = setupTest()
    const studentId = await seed(t, { availability: WEEKDAYS })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, {
        availability: {
          weekly: [...WEEKDAYS.weekly.slice(1)],
          exceptions: [],
        },
      })

    expect(result.changed).toEqual(["availability"])
    expect(await changesFor(t, studentId)).toHaveLength(1)
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
    await drain(t)
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

  test("a bare UTC offset is not a timezone", async () => {
    const t = setupTest()
    const studentId = await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })

    // Intl accepts all of these, but none of them knows when the student's
    // clocks change, so the morning push would drift twice a year.
    for (const timezone of ["+05:30", "-0800", "+00", "-05:00"]) {
      await expect(
        as.mutation(api.students.updatePrefs, { timezone })
      ).rejects.toThrow("400: timezone must be an IANA zone")
    }
    expect((await load(t, studentId))?.timezone).toBe(TZ)
  })

  test("real zone names are accepted, including the Etc ones", async () => {
    const t = setupTest()
    await seed(t)
    const as = t.withIdentity({ subject: CLERK_ID })
    for (const timezone of ["America/Chicago", "Europe/Berlin", "Etc/GMT+5", "UTC"]) {
      await expect(
        as.mutation(api.students.updatePrefs, { timezone })
      ).resolves.toMatchObject({ changed: ["timezone"] })
    }
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

    // Replaced the moment the number moves — before the new registration lands,
    // Settings must not claim we can text a number nobody registered.
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("pending")
    await drain(t)
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("registered")
  })

  test("a second save will not start a second registration while one is in flight", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      phone: PHONE,
      photonRegistration: { status: "pending", at: Date.now() },
    })
    const as = t.withIdentity({ subject: CLERK_ID })

    // An impatient student pressing "try again": Photon's budget is 5 rps for
    // the whole project, so one number must not be able to spend it.
    const result = await as.mutation(api.students.updatePrefs, { phone: PHONE })
    await drain(t)

    expect(result.changed).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("pending")
  })

  test("a pending attempt older than the retry window is retried", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      phone: PHONE,
      photonRegistration: { status: "pending", at: Date.now() - REGISTRATION_RETRY_MS - 1 },
    })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })
    await drain(t)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("registered")
  })

  test("a new number never waits behind someone else's in-flight attempt", async () => {
    const t = setupTest()
    const studentId = await seed(t, {
      phone: "+15559990000",
      photonRegistration: { status: "pending", at: Date.now() },
    })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })
    await drain(t)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phone: PHONE })
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("registered")
  })

  test("a delayed first attempt cannot overwrite the newer attempt a re-save started", async () => {
    const t = setupTest()
    const first = Date.now() - REGISTRATION_RETRY_MS - 1
    // The first attempt was scheduled at `first` and has not run yet; the
    // student re-saved after the retry window, so the row now carries a NEWER
    // pending attempt. The late first run must not stamp its verdict on it.
    const studentId = await seed(t, {
      phone: PHONE,
      photonRegistration: { status: "pending", at: first + REGISTRATION_RETRY_MS + 1 },
    })

    const outcome = await t.action(internal.students.registerContact, {
      studentId,
      phone: PHONE,
      attemptAt: first,
    })

    expect(outcome.status).toBe("registered")
    expect((await load(t, studentId))?.photonRegistration?.status).toBe("pending")
  })

  test("a canonical availability does not collide on separator characters", async () => {
    const t = setupTest()
    // Two blocks, labelled "x" and "y". The old separator-joined canonical form
    // rendered them as `1|540|600|x|;1|540|600|y|` — which is also exactly what
    // ONE block labelled `x|;1|540|600|y` rendered as, so the two grids were
    // "equal" and the edit was suppressed. JSON escaping keeps them apart.
    const studentId = await seed(t, {
      availability: {
        weekly: [
          { dayOfWeek: 1, startMin: 540, endMin: 600, label: "x" },
          { dayOfWeek: 1, startMin: 540, endMin: 600, label: "y" },
        ],
        exceptions: [],
      },
    })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, {
        availability: {
          weekly: [{ dayOfWeek: 1, startMin: 540, endMin: 600, label: "x|;1|540|600|y" }],
          exceptions: [],
        },
      })

    expect(result.changed).toEqual(["availability"])
    expect((await load(t, studentId))?.availability.weekly).toHaveLength(1)
  })

  test("the attempt is marked pending before it is scheduled", async () => {
    const t = setupTest()
    const studentId = await seed(t)

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.students.updatePrefs, { phone: PHONE })

    // Written in the same transaction as the schedule, so a concurrent save
    // sees it and does not start a second attempt.
    const marked = await load(t, studentId)
    expect(marked?.photonRegistration?.status).toBe("pending")
    expect(marked?.photonRegistration?.at).toBeGreaterThan(0)
    await drain(t)
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

describe("ensure", () => {
  test("refuses a fixed offset or an unknown zone before writing anything", async () => {
    const t = setupTest()
    const as = t.withIdentity({ subject: CLERK_ID })

    await expect(as.mutation(api.students.ensure, { timezone: "+05:30" })).rejects.toThrow("400")
    await expect(
      as.mutation(api.students.ensure, { timezone: "Mars/Olympus_Mons" })
    ).rejects.toThrow("400")

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("students")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", CLERK_ID))
        .collect()
    )
    expect(rows).toHaveLength(0)
  })

  test("a real zone provisions the row and a later real zone updates it", async () => {
    const t = setupTest()
    const as = t.withIdentity({ subject: CLERK_ID })

    const studentId = await as.mutation(api.students.ensure, { timezone: "America/Los_Angeles" })
    expect((await load(t, studentId))?.timezone).toBe("America/Los_Angeles")

    await as.mutation(api.students.ensure, { timezone: "America/New_York" })
    expect((await load(t, studentId))?.timezone).toBe("America/New_York")
  })
})

describe("updatePrefs semester range", () => {
  test("a start after the end is refused, whichever side the row already holds", async () => {
    const t = setupTest()
    const studentId = await seed(t, { semesterEnd: "2026-12-11" })
    const as = t.withIdentity({ subject: CLERK_ID })

    // Argument start vs stored end.
    await expect(
      as.mutation(api.students.updatePrefs, { semesterStart: "2026-12-12" })
    ).rejects.toThrow("400: semesterStart")
    // Both as arguments, swapped.
    await expect(
      as.mutation(api.students.updatePrefs, {
        semesterStart: "2026-12-01",
        semesterEnd: "2026-08-24",
      })
    ).rejects.toThrow("400: semesterStart")
    expect((await load(t, studentId))?.semesterStart).toBeUndefined()

    // A same-day term is allowed; so is a well-ordered one.
    await expect(
      as.mutation(api.students.updatePrefs, { semesterStart: "2026-12-11" })
    ).resolves.toMatchObject({ changed: ["semesterStart"] })
    await expect(
      as.mutation(api.students.updatePrefs, { semesterStart: "2026-08-24" })
    ).resolves.toMatchObject({ changed: ["semesterStart"] })
  })
})
