import { describe, expect, test } from "vitest"

import cmuExpected from "../../../fixtures/extraction/sites/cmu-15-213-schedule-fall-2026/expected.json"
import scheduleExpected from "../../../fixtures/extraction/schedules/weekly-grid-text/expected.json"
import mitExpected from "../../../fixtures/extraction/syllabi/mit-6-0001-intro-python-fall-2016/expected.json"
import stanfordExpected from "../../../fixtures/extraction/syllabi/stanford-cs103-spring-2025/expected.json"
import { localDateToMs } from "../time"
import {
  DEFAULT_DUE_MINUTES,
  describeSchedule,
  normalizeScheduleExtraction,
  normalizeSyllabusExtraction,
  normalizeWeights,
  resolveYear,
} from "./normalize"
import {
  scheduleExtractionSchema,
  syllabusExtractionSchema,
} from "./schemas"

/**
 * The deterministic half of the extraction eval (core.md "Definition of done":
 * the extraction pipelines run against hand-verified fixtures in CI).
 *
 * These run on the checked-in `expected.json` files — the same artifacts the
 * live evals score the model against — so CI proves the *normalizer* is right
 * with no gateway key, no network, and no cost. `pnpm eval` measures the model;
 * this measures everything downstream of it.
 */

const parseSyllabus = (fixture: unknown) => syllabusExtractionSchema.parse(fixture)

const LA = "America/Los_Angeles"
const NY = "America/New_York"

const SPRING_2025 = { start: "2025-03-31", end: "2025-06-11" }
const FALL_2026 = { start: "2026-08-24", end: "2026-12-11" }
const FALL_2016 = { start: "2016-09-07", end: "2016-12-14" }

describe("year resolution", () => {
  test("a month/day resolves to the one year that lands inside the term", () => {
    expect(resolveYear("04-29", SPRING_2025).date).toBe("2025-04-29")
    expect(resolveYear("12-03", FALL_2026).date).toBe("2026-12-03")
  })

  test("a month/day that fits no year in the term is refused, not guessed", () => {
    // January is neither in a spring term that starts in March nor within the
    // slack around it. Picking a year anyway is the failure this exists to stop.
    const result = resolveYear("01-15", SPRING_2025)
    expect(result.date).toBeUndefined()
    expect(result.drop).toMatch(/does not fall inside the term/)
  })

  test("with no term dates at all, a bare month/day is refused", () => {
    expect(resolveYear("04-29", undefined).drop).toMatch(/no term dates/)
    expect(resolveYear("04-29", {}).drop).toMatch(/no term dates/)
  })

  test("a malformed month/day is refused", () => {
    for (const bad of ["4-29", "2025-04-29", "13-01", "04-32", "april"]) {
      expect(resolveYear(bad, SPRING_2025).drop).toBeDefined()
    }
  })
})

describe("syllabus normalization — stanford cs103 fixture", () => {
  const normalized = normalizeSyllabusExtraction({
    extraction: parseSyllabus(stanfordExpected),
    timezone: LA,
    source: "syllabus",
    semester: SPRING_2025,
  })

  test("every stated exam resolves to the right instant in the student's zone", () => {
    const byTitle = new Map(normalized.deadlines.map((d) => [d.title, d]))
    expect(byTitle.get("Midterm 1")?.dueAt).toBe(localDateToMs("2025-04-29", 18 * 60, LA))
    expect(byTitle.get("Midterm 2")?.dueAt).toBe(localDateToMs("2025-05-20", 18 * 60, LA))
    expect(byTitle.get("Final Exam")?.dueAt).toBe(
      localDateToMs("2025-06-07", 8 * 60 + 30, LA)
    )
  })

  test("a recurrence with no stated date stays UNDATED rather than being computed", () => {
    const series = normalized.deadlines.find((d) => d.title === "Problem Sets")
    expect(series).toBeDefined()
    expect(series?.dueAt).toBeUndefined()
    // The rule the model read is still carried, verbatim, on the row.
    expect(series?.description).toContain("due the following Friday")
  })

  test("the same instant is read in the student's zone, not the server's", () => {
    // 6pm Pacific on 2025-04-29 is 01:00 UTC on the 30th. A normalizer that
    // resolved in UTC would silently move every West-Coast evening exam a day.
    const midterm = normalized.deadlines.find((d) => d.title === "Midterm 1")
    expect(new Date(midterm!.dueAt!).toISOString()).toBe("2025-04-30T01:00:00.000Z")
  })

  test("grading weights come through as percentages", () => {
    expect(normalized.course.gradingScheme?.categories).toEqual([
      { name: "Problem Sets", weight: 20 },
      { name: "Exams", weight: 75 },
      { name: "Participation", weight: 5 },
    ])
  })

  test("provenance carries the model's own confidence, never an invented one", () => {
    const exam = normalized.deadlines.find((d) => d.title === "Midterm 1")
    expect(exam?.provenance).toMatchObject({ source: "syllabus", confidence: 1 })
    const series = normalized.deadlines.find((d) => d.title === "Problem Sets")
    expect(series?.provenance.confidence).toBe(0.5)
  })
})

describe("syllabus normalization — mit 6.0001 fixture (no dates anywhere)", () => {
  const normalized = normalizeSyllabusExtraction({
    extraction: parseSyllabus(mitExpected),
    timezone: NY,
    source: "syllabus",
    semester: FALL_2016,
  })

  test("a syllabus that states no calendar date produces no dated deadline", () => {
    expect(normalized.deadlines.length).toBeGreaterThan(0)
    expect(normalized.deadlines.every((d) => d.dueAt === undefined)).toBe(true)
  })

  test("undated items are KEPT, not dropped — an undated exam is still an exam", () => {
    expect(normalized.deadlines.map((d) => d.title)).toContain("Final Quiz")
    expect(normalized.dropped).toEqual([])
  })

  test("all four grading categories survive with exact weights", () => {
    expect(normalized.course.gradingScheme?.categories).toEqual([
      { name: "Problem sets", weight: 30 },
      { name: "Completion of mandatory finger exercises", weight: 10 },
      { name: "Midterm Quiz", weight: 20 },
      { name: "Final Quiz", weight: 40 },
    ])
  })
})

describe("site normalization — cmu 15-213 fixture", () => {
  const normalized = normalizeSyllabusExtraction({
    extraction: parseSyllabus(cmuExpected),
    timezone: NY,
    source: "site",
    semester: FALL_2026,
  })

  test("every deliverable in the table resolves to a dated deadline", () => {
    expect(normalized.deadlines).toHaveLength(11)
    expect(normalized.deadlines.every((d) => d.dueAt !== undefined)).toBe(true)
    expect(normalized.dropped).toEqual([])
  })

  test("a date with no stated time defaults to the end of the day", () => {
    const l0 = normalized.deadlines.find((d) => d.title.startsWith("L0"))
    expect(l0?.dueAt).toBe(localDateToMs("2026-09-01", DEFAULT_DUE_MINUTES, NY))
  })

  test("provenance is the site, with the page ref the model gave", () => {
    expect(normalized.deadlines[0].provenance).toMatchObject({
      source: "site",
      sourceRef: "Schedule table, Sep 01 row",
    })
  })

  test("keys are unique, so two items never collide into one proposal", () => {
    const keys = normalized.deadlines.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("out-of-window and malformed dates", () => {
  const withDeadline = (extra: Record<string, unknown>) =>
    normalizeSyllabusExtraction({
      extraction: parseSyllabus({
        course: { name: "Test" },
        deadlines: [
          {
            title: "Midterm",
            kind: "exam",
            confidence: 1,
            sourceText: "Midterm: see above",
            ...extra,
          },
        ],
      }),
      timezone: NY,
      source: "syllabus",
      semester: FALL_2026,
    })

  test("a hallucinated year outside the term is dropped with a reason", () => {
    const result = withDeadline({ dueDate: "2019-10-20" })
    expect(result.deadlines).toEqual([])
    expect(result.dropped[0].reason).toMatch(/outside the term/)
  })

  test("a date just outside the term but inside the slack survives", () => {
    // A final sat a week after the last lecture is real; a year off is not.
    const result = withDeadline({ dueDate: "2026-12-16" })
    expect(result.deadlines).toHaveLength(1)
  })

  test("a non-date string never becomes an instant", () => {
    const result = withDeadline({ dueDate: "Week 3" })
    expect(result.deadlines).toEqual([])
    expect(result.dropped[0].reason).toMatch(/not a YYYY-MM-DD/)
  })

  test("a malformed TIME loses the time, not the day", () => {
    const result = withDeadline({ dueDate: "2026-10-20", dueTime: "6pm" })
    expect(result.deadlines[0].dueAt).toBe(
      localDateToMs("2026-10-20", DEFAULT_DUE_MINUTES, NY)
    )
  })

  test("an item with nothing quotable is refused — unquotable is unverifiable", () => {
    const result = normalizeSyllabusExtraction({
      extraction: parseSyllabus({
        course: { name: "Test" },
        deadlines: [
          { title: "Ghost", kind: "exam", confidence: 1, sourceText: "   " },
        ],
      }),
      timezone: NY,
      source: "syllabus",
    })
    expect(result.deadlines).toEqual([])
    expect(result.dropped[0].reason).toMatch(/sourceText/)
  })
})

describe("grading weight normalization", () => {
  test("percentages are left alone", () => {
    expect(normalizeWeights([{ name: "a", weight: 30 }, { name: "b", weight: 70 }])).toEqual([
      { name: "a", weight: 30 },
      { name: "b", weight: 70 },
    ])
  })

  test("a set of fractions summing to one is scaled to percent", () => {
    expect(
      normalizeWeights([
        { name: "a", weight: 0.2 },
        { name: "b", weight: 0.75 },
        { name: "c", weight: 0.05 },
      ])
    ).toEqual([
      { name: "a", weight: 20 },
      { name: "b", weight: 75 },
      { name: "c", weight: 5 },
    ])
  })

  test("a lone weight of 1 is 1%, not 100% — the judgement is on the SET", () => {
    expect(normalizeWeights([{ name: "a", weight: 1 }])).toEqual([{ name: "a", weight: 1 }])
  })

  test("dropLowest survives; a zero or absent one does not become noise", () => {
    expect(
      normalizeWeights([
        { name: "a", weight: 30, dropLowest: 2 },
        { name: "b", weight: 70, dropLowest: 0 },
      ])
    ).toEqual([{ name: "a", weight: 30, dropLowest: 2 }, { name: "b", weight: 70 }])
  })
})

describe("schedule normalization", () => {
  const normalized = normalizeScheduleExtraction(
    scheduleExtractionSchema.parse(scheduleExpected)
  )

  test("the weekly-grid fixture yields exactly nine blocks, sorted", () => {
    expect(normalized.blocks).toHaveLength(9)
    expect(normalized.dropped).toEqual([])
    const order = normalized.blocks.map((b) => `${b.dayOfWeek}:${b.startMin}`)
    expect(order).toEqual([...order].sort())
  })

  test("times become minutes from local midnight", () => {
    const lab = normalized.blocks.find((b) => b.label?.includes("Lab"))
    expect(lab).toMatchObject({ dayOfWeek: 4, startMin: 13 * 60 + 30, endMin: 15 * 60 + 20 })
  })

  test("Tu and Th are different days", () => {
    const sta = normalized.blocks.filter((b) => b.label?.startsWith("STA 210"))
    expect(sta.map((b) => b.dayOfWeek).sort()).toEqual([2, 4])
  })

  const bad = (block: Record<string, unknown>) =>
    normalizeScheduleExtraction(
      scheduleExtractionSchema.parse({
        blocks: [
          {
            dayOfWeek: 1,
            startTime: "10:00",
            endTime: "11:00",
            label: "Broken",
            confidence: 1,
            sourceText: "row",
            ...block,
          },
        ],
      })
    )

  test("a block ending at or before it starts is dropped, never repaired", () => {
    // A repaired hard constraint is a guess about when a class meets, and the
    // planner treats it as fact.
    expect(bad({ endTime: "10:00" }).blocks).toEqual([])
    expect(bad({ endTime: "09:00" }).dropped[0].reason).toMatch(/ends at or before/)
  })

  test("an unparseable time is dropped", () => {
    expect(bad({ startTime: "10am" }).blocks).toEqual([])
    expect(bad({ endTime: "25:00" }).blocks).toEqual([])
  })

  test("a day index outside the week is dropped", () => {
    // The zod schema already rejects 0-6 violations at the model boundary, so
    // this asserts the SECOND gate: `ingestSchedule` also accepts an extraction
    // through `v.any()` (fixtures, replays), and a `dayOfWeek: 7` reaching the
    // student's hard constraints from that path is the same defect.
    const raw = {
      blocks: [
        { dayOfWeek: 7, startTime: "10:00", endTime: "11:00", label: "Broken", confidence: 1, sourceText: "row" },
        { dayOfWeek: 1.5, startTime: "10:00", endTime: "11:00", label: "Fractional", confidence: 1, sourceText: "row" },
      ],
    }
    const result = normalizeScheduleExtraction(raw as never)
    expect(result.blocks).toEqual([])
    expect(result.dropped.map((d) => d.reason)).toEqual([
      expect.stringMatching(/dayOfWeek/),
      expect.stringMatching(/dayOfWeek/),
    ])
  })

  test("the lowest block confidence is reported so the change can flag it", () => {
    const result = normalizeScheduleExtraction(
      scheduleExtractionSchema.parse({
        blocks: [
          { dayOfWeek: 1, startTime: "09:00", endTime: "10:00", label: "A", confidence: 0.9, sourceText: "a" },
          { dayOfWeek: 2, startTime: "09:00", endTime: "10:00", label: "B", confidence: 0.4, sourceText: "b" },
        ],
      })
    )
    expect(result.minConfidence).toBe(0.4)
  })
})

describe("describeSchedule", () => {
  test("summarizes what the student is being asked to confirm", () => {
    const summary = describeSchedule(
      normalizeScheduleExtraction(scheduleExtractionSchema.parse(scheduleExpected)).blocks
    )
    // Five distinct labels (the CS 201 lecture and lab are different meetings),
    // nine blocks, Monday through Friday.
    expect(summary).toContain("5 classes")
    expect(summary).toContain("9 weekly blocks")
    expect(summary).toContain("Mon–Fri")
    expect(summary).toContain("confirm the weekly grid")
  })

  test("an empty grid says so rather than pretending to a summary", () => {
    expect(describeSchedule([])).toMatch(/No class blocks/)
  })
})
