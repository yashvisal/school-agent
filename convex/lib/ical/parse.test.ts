import { describe, expect, test } from "vitest"

import { canvasFeedIcs, genericIcs } from "../../../fixtures/ical"
import {
  normalizeIcal,
  parseIcalDate,
  parseIcs,
  parsePropertyLine,
  splitSummary,
  unfoldLines,
} from "./parse"

describe("unfolding", () => {
  test("joins continuation lines, stripping exactly one whitespace octet", () => {
    const folded = "DESCRIPTION:one\r\n two\r\n\tthree\r\nSUMMARY:x"
    expect(unfoldLines(folded)).toEqual(["DESCRIPTION:onetwothree", "SUMMARY:x"])
  })

  test("LF-only files unfold the same way as CRLF", () => {
    expect(unfoldLines("A:1\n B\nC:2")).toEqual(["A:1B", "C:2"])
  })
})

describe("property lines", () => {
  test("splits params from the value at the first unquoted colon", () => {
    const property = parsePropertyLine("DTSTART;TZID=America/New_York:20260908T101500")
    expect(property).toEqual({
      name: "DTSTART",
      params: { TZID: "America/New_York" },
      value: "20260908T101500",
    })
  })

  test("a colon inside the value is not a separator", () => {
    expect(parsePropertyLine("URL:https://x.example/a:b")?.value).toBe(
      "https://x.example/a:b"
    )
  })

  test("a quoted param may contain a colon", () => {
    const property = parsePropertyLine('X-THING;ALT="a:b";Y=2:value')
    expect(property?.params).toEqual({ ALT: "a:b", Y: "2" })
    expect(property?.value).toBe("value")
  })
})

describe("dates", () => {
  test("UTC DATE-TIME", () => {
    expect(parseIcalDate("20260915T035900Z")).toEqual({
      ms: Date.UTC(2026, 8, 15, 3, 59, 0),
      isDate: false,
    })
  })

  test("VALUE=DATE is a whole day at UTC midnight", () => {
    expect(parseIcalDate("20261102", { VALUE: "DATE" })).toEqual({
      ms: Date.UTC(2026, 10, 2),
      isDate: true,
    })
  })

  test("a bare date with no time is treated as VALUE=DATE", () => {
    expect(parseIcalDate("20261102")?.isDate).toBe(true)
  })

  test("TZID converts wall clock to the right instant, including DST", () => {
    // 2026-09-08 is EDT (UTC-4).
    expect(parseIcalDate("20260908T101500", { TZID: "America/New_York" })?.ms).toBe(
      Date.UTC(2026, 8, 8, 14, 15, 0)
    )
    // 2026-12-08 is EST (UTC-5).
    expect(parseIcalDate("20261208T101500", { TZID: "America/New_York" })?.ms).toBe(
      Date.UTC(2026, 11, 8, 15, 15, 0)
    )
  })

  test("an unresolvable TZID degrades to the floating reading, not a throw", () => {
    expect(parseIcalDate("20260908T101500", { TZID: "Mars/Olympus" })?.ms).toBe(
      Date.UTC(2026, 8, 8, 10, 15, 0)
    )
  })

  test("garbage is undefined, not NaN", () => {
    expect(parseIcalDate("tomorrow")).toBeUndefined()
    expect(parseIcalDate("")).toBeUndefined()
  })
})

describe("summary", () => {
  test("strips the Canvas course-code suffix", () => {
    expect(splitSummary("Assignment 1: Sorting [CS201]")).toEqual({
      title: "Assignment 1: Sorting",
      courseCode: "CS201",
    })
  })

  test("leaves a summary with no suffix alone", () => {
    expect(splitSummary("Scholarship application deadline")).toEqual({
      title: "Scholarship application deadline",
    })
  })
})

describe("the Canvas feed fixture", () => {
  const events = parseIcs(canvasFeedIcs)

  test("parses every VEVENT", () => {
    expect(events).toHaveLength(6)
    expect(events.map((e) => e.uid)).toContain("event-assignment-5101")
  })

  test("a folded DESCRIPTION is reassembled and unescaped", () => {
    const event = events.find((e) => e.uid === "event-assignment-5101")
    expect(event?.description).toContain("benchmark writeup; late work is accepted")
    expect(event?.description).not.toContain("\\;")
  })

  const { deadlines, classEvents } = normalizeIcal(canvasFeedIcs, "https://feed.example")

  test("assignment UIDs become deadlines carrying the Canvas assignment id", () => {
    expect(deadlines).toHaveLength(4)
    const first = deadlines.find((d) => d.externalIds.icalUid === "event-assignment-5101")
    expect(first?.externalIds.canvasAssignmentId).toBe("5101")
    expect(first?.title).toBe("Assignment 1: Sorting")
    expect(first?.courseCode).toBe("CS201")
    expect(first?.dueAt).toBe(Date.UTC(2026, 8, 15, 3, 59))
    expect(first?.provenance.source).toBe("ical")
  })

  test("an explicit exam in the title is an exam, everything else is other", () => {
    const kinds = new Map(deadlines.map((d) => [d.externalIds.canvasAssignmentId, d.kind]))
    expect(kinds.get("5107")).toBe("exam")
    expect(kinds.get("5006")).toBe("exam")
    expect(kinds.get("5101")).toBe("other")
  })

  test("calendar events are class meetings, not deadlines", () => {
    expect(classEvents).toHaveLength(2)
    expect(deadlines.some((d) => d.externalIds.icalUid?.includes("calendar-event"))).toBe(
      false
    )
    const lecture = classEvents.find((e) => e.externalIds.icalUid === "event-calendar-event-9001")
    expect(lecture?.startAt).toBe(Date.UTC(2026, 8, 8, 14, 15))
    expect(lecture?.endAt).toBe(Date.UTC(2026, 8, 8, 15, 30))
    expect(lecture?.location).toBe("Biological Sciences 111")
    expect(lecture?.allDay).toBe(false)
  })
})

describe("a non-Canvas feed", () => {
  const { deadlines, classEvents } = normalizeIcal(genericIcs, "https://planner.example")

  test("every item is a deadline with an iCal UID and no Canvas id", () => {
    expect(classEvents).toHaveLength(0)
    expect(deadlines).toHaveLength(4)
    for (const deadline of deadlines) {
      expect(deadline.externalIds.icalUid).toBeTruthy()
      expect(deadline.externalIds.canvasAssignmentId).toBeUndefined()
    }
  })

  test("all-day and zoned events both land on the right instant", () => {
    const outline = deadlines.find((d) => d.title === "Term paper outline")
    expect(outline?.dueAt).toBe(Date.UTC(2026, 10, 2))
    expect(outline?.courseCode).toBe("STA210")

    const meet = deadlines.find((d) => d.title === "Stats study group")
    expect(meet?.dueAt).toBe(Date.UTC(2026, 10, 4, 0, 0)) // 19:00 EST -> 00:00Z next day
  })
})
