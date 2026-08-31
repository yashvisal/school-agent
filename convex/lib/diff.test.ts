import { describe, expect, test } from "vitest"

import { canvasFixturePayload, type CanvasScenarioName } from "../dev/fixtures"
import { normalizeCanvas } from "./canvas/normalize"
import { diffState, hashPayload, stableStringify } from "./diff"
import { normalizeIcal } from "./ical/parse"
import { canvasFeedIcs, conflictFeedIcs, genericIcs } from "../../fixtures/ical"
import { reconcileIcalWithCanvas, type ExistingDeadlineRef } from "./merge"

/**
 * Every synthetic scenario in `fixtures/changes/` must produce EXACTLY the
 * change kinds its README claims. This is the guarantee core.md calls "a change
 * feed that correctly reports synthetic changes" — and the reason the pipeline
 * can be trusted with no live Canvas.
 */

const base = normalizeCanvas(canvasFixturePayload())

const scenarioKinds = (scenario: CanvasScenarioName) => {
  const next = normalizeCanvas(canvasFixturePayload({ scenario }))
  return diffState(base, next)
}

const idOf = (proposal: { after?: unknown; before?: unknown }) => {
  const bag = (proposal.after ?? proposal.before) as {
    externalIds?: { canvasAssignmentId?: string }
  }
  return bag?.externalIds?.canvasAssignmentId
}

describe("baseline", () => {
  test("an unchanged payload produces no changes at all", () => {
    expect(diffState(base, normalizeCanvas(canvasFixturePayload()))).toEqual([])
  })

  test("a first ingest is all additions", () => {
    const proposals = diffState({ courses: [], deadlines: [], materials: [] }, base)
    expect(proposals.filter((p) => p.kind === "course_added")).toHaveLength(5)
    expect(proposals.filter((p) => p.kind === "deadline_added")).toHaveLength(23)
    expect(proposals).toHaveLength(28)
  })
})

describe("fixtures/changes scenarios", () => {
  test("moved: exactly one deadline_moved, carrying the new date", () => {
    const proposals = scenarioKinds("moved")
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_moved"])
    expect(idOf(proposals[0])).toBe("5103")
    expect((proposals[0].after as { dueAt: number }).dueAt).toBe(
      Date.UTC(2026, 9, 16, 3, 59)
    )
    expect((proposals[0].before as { dueAt: number }).dueAt).toBe(
      Date.UTC(2026, 9, 13, 3, 59)
    )
    expect(proposals[0].reason).toContain("Due date moved")
  })

  test("added: exactly one deadline_added", () => {
    const proposals = scenarioKinds("added")
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_added"])
    expect(idOf(proposals[0])).toBe("5110")
    expect(proposals[0].courseKey).toBe("canvas:course:1002")
  })

  test("removed: exactly one deadline_removed", () => {
    const proposals = scenarioKinds("removed")
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_removed"])
    expect(idOf(proposals[0])).toBe("5104")
    expect(proposals[0].after).toBeUndefined()
  })

  test("submitted: exactly one submitted", () => {
    const proposals = scenarioKinds("submitted")
    expect(proposals.map((p) => p.kind)).toEqual(["submitted"])
    expect(idOf(proposals[0])).toBe("5103")
    expect((proposals[0].after as { submissionStatus: string }).submissionStatus).toBe(
      "submitted"
    )
  })

  test("graded: exactly one grade_posted, with the score", () => {
    const proposals = scenarioKinds("graded")
    expect(proposals.map((p) => p.kind)).toEqual(["grade_posted"])
    expect(idOf(proposals[0])).toBe("5102")
    expect((proposals[0].after as { score: number }).score).toBe(88)
    expect((proposals[0].after as { submissionStatus: string }).submissionStatus).toBe(
      "graded"
    )
  })

  test("conflict: the iCal feed disagrees with Canvas about 5101", () => {
    const existing: ExistingDeadlineRef[] = base.deadlines.map((deadline) => ({
      key: `row-${deadline.externalIds.canvasAssignmentId}`,
      ...(deadline.externalIds.canvasAssignmentId
        ? { canvasAssignmentId: deadline.externalIds.canvasAssignmentId }
        : {}),
      title: deadline.title,
      ...(deadline.dueAt !== undefined ? { dueAt: deadline.dueAt } : {}),
    }))

    const agreeing = reconcileIcalWithCanvas(
      normalizeIcal(canvasFeedIcs).deadlines,
      existing
    )
    expect(agreeing.proposals).toEqual([])
    expect(agreeing.unmatched).toEqual([])
    expect(agreeing.matchedKeys).toHaveLength(4)

    const conflicting = reconcileIcalWithCanvas(
      normalizeIcal(conflictFeedIcs).deadlines,
      existing
    )
    expect(conflicting.proposals).toHaveLength(1)
    const [proposal] = conflicting.proposals
    expect(proposal.kind).toBe("deadline_moved")
    expect(proposal.conflict).toBe(true)
    expect(proposal.entityId).toBe("row-5101")
    expect((proposal.after as { dueAt: number }).dueAt).toBe(Date.UTC(2026, 8, 16, 3, 59))
  })
})

describe("iCal reconciliation", () => {
  const existing: ExistingDeadlineRef[] = [
    {
      key: "row-5203",
      canvasAssignmentId: "5203",
      title: "Homework 3: Multiple Regression",
      dueAt: Date.UTC(2026, 9, 12, 3, 59),
    },
  ]

  test("a non-Canvas UID whose title and date match is suppressed, not duplicated", () => {
    const { deadlines } = normalizeIcal(genericIcs)
    const result = reconcileIcalWithCanvas(deadlines, existing)
    expect(result.fuzzyKeys).toEqual(["ical:legacy-import-88@planner.example"])
    expect(result.unmatched).toHaveLength(3)
    // Fuzzy matches never propose a change: a title match is not evidence
    // enough to move a date.
    expect(result.proposals).toEqual([])
  })
})

describe("hashing", () => {
  test("key order does not change the hash", async () => {
    const a = { b: 1, a: [1, { y: 2, x: 3 }] }
    const c = { a: [1, { x: 3, y: 2 }], b: 1 }
    expect(stableStringify(a)).toBe(stableStringify(c))
    expect(await hashPayload(a)).toBe(await hashPayload(c))
  })

  test("undefined is dropped, null is not", () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}')
  })

  test("a changed value changes the hash", async () => {
    expect(await hashPayload({ a: 1 })).not.toBe(await hashPayload({ a: 2 }))
    expect((await hashPayload({ a: 1 })).length).toBe(64)
  })

  test("the fixture semester hashes stably across builds", async () => {
    expect(await hashPayload(canvasFixturePayload())).toBe(
      await hashPayload(canvasFixturePayload())
    )
    expect(await hashPayload(canvasFixturePayload())).not.toBe(
      await hashPayload(canvasFixturePayload({ scenario: "moved" }))
    )
  })
})
