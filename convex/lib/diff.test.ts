import { describe, expect, test } from "vitest"

import { canvasFixturePayload, type CanvasScenarioName } from "../dev/fixtures"
import { normalizeCanvas } from "./canvas/normalize"
import {
  diffDeadlines,
  diffState,
  hashPayload,
  hashSnapshotPayload,
  stableStringify,
} from "./diff"
import { normalizeIcal } from "./ical/parse"
import { canvasFeedIcs, conflictFeedIcs, genericIcs } from "../../fixtures/ical"
import { reconcileIcalWithCanvas, type ExistingDeadlineRef } from "./merge"
import type { NormalizedDeadline } from "./normalized"

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
      ...(deadline.courseKey !== undefined ? { courseKey: deadline.courseKey } : {}),
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
    // The owning course rides along, so the change row can be filed under it.
    expect(proposal.courseKey).toBe("canvas:course:1002")
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

  test("a same-titled deadline in a DIFFERENT course is not suppressed", () => {
    const feedItem: NormalizedDeadline = {
      key: "ical:psets@planner.example",
      courseKey: "code:cs201",
      title: "Problem Set 3",
      kind: "other",
      dueAt: Date.UTC(2026, 9, 12, 3, 59),
      submissionStatus: "unknown",
      externalIds: { icalUid: "psets@planner.example" },
      provenance: { source: "ical", sourceRef: "feed#psets", confidence: 1 },
    }
    const otherCourse: ExistingDeadlineRef = {
      key: "row-9001",
      courseKey: "code:sta210",
      title: "Problem Set 3",
      dueAt: Date.UTC(2026, 9, 12, 3, 59),
    }

    // Different course: the title match is a coincidence, so it stays new.
    expect(reconcileIcalWithCanvas([feedItem], [otherCourse]).unmatched).toHaveLength(1)
    expect(reconcileIcalWithCanvas([feedItem], [otherCourse]).fuzzyKeys).toEqual([])

    // Same course: suppressed, exactly as before.
    const sameCourse = { ...otherCourse, courseKey: "code:cs201" }
    expect(reconcileIcalWithCanvas([feedItem], [sameCourse]).fuzzyKeys).toEqual([
      feedItem.key,
    ])

    // Only one side names a course: fall back to title + date.
    const noCourse = { ...otherCourse, courseKey: undefined }
    expect(reconcileIcalWithCanvas([feedItem], [noCourse]).fuzzyKeys).toEqual([
      feedItem.key,
    ])
  })

  test("a feed date against a Canvas row with NO date is a conflict, not agreement", () => {
    const feedItem: NormalizedDeadline = {
      key: "ical:event-assignment-5101",
      title: "Assignment 1: Sorting",
      kind: "other",
      dueAt: Date.UTC(2026, 8, 15, 3, 59),
      submissionStatus: "unknown",
      externalIds: { icalUid: "event-assignment-5101", canvasAssignmentId: "5101" },
      provenance: { source: "ical", sourceRef: "feed#5101", confidence: 1 },
    }
    const undated: ExistingDeadlineRef = {
      key: "row-5101",
      canvasAssignmentId: "5101",
      courseKey: "canvas:course:1002",
      title: "Assignment 1: Sorting",
    }

    const result = reconcileIcalWithCanvas([feedItem], [undated])
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].kind).toBe("deadline_moved")
    expect(result.proposals[0].conflict).toBe(true)
    expect(result.proposals[0].reason).toContain("no due date")
    expect((result.proposals[0].before as { dueAt?: number }).dueAt).toBeUndefined()
    expect((result.proposals[0].after as { dueAt: number }).dueAt).toBe(feedItem.dueAt)
  })

  test("Canvas having a date the feed omits is NOT a conflict: Canvas simply wins", () => {
    const undatedFeedItem: NormalizedDeadline = {
      key: "ical:event-assignment-5101",
      title: "Assignment 1: Sorting",
      kind: "other",
      submissionStatus: "unknown",
      externalIds: { icalUid: "event-assignment-5101", canvasAssignmentId: "5101" },
      provenance: { source: "ical", sourceRef: "feed#5101", confidence: 1 },
    }
    const dated: ExistingDeadlineRef = {
      key: "row-5101",
      canvasAssignmentId: "5101",
      title: "Assignment 1: Sorting",
      dueAt: Date.UTC(2026, 8, 15, 3, 59),
    }

    const result = reconcileIcalWithCanvas([undatedFeedItem], [dated])
    expect(result.proposals).toEqual([])
    expect(result.matchedKeys).toEqual([undatedFeedItem.key])
  })
})

describe("submission status transitions", () => {
  const deadline = (
    submissionStatus: NormalizedDeadline["submissionStatus"],
    score?: number
  ): NormalizedDeadline => ({
    key: "canvas:assignment:5101",
    courseKey: "canvas:course:1002",
    title: "Assignment 1: Sorting",
    kind: "homework",
    dueAt: Date.UTC(2026, 8, 15, 3, 59),
    submissionStatus,
    ...(score !== undefined ? { score } : {}),
    externalIds: { canvasAssignmentId: "5101" },
    provenance: { source: "canvas", sourceRef: "/a/5101", confidence: 1 },
  })

  test("submitted -> unsubmitted reopens the deadline", () => {
    const proposals = diffDeadlines([deadline("submitted")], [deadline("unsubmitted")])
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_updated"])
    expect(proposals[0].reason).toContain("reopened")
    expect(
      (proposals[0].after as { submissionStatus: string }).submissionStatus
    ).toBe("unsubmitted")
  })

  test("graded -> submitted reopens it too, and is not reported as progress", () => {
    const proposals = diffDeadlines([deadline("graded", 88)], [deadline("submitted")])
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_updated"])
    expect(proposals[0].reason).toContain("reopened")
    // The retracted score is CLEARED, not silently kept: `null` tells the
    // apply layer (pickDeadline) to unset the field on the row.
    expect((proposals[0].after as { score?: number | null }).score).toBeNull()
  })

  test("graded -> excused also clears the withdrawn score", () => {
    const proposals = diffDeadlines([deadline("graded", 88)], [deadline("excused")])
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_updated"])
    expect((proposals[0].after as { score?: number | null }).score).toBeNull()
  })

  test("forward transitions are unchanged", () => {
    expect(
      diffDeadlines([deadline("unsubmitted")], [deadline("submitted")]).map((p) => p.kind)
    ).toEqual(["submitted"])
    expect(
      diffDeadlines([deadline("submitted")], [deadline("graded", 88)]).map((p) => p.kind)
    ).toEqual(["grade_posted"])
    expect(
      diffDeadlines([deadline("unsubmitted")], [deadline("missing")]).map((p) => p.kind)
    ).toEqual(["deadline_updated"])
    expect(diffDeadlines([deadline("submitted")], [deadline("submitted")])).toEqual([])
  })
})

describe("one-sided dueAt in the snapshot diff", () => {
  const item = (dueAt?: number): NormalizedDeadline => ({
    key: "canvas:assignment:5101",
    courseKey: "canvas:course:1002",
    title: "Assignment 1: Sorting",
    kind: "homework",
    ...(dueAt !== undefined ? { dueAt } : {}),
    submissionStatus: "unsubmitted",
    externalIds: { canvasAssignmentId: "5101" },
    provenance: { source: "canvas", sourceRef: "/a/5101", confidence: 1 },
  })
  const when = Date.UTC(2026, 8, 15, 3, 59)

  test("gaining a date is a deadline_moved from undefined", () => {
    const proposals = diffDeadlines([item()], [item(when)])
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_moved"])
    expect((proposals[0].before as { dueAt?: number }).dueAt).toBeUndefined()
    expect((proposals[0].after as { dueAt: number }).dueAt).toBe(when)
    expect(proposals[0].reason).toBe("Due date changed")
  })

  test("losing a date is a deadline_moved to undefined", () => {
    const proposals = diffDeadlines([item(when)], [item()])
    expect(proposals.map((p) => p.kind)).toEqual(["deadline_moved"])
    expect((proposals[0].before as { dueAt: number }).dueAt).toBe(when)
    expect((proposals[0].after as { dueAt?: number }).dueAt).toBeUndefined()
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

  test("the snapshot hash ignores fetchedAt, so a re-poll is not a change", async () => {
    const at9 = canvasFixturePayload({ fetchedAt: Date.UTC(2026, 9, 30, 9, 0) })
    const at10 = canvasFixturePayload({ fetchedAt: Date.UTC(2026, 9, 30, 10, 0) })
    // The raw payloads genuinely differ...
    expect(await hashPayload(at9)).not.toBe(await hashPayload(at10))
    // ...but the snapshot identity does not.
    expect(await hashSnapshotPayload(at9)).toBe(await hashSnapshotPayload(at10))
    // Real content still moves it.
    expect(await hashSnapshotPayload(at9)).not.toBe(
      await hashSnapshotPayload(canvasFixturePayload({ scenario: "moved" }))
    )
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
