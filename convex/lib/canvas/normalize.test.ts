import { describe, expect, test } from "vitest"

import { canvasFixturePayload } from "../../dev/fixtures"
import type { NormalizedDeadline } from "../normalized"
import { normalizeCanvas } from "./normalize"

/**
 * `normalizeCanvas` against the spec-derived fixture semester. These numbers are
 * the contract the diff tests and the end-to-end test both lean on; if a fixture
 * changes, this file is where it shows up first.
 */

const state = normalizeCanvas(canvasFixturePayload())
const byCanvasId = new Map<string, NormalizedDeadline>(
  state.deadlines.map((d) => [d.externalIds.canvasAssignmentId as string, d])
)
const count = <T>(items: T[], predicate: (item: T) => boolean) =>
  items.filter(predicate).length

describe("courses", () => {
  test("every enrolled course is normalized, including the ones not polled", () => {
    expect(state.courses).toHaveLength(5)
    expect(state.courses.map((c) => c.code)).toEqual([
      "BIO201",
      "CS201",
      "STA210",
      "HIST101",
      "CHEM101",
    ])
  })

  test("workflow_state maps to status, so a concluded course is not lost", () => {
    const status = new Map(state.courses.map((c) => [c.code, c.status]))
    expect(status.get("BIO201")).toBe("active")
    expect(status.get("HIST101")).toBe("concluded")
    expect(status.get("CHEM101")).toBe("hidden")
  })

  test("provenance is the Canvas API path, at full confidence", () => {
    const bio = state.courses[0]
    expect(bio.provenance).toEqual({
      source: "canvas",
      sourceRef: "/api/v1/courses/1001",
      confidence: 1,
    })
    expect(bio.sourceRefs.canvasCourseId).toBe("1001")
  })
})

describe("grading scheme", () => {
  const cs = state.courses.find((c) => c.code === "CS201")

  test("one category per assignment group, weights and drop rules verbatim", () => {
    expect(cs?.gradingScheme?.categories).toEqual([
      {
        name: "Programming Assignments",
        weight: 40,
        dropLowest: 1,
        canvasGroupId: "2101",
      },
      { name: "Quizzes", weight: 15, dropLowest: 2, canvasGroupId: "2102" },
      { name: "Exams", weight: 45, canvasGroupId: "2103" },
    ])
  })

  test("a drop_lowest of 0 is not a drop rule", () => {
    const bio = state.courses.find((c) => c.code === "BIO201")
    const exams = bio?.gradingScheme?.categories.find((c) => c.name === "Exams")
    expect(exams?.dropLowest).toBeUndefined()
    expect(exams?.weight).toBe(45)
  })

  test("a course with no polled groups has no stated scheme", () => {
    expect(state.courses.find((c) => c.code === "HIST101")?.gradingScheme).toBeUndefined()
  })
})

describe("deadlines", () => {
  test("unpublished assignments are skipped, their course is not", () => {
    expect(state.deadlines).toHaveLength(23)
    expect(byCanvasId.has("5008")).toBe(false)
    expect(state.courses.some((c) => c.code === "BIO201")).toBe(true)
  })

  test("kind comes from what Canvas says, exams first", () => {
    expect(byCanvasId.get("5101")?.kind).toBe("homework")
    expect(byCanvasId.get("5105")?.kind).toBe("quiz")
    // An online_quiz in the Exams group is an exam to the student.
    expect(byCanvasId.get("5107")?.kind).toBe("exam")
    expect(byCanvasId.get("5108")?.kind).toBe("exam")
    expect(byCanvasId.get("5204")?.kind).toBe("reading")

    expect(count(state.deadlines, (d) => d.kind === "homework")).toBe(13)
    expect(count(state.deadlines, (d) => d.kind === "quiz")).toBe(2)
    expect(count(state.deadlines, (d) => d.kind === "exam")).toBe(6)
    expect(count(state.deadlines, (d) => d.kind === "reading")).toBe(2)
  })

  test("category is the assignment group name", () => {
    expect(byCanvasId.get("5004")?.category).toBe("Labs")
    expect(byCanvasId.get("5201")?.category).toBe("Homework")
  })

  test("points and due dates come across; a null due_at stays absent", () => {
    expect(byCanvasId.get("5101")?.pointsPossible).toBe(100)
    expect(byCanvasId.get("5101")?.dueAt).toBe(Date.UTC(2026, 8, 15, 3, 59))
    expect(byCanvasId.get("5109")?.dueAt).toBeUndefined()
  })

  test("submission status reads the way a student would read it", () => {
    expect(byCanvasId.get("5001")?.submissionStatus).toBe("graded")
    expect(byCanvasId.get("5001")?.score).toBe(18)
    expect(byCanvasId.get("5002")?.submissionStatus).toBe("submitted")
    expect(byCanvasId.get("5004")?.submissionStatus).toBe("missing")
    // excused wins over the `graded` workflow_state Canvas pairs it with
    expect(byCanvasId.get("5109")?.submissionStatus).toBe("excused")
    expect(byCanvasId.get("5103")?.submissionStatus).toBe("unsubmitted")
    // no submission row at all is `unknown`, not `unsubmitted`
    expect(byCanvasId.get("5106")?.submissionStatus).toBe("unknown")

    const tally = (status: string) =>
      count(state.deadlines, (d) => d.submissionStatus === status)
    expect(tally("graded")).toBe(4)
    expect(tally("submitted")).toBe(3)
    expect(tally("missing")).toBe(1)
    expect(tally("excused")).toBe(2)
    expect(tally("unsubmitted")).toBe(2)
    expect(tally("unknown")).toBe(11)
  })

  test("each deadline carries its own API path as provenance", () => {
    expect(byCanvasId.get("5101")?.provenance.sourceRef).toBe(
      "/api/v1/courses/1002/assignments/5101"
    )
  })
})

describe("materials", () => {
  test("files, modules, pages and announcements are captured raw", () => {
    expect(state.materials).toHaveLength(21) // 3 courses x (2 files + 2 modules + 2 pages + 1 announcement)
    const kinds = new Set(state.materials.map((m) => m.kind))
    expect([...kinds].sort()).toEqual(["announcement", "file", "module", "page"])
    expect(state.materials.some((m) => m.externalId === "page-office-hours")).toBe(true)
  })
})

describe("determinism", () => {
  test("normalizing the same payload twice is identical", () => {
    expect(normalizeCanvas(canvasFixturePayload())).toEqual(state)
  })
})
