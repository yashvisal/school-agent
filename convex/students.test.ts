import { describe, expect, test } from "vitest"

import { api } from "./_generated/api"
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
