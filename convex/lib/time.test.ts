import { describe, expect, test } from "vitest"

import {
  addDays,
  dayOfWeekOf,
  daysBetween,
  formatClock,
  formatDuration,
  formatLocalDateTime,
  localDate,
  localDateToMs,
  localMinutes,
  localParts,
  tzOffsetMs,
} from "./time"

/**
 * The whole planner is expressed in local dates and minutes-from-midnight, so a
 * timezone bug here is a wrong-day plan, not a cosmetic one. DST is the case
 * that actually breaks: 2026-11-01 is the US fall-back, 2026-03-08 the
 * spring-forward.
 */

const NY = "America/New_York"
const KOLKATA = "Asia/Kolkata" // UTC+5:30, no DST — the half-hour offset case
const AUCKLAND = "Pacific/Auckland" // UTC+13 in January — across the date line

describe("localParts", () => {
  test("reads the wall clock in the target zone, not UTC", () => {
    // 2026-09-15T03:59Z is the evening of the 14th in New York.
    const ms = Date.UTC(2026, 8, 15, 3, 59)
    const parts = localParts(ms, NY)
    expect(parts.date).toBe("2026-09-14")
    expect(parts.hour).toBe(23)
    expect(parts.minute).toBe(59)
    expect(parts.minutes).toBe(23 * 60 + 59)
    expect(parts.dayOfWeek).toBe(1) // Monday
  })

  test("midnight reads as hour 0, not 24", () => {
    const ms = localDateToMs("2026-09-14", 0, NY)
    expect(localParts(ms, NY).hour).toBe(0)
    expect(localMinutes(ms, NY)).toBe(0)
  })

  test("handles a half-hour offset east of UTC", () => {
    const ms = Date.UTC(2026, 0, 1, 20, 0)
    expect(localDate(ms, KOLKATA)).toBe("2026-01-02")
    expect(localMinutes(ms, KOLKATA)).toBe(60 + 30)
  })

  test("handles a zone west of UTC rolling back a day", () => {
    const ms = Date.UTC(2026, 0, 1, 2, 0)
    expect(localDate(ms, "America/Los_Angeles")).toBe("2025-12-31")
    expect(localMinutes(ms, "America/Los_Angeles")).toBe(18 * 60)
  })

  test("handles a zone east enough to roll forward a day", () => {
    const ms = Date.UTC(2026, 0, 1, 20, 0)
    expect(localDate(ms, AUCKLAND)).toBe("2026-01-02")
  })
})

describe("localDateToMs round-trips", () => {
  const cases: Array<[string, string, number]> = [
    [NY, "2026-09-14", 23 * 60 + 59],
    [NY, "2026-06-01", 9 * 60],
    [KOLKATA, "2026-03-15", 7 * 60 + 45],
    [AUCKLAND, "2026-01-05", 13 * 60],
    ["UTC", "2026-12-31", 0],
  ]

  for (const [tz, date, minutes] of cases) {
    test(`${tz} ${date} ${minutes}m survives the round trip`, () => {
      const ms = localDateToMs(date, minutes, tz)
      expect(localDate(ms, tz)).toBe(date)
      expect(localMinutes(ms, tz)).toBe(minutes)
    })
  }
})

describe("DST — America/New_York", () => {
  test("fall back (2026-11-01): the day is 25 hours long", () => {
    const start = localDateToMs("2026-11-01", 0, NY)
    const nextStart = localDateToMs("2026-11-02", 0, NY)
    expect(nextStart - start).toBe(25 * 3_600_000)
  })

  test("fall back: the offset shifts from -4h to -5h across 2am", () => {
    expect(tzOffsetMs(localDateToMs("2026-11-01", 60, NY), NY)).toBe(-4 * 3_600_000)
    expect(tzOffsetMs(localDateToMs("2026-11-01", 5 * 60, NY), NY)).toBe(-5 * 3_600_000)
  })

  test("fall back: an ambiguous 1:30am resolves to the first of the two instants", () => {
    const ms = localDateToMs("2026-11-01", 90, NY)
    expect(localDate(ms, NY)).toBe("2026-11-01")
    expect(localMinutes(ms, NY)).toBe(90)
    // The earlier (EDT) instant, i.e. 05:30 UTC rather than 06:30.
    expect(ms).toBe(Date.UTC(2026, 10, 1, 5, 30))
  })

  test("fall back: evening times on that day still round-trip", () => {
    const ms = localDateToMs("2026-11-01", 20 * 60, NY)
    expect(localDate(ms, NY)).toBe("2026-11-01")
    expect(localMinutes(ms, NY)).toBe(20 * 60)
  })

  test("spring forward (2026-03-08): the day is 23 hours long", () => {
    const start = localDateToMs("2026-03-08", 0, NY)
    const nextStart = localDateToMs("2026-03-09", 0, NY)
    expect(nextStart - start).toBe(23 * 3_600_000)
  })

  test("spring forward: a nonexistent 2:30am resolves forward past the gap", () => {
    const ms = localDateToMs("2026-03-08", 150, NY)
    // 2:30 never happens; the instant reads as 3:30 EDT.
    expect(localDate(ms, NY)).toBe("2026-03-08")
    expect(localMinutes(ms, NY)).toBe(210)
  })
})

describe("calendar arithmetic", () => {
  test("dayOfWeekOf is 0 = Sunday", () => {
    expect(dayOfWeekOf("2026-09-13")).toBe(0)
    expect(dayOfWeekOf("2026-09-14")).toBe(1)
    expect(dayOfWeekOf("2026-09-19")).toBe(6)
  })

  test("addDays crosses months, years, and a leap day", () => {
    expect(addDays("2026-09-14", 1)).toBe("2026-09-15")
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29")
  })

  test("addDays is unaffected by DST (it is calendar, not clock, arithmetic)", () => {
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02")
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08")
  })

  test("daysBetween counts whole days in both directions", () => {
    expect(daysBetween("2026-09-14", "2026-09-17")).toBe(3)
    expect(daysBetween("2026-09-17", "2026-09-14")).toBe(-3)
    expect(daysBetween("2026-10-28", "2026-11-04")).toBe(7) // spans fall-back
  })

  test("a malformed date is rejected rather than silently coerced", () => {
    expect(() => dayOfWeekOf("2026-9-14")).toThrow()
    expect(() => addDays("not-a-date", 1)).toThrow()
  })
})

describe("formatting", () => {
  test("formatClock", () => {
    expect(formatClock(0)).toBe("12am")
    expect(formatClock(9 * 60)).toBe("9am")
    expect(formatClock(12 * 60)).toBe("12pm")
    expect(formatClock(19 * 60)).toBe("7pm")
    expect(formatClock(23 * 60 + 59)).toBe("11:59pm")
    expect(formatClock(9 * 60 + 30)).toBe("9:30am")
  })

  test("formatDuration", () => {
    expect(formatDuration(45)).toBe("45m")
    expect(formatDuration(120)).toBe("2h")
    expect(formatDuration(150)).toBe("2h30m")
  })

  test("formatLocalDateTime reads the instant in the student's zone", () => {
    const ms = Date.UTC(2026, 8, 18, 3, 59)
    expect(formatLocalDateTime(ms, NY)).toBe("Thu Sep 17 11:59pm")
  })
})
