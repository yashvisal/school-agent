import type {
  CourseStatus,
  DeadlineKind,
  GradingScheme,
  NormalizedCourse,
  NormalizedDeadline,
  NormalizedMaterial,
  NormalizedState,
  Provenance,
  SubmissionStatus,
} from "../normalized"
import type {
  CanvasAssignment,
  CanvasAssignmentGroup,
  CanvasCourse,
  CanvasCourseBundle,
  CanvasSnapshotPayload,
  CanvasSubmission,
} from "./types"
import { emptyCourseBundle } from "./types"

/**
 * Canvas payload → the adapter-neutral normalized state.
 *
 * Pure: no ctx, no clock, no network. `normalizeCanvas(snapshot.payload)` is
 * re-run on every diff, so snapshots stay the single truth (plans/core.md).
 *
 * Canvas is an authoritative structured source, so every fact here carries
 * `source: "canvas"` and `confidence: 1`; `sourceRef` is the API path the fact
 * came from, which is also what makes a change replayable.
 */

const CANVAS_CONFIDENCE = 1

export const courseKeyOf = (courseId: string | number) => `canvas:course:${courseId}`
export const deadlineKeyOf = (assignmentId: string | number) =>
  `canvas:assignment:${assignmentId}`

const provenance = (sourceRef: string): Provenance => ({
  source: "canvas",
  sourceRef,
  confidence: CANVAS_CONFIDENCE,
})

/** Canvas timestamps are ISO 8601; `null`/absent/garbage all mean "no date". */
export function parseCanvasDate(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

// ---------------------------------------------------------------------------
// kind
// ---------------------------------------------------------------------------

const EXAM_RE = /\b(exam|exams|midterm|midterms|final|finals)\b/i
const READING_RE = /\breading(s)?\b/i

/**
 * Deadline kind, from what Canvas actually says — never inferred from vibes.
 *
 * 1. An explicit "exam" signal in the assignment group name or the assignment
 *    name wins, because a proctored midterm delivered as an `online_quiz` is an
 *    exam to the student, not a quiz.
 * 2. `submission_types: ["online_quiz"]` (or `is_quiz_assignment`) → quiz.
 * 3. An explicit "reading" group → reading.
 * 4. Otherwise homework. Canvas has no signal for `project`; the syllabus
 *    adapter is where that comes from.
 */
export function kindForAssignment(
  assignment: CanvasAssignment,
  groupName: string | undefined
): DeadlineKind {
  const name = assignment.name ?? ""
  if (EXAM_RE.test(groupName ?? "") || EXAM_RE.test(name)) return "exam"

  const submissionTypes = Array.isArray(assignment.submission_types)
    ? assignment.submission_types
    : []
  if (submissionTypes.includes("online_quiz") || assignment.is_quiz_assignment === true) {
    return "quiz"
  }

  if (READING_RE.test(groupName ?? "")) return "reading"
  return "homework"
}

// ---------------------------------------------------------------------------
// submission status
// ---------------------------------------------------------------------------

/**
 * What the student's submission row says, in the order the student would read
 * it: excused beats everything, a posted grade beats a submission, an actual
 * `submitted_at` beats a "missing" flag, and no row at all is `unknown` (not
 * `unsubmitted` — Canvas simply didn't tell us).
 */
export function submissionStatusFor(
  submission: CanvasSubmission | undefined
): SubmissionStatus {
  if (!submission) return "unknown"
  if (submission.excused === true) return "excused"
  if (submission.workflow_state === "graded") {
    // A `graded` row with no score and no submission is how Canvas represents
    // an excused/zeroed item on some instances; treat a real score as graded.
    if (numberOrUndefined(submission.score) !== undefined) return "graded"
    if (parseCanvasDate(submission.submitted_at) !== undefined) return "graded"
    return "unsubmitted"
  }
  if (parseCanvasDate(submission.submitted_at) !== undefined) return "submitted"
  if (submission.workflow_state === "pending_review") return "submitted"
  if (submission.missing === true) return "missing"
  if (submission.workflow_state === "unsubmitted") return "unsubmitted"
  return "unknown"
}

// ---------------------------------------------------------------------------
// course
// ---------------------------------------------------------------------------

/**
 * `workflow_state` is `'unpublished' | 'available' | 'completed' | 'deleted'`.
 * An unpublished or deleted course is real but not something the student can
 * work in, so it lands `hidden` rather than being dropped — dropping it would
 * make it reappear as a `course_added` on every poll.
 */
export function courseStatusFor(course: CanvasCourse): CourseStatus {
  if (course.concluded === true) return "concluded"
  switch (course.workflow_state) {
    case "completed":
      return "concluded"
    case "unpublished":
    case "deleted":
      return "hidden"
    default:
      return "active"
  }
}

/**
 * Grading scheme as the course states it: one category per assignment group,
 * carrying the group's weight and drop rule verbatim. No normalization of
 * weights, no computed grade — that is inference (vision §9).
 */
export function gradingSchemeFor(
  groups: CanvasAssignmentGroup[]
): GradingScheme | undefined {
  if (groups.length === 0) return undefined
  const categories = groups.map((group) => {
    const weight = numberOrUndefined(group.group_weight)
    const dropLowest = numberOrUndefined(group.rules?.drop_lowest)
    return {
      name: group.name ?? `Group ${group.id}`,
      ...(weight !== undefined ? { weight } : {}),
      ...(dropLowest !== undefined && dropLowest > 0 ? { dropLowest } : {}),
      canvasGroupId: String(group.id),
    }
  })
  const totalWeight = categories.reduce((sum, c) => sum + (c.weight ?? 0), 0)
  return {
    categories,
    notes:
      totalWeight > 0
        ? `Weights as stated in Canvas assignment groups (total ${totalWeight}%).`
        : "Canvas assignment groups carry no weights; this course is graded on total points.",
  }
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

export function normalizeCanvas(payload: CanvasSnapshotPayload): NormalizedState {
  const courses: NormalizedCourse[] = []
  const deadlines: NormalizedDeadline[] = []
  const materials: NormalizedMaterial[] = []

  for (const course of payload.courses ?? []) {
    const courseId = String(course.id)
    const key = courseKeyOf(courseId)
    const bundle: CanvasCourseBundle = payload.byCourse?.[courseId] ?? emptyCourseBundle()

    courses.push({
      key,
      name: course.name ?? `Canvas course ${courseId}`,
      ...(course.course_code ? { code: course.course_code } : {}),
      sourceRefs: { canvasCourseId: courseId },
      ...(gradingSchemeFor(bundle.assignmentGroups)
        ? { gradingScheme: gradingSchemeFor(bundle.assignmentGroups) }
        : {}),
      status: courseStatusFor(course),
      provenance: provenance(`/api/v1/courses/${courseId}`),
    })

    const groupNameById = new Map<string, string>()
    for (const group of bundle.assignmentGroups) {
      groupNameById.set(String(group.id), group.name ?? `Group ${group.id}`)
    }

    const submissionByAssignment = new Map<string, CanvasSubmission>()
    for (const submission of bundle.submissions) {
      submissionByAssignment.set(String(submission.assignment_id), submission)
    }

    for (const assignment of bundle.assignments) {
      // Unpublished assignments are not visible to the student and would churn
      // the change feed every time an instructor drafts something. The COURSE
      // is still kept (see `courseStatusFor`); only the draft item is skipped.
      if (assignment.published === false) continue

      const assignmentId = String(assignment.id)
      const groupName = groupNameById.get(String(assignment.assignment_group_id))
      const submission = submissionByAssignment.get(assignmentId)
      const dueAt = parseCanvasDate(assignment.due_at)
      const points = numberOrUndefined(assignment.points_possible)
      const score = numberOrUndefined(submission?.score)

      deadlines.push({
        key: deadlineKeyOf(assignmentId),
        courseKey: key,
        title: assignment.name ?? `Assignment ${assignmentId}`,
        kind: kindForAssignment(assignment, groupName),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(points !== undefined ? { pointsPossible: points } : {}),
        ...(groupName ? { category: groupName } : {}),
        submissionStatus: submissionStatusFor(submission),
        ...(score !== undefined ? { score } : {}),
        ...(typeof assignment.description === "string" && assignment.description
          ? { description: assignment.description }
          : {}),
        ...(assignment.html_url ? { url: assignment.html_url } : {}),
        externalIds: { canvasAssignmentId: assignmentId },
        provenance: provenance(
          `/api/v1/courses/${courseId}/assignments/${assignmentId}`
        ),
      })
    }

    const material = (
      kind: NormalizedMaterial["kind"],
      externalId: string,
      title: string,
      raw: unknown,
      sourceRef: string
    ) => materials.push({ courseKey: key, kind, externalId, title, raw, provenance: provenance(sourceRef) })

    for (const file of bundle.files) {
      material(
        "file",
        `file-${file.id}`,
        file.display_name ?? file.filename ?? `File ${file.id}`,
        file,
        `/api/v1/courses/${courseId}/files/${file.id}`
      )
    }
    for (const mod of bundle.modules) {
      material(
        "module",
        `module-${mod.id}`,
        mod.name ?? `Module ${mod.id}`,
        mod,
        `/api/v1/courses/${courseId}/modules/${mod.id}`
      )
    }
    for (const page of bundle.pages) {
      material(
        "page",
        `page-${page.url ?? page.page_id}`,
        page.title ?? `Page ${page.page_id}`,
        page,
        `/api/v1/courses/${courseId}/pages/${page.url ?? page.page_id}`
      )
    }
    for (const announcement of bundle.announcements) {
      material(
        "announcement",
        `announcement-${announcement.id}`,
        announcement.title ?? `Announcement ${announcement.id}`,
        announcement,
        `/api/v1/courses/${courseId}/discussion_topics/${announcement.id}`
      )
    }
  }

  return { courses, deadlines, materials }
}
