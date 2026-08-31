import announcements1001 from "../../fixtures/canvas/announcements.1001.json"
import announcements1002 from "../../fixtures/canvas/announcements.1002.json"
import announcements1003 from "../../fixtures/canvas/announcements.1003.json"
import assignmentGroups1001 from "../../fixtures/canvas/assignment_groups.1001.json"
import assignmentGroups1002 from "../../fixtures/canvas/assignment_groups.1002.json"
import assignmentGroups1003 from "../../fixtures/canvas/assignment_groups.1003.json"
import assignments1001 from "../../fixtures/canvas/assignments.1001.json"
import assignments1002 from "../../fixtures/canvas/assignments.1002.json"
import assignments1003 from "../../fixtures/canvas/assignments.1003.json"
import courses from "../../fixtures/canvas/courses.json"
import files1001 from "../../fixtures/canvas/files.1001.json"
import files1002 from "../../fixtures/canvas/files.1002.json"
import files1003 from "../../fixtures/canvas/files.1003.json"
import modules1001 from "../../fixtures/canvas/modules.1001.json"
import modules1002 from "../../fixtures/canvas/modules.1002.json"
import modules1003 from "../../fixtures/canvas/modules.1003.json"
import pages1001 from "../../fixtures/canvas/pages.1001.json"
import pages1002 from "../../fixtures/canvas/pages.1002.json"
import pages1003 from "../../fixtures/canvas/pages.1003.json"
import submissions1001 from "../../fixtures/canvas/submissions.1001.json"
import submissions1002 from "../../fixtures/canvas/submissions.1002.json"
import submissions1003 from "../../fixtures/canvas/submissions.1003.json"
import addedAssignments1002 from "../../fixtures/changes/added/assignments.1002.json"
import gradedSubmissions1002 from "../../fixtures/changes/graded/submissions.1002.json"
import movedAssignments1002 from "../../fixtures/changes/moved/assignments.1002.json"
import removedAssignments1002 from "../../fixtures/changes/removed/assignments.1002.json"
import submittedSubmissions1002 from "../../fixtures/changes/submitted/submissions.1002.json"
import { canvasFeedIcs, conflictFeedIcs, genericIcs } from "../../fixtures/ical"
import type {
  CanvasAssignment,
  CanvasCourse,
  CanvasCourseBundle,
  CanvasSnapshotPayload,
  CanvasSubmission,
} from "../lib/canvas/types"
import { emptyCourseBundle } from "../lib/canvas/types"

/**
 * The spec-derived fixture semester, assembled into the exact payload shapes the
 * adapters see in production.
 *
 * plans/core.md, "Test data & limitations": there is no live Canvas until a
 * friend's token arrives, so the whole pipeline is exercised on hand-authored
 * fixtures whose shapes come from Instructure's published example JSON. These
 * imports are what let `internal.ingest.canvas.poll` run with
 * `config.mode === "fixture"` on a dev deployment with no token at all.
 *
 * Committed fixtures contain no real student data (fixtures/README.md).
 */

export const FIXTURE_BASE_URL = "https://canvas.example.edu"
export const FIXTURE_ICAL_URL =
  "https://canvas.example.edu/feeds/calendars/user_fixture.ics"

/** Only these three courses were polled; 1004 is concluded, 1005 unpublished. */
export const FIXTURE_COURSE_IDS = ["1001", "1002", "1003"] as const

type Bundles = Record<string, CanvasCourseBundle>

const baseBundles = (): Bundles => ({
  "1001": {
    assignmentGroups: assignmentGroups1001 as CanvasCourseBundle["assignmentGroups"],
    assignments: assignments1001 as unknown as CanvasAssignment[],
    submissions: submissions1001 as unknown as CanvasSubmission[],
    files: files1001 as CanvasCourseBundle["files"],
    modules: modules1001 as CanvasCourseBundle["modules"],
    pages: pages1001 as CanvasCourseBundle["pages"],
    announcements: announcements1001 as CanvasCourseBundle["announcements"],
  },
  "1002": {
    assignmentGroups: assignmentGroups1002 as CanvasCourseBundle["assignmentGroups"],
    assignments: assignments1002 as unknown as CanvasAssignment[],
    submissions: submissions1002 as unknown as CanvasSubmission[],
    files: files1002 as CanvasCourseBundle["files"],
    modules: modules1002 as CanvasCourseBundle["modules"],
    pages: pages1002 as CanvasCourseBundle["pages"],
    announcements: announcements1002 as CanvasCourseBundle["announcements"],
  },
  "1003": {
    assignmentGroups: assignmentGroups1003 as CanvasCourseBundle["assignmentGroups"],
    assignments: assignments1003 as unknown as CanvasAssignment[],
    submissions: submissions1003 as unknown as CanvasSubmission[],
    files: files1003 as CanvasCourseBundle["files"],
    modules: modules1003 as CanvasCourseBundle["modules"],
    pages: pages1003 as CanvasCourseBundle["pages"],
    announcements: announcements1003 as CanvasCourseBundle["announcements"],
  },
  // Returned by the courses endpoint but not polled further: a concluded course
  // and an unpublished one. Empty bundles, not missing keys, so normalization
  // sees them exactly as a real poll would.
  "1004": emptyCourseBundle(),
  "1005": emptyCourseBundle(),
})

export type CanvasScenarioName = "moved" | "added" | "removed" | "submitted" | "graded"
export type IcalScenarioName = "conflict"
export type ScenarioName = CanvasScenarioName | IcalScenarioName

const CANVAS_SCENARIOS: Record<
  CanvasScenarioName,
  { assignments?: CanvasAssignment[]; submissions?: CanvasSubmission[] }
> = {
  moved: { assignments: movedAssignments1002 as unknown as CanvasAssignment[] },
  added: { assignments: addedAssignments1002 as unknown as CanvasAssignment[] },
  removed: { assignments: removedAssignments1002 as unknown as CanvasAssignment[] },
  submitted: {
    submissions: submittedSubmissions1002 as unknown as CanvasSubmission[],
  },
  graded: { submissions: gradedSubmissions1002 as unknown as CanvasSubmission[] },
}

export const isCanvasScenario = (name: string): name is CanvasScenarioName =>
  name in CANVAS_SCENARIOS

/**
 * The baseline semester, or a scenario variant. `fetchedAt` is caller-supplied
 * so the payload stays a pure function of its inputs (and so two polls of the
 * same fixture hash identically — see `hashPayload` in lib/diff.ts, which is
 * what makes the snapshot table append-only-on-change).
 */
export function canvasFixturePayload(options?: {
  scenario?: CanvasScenarioName
  fetchedAt?: number
}): CanvasSnapshotPayload {
  const bundles = baseBundles()
  const scenario = options?.scenario
  if (scenario) {
    const patch = CANVAS_SCENARIOS[scenario]
    const bundle = bundles["1002"]
    bundles["1002"] = {
      ...bundle,
      ...(patch.assignments ? { assignments: patch.assignments } : {}),
      ...(patch.submissions ? { submissions: patch.submissions } : {}),
    }
  }
  return {
    kind: "canvas",
    baseUrl: FIXTURE_BASE_URL,
    // Fixed, not `Date.now()`, so the payload stays a pure function of its
    // inputs. (`hashSnapshotPayload` neutralizes `fetchedAt` anyway — it is when
    // we looked, not what the source said.)
    fetchedAt: options?.fetchedAt ?? Date.UTC(2026, 9, 30, 12, 0, 0),
    courses: courses as unknown as CanvasCourse[],
    byCourse: bundles,
    fixture: scenario ? `changes/${scenario}` : "canvas/base",
  }
}

export type IcalSnapshotPayload = {
  kind: "ical"
  url: string
  fetchedAt: number
  text: string
  fixture?: string
}

export function icalFixturePayload(options?: {
  variant?: "canvas" | "generic" | "conflict"
  fetchedAt?: number
}): IcalSnapshotPayload {
  const variant = options?.variant ?? "canvas"
  const text =
    variant === "generic"
      ? genericIcs
      : variant === "conflict"
        ? conflictFeedIcs
        : canvasFeedIcs
  return {
    kind: "ical",
    url: variant === "generic" ? `${FIXTURE_ICAL_URL}?variant=generic` : FIXTURE_ICAL_URL,
    fetchedAt: options?.fetchedAt ?? Date.UTC(2026, 9, 30, 12, 5, 0),
    text,
    fixture: variant === "conflict" ? "changes/conflict" : `ical/${variant}`,
  }
}

export { canvasFeedIcs, conflictFeedIcs, genericIcs }
