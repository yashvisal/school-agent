/**
 * Canvas LMS REST payload types.
 *
 * Every shape here is transcribed from Instructure's published example JSON —
 * never from memory (plans/core.md, "Test data & limitations"). Doc URLs:
 *
 * - Course            https://developerdocs.instructure.com/services/canvas/resources/courses
 * - Assignment        https://developerdocs.instructure.com/services/canvas/resources/assignments
 * - AssignmentGroup   https://developerdocs.instructure.com/services/canvas/resources/assignment_groups
 * - Submission        https://developerdocs.instructure.com/services/canvas/resources/submissions
 * - File              https://developerdocs.instructure.com/services/canvas/resources/files
 * - Module            https://developerdocs.instructure.com/services/canvas/resources/modules
 * - Page              https://developerdocs.instructure.com/services/canvas/resources/pages
 * - DiscussionTopic   https://developerdocs.instructure.com/services/canvas/resources/discussion_topics
 * - Announcements     https://developerdocs.instructure.com/services/canvas/resources/announcements
 * - Pagination        https://developerdocs.instructure.com/services/canvas/basics/file.pagination
 *
 * Only the fields the adapter reads are declared as required-ish; everything
 * else is optional so a real instance returning more (or fewer) fields still
 * parses. Canvas timestamps are ISO 8601 strings; `null` means "not set".
 */

export type CanvasId = number | string

/** `include[]=term` on GET /api/v1/courses. */
export type CanvasTerm = {
  id?: CanvasId
  name?: string
  start_at?: string | null
  end_at?: string | null
  workflow_state?: string
}

/** `'unpublished' | 'available' | 'completed' | 'deleted'` per the docs. */
export type CanvasCourse = {
  id: CanvasId
  name?: string
  course_code?: string
  workflow_state?: string
  enrollment_term_id?: CanvasId
  start_at?: string | null
  end_at?: string | null
  created_at?: string | null
  /** Not in the base example object; returned by `include[]=concluded`. */
  concluded?: boolean
  time_zone?: string
  term?: CanvasTerm | null
  [key: string]: unknown
}

/** GradingRules, per the AssignmentGroup docs. */
export type CanvasGradingRules = {
  drop_lowest?: number
  drop_highest?: number
  never_drop?: CanvasId[]
}

export type CanvasAssignmentGroup = {
  id: CanvasId
  name?: string
  position?: number
  /** Percent of the final grade, when the course uses weighted groups. */
  group_weight?: number
  rules?: CanvasGradingRules | null
  assignments?: CanvasAssignment[]
  [key: string]: unknown
}

export type CanvasAssignment = {
  id: CanvasId
  name?: string
  description?: string | null
  course_id?: CanvasId
  html_url?: string
  due_at?: string | null
  lock_at?: string | null
  unlock_at?: string | null
  assignment_group_id?: CanvasId
  position?: number
  points_possible?: number | null
  grading_type?: string
  /** e.g. `["online_upload"]`, `["online_quiz"]`, `["on_paper"]`, `["none"]`. */
  submission_types?: string[]
  has_submitted_submissions?: boolean
  published?: boolean
  workflow_state?: string
  is_quiz_assignment?: boolean
  quiz_id?: CanvasId | null
  omit_from_final_grade?: boolean
  important_dates?: boolean
  [key: string]: unknown
}

/** `'submitted' | 'unsubmitted' | 'graded' | 'pending_review'` in practice. */
export type CanvasSubmission = {
  id?: CanvasId
  assignment_id: CanvasId
  course_id?: CanvasId
  user_id?: CanvasId
  attempt?: number | null
  score?: number | null
  entered_score?: number | null
  grade?: string | null
  submitted_at?: string | null
  graded_at?: string | null
  posted_at?: string | null
  workflow_state?: string
  submission_type?: string | null
  late?: boolean
  missing?: boolean
  excused?: boolean
  late_policy_status?: string | null
  seconds_late?: number
  preview_url?: string | null
  [key: string]: unknown
}

export type CanvasFile = {
  id: CanvasId
  uuid?: string
  folder_id?: CanvasId
  display_name?: string
  filename?: string
  /** Hyphenated in the API response, not snake_case. */
  "content-type"?: string
  url?: string
  size?: number
  created_at?: string
  updated_at?: string
  locked?: boolean
  hidden?: boolean
  mime_class?: string
  [key: string]: unknown
}

export type CanvasModule = {
  id: CanvasId
  workflow_state?: string
  position?: number
  name?: string
  unlock_at?: string | null
  require_sequential_progress?: boolean
  items_count?: number
  items_url?: string
  state?: string
  published?: boolean
  [key: string]: unknown
}

export type CanvasPage = {
  /** Pages are keyed by `page_id`, not `id`. */
  page_id: CanvasId
  url?: string
  title?: string
  created_at?: string
  updated_at?: string
  hide_from_students?: boolean
  editing_roles?: string
  body?: string
  published?: boolean
  front_page?: boolean
  locked_for_user?: boolean
  [key: string]: unknown
}

/** Announcements are DiscussionTopic objects. */
export type CanvasDiscussionTopic = {
  id: CanvasId
  title?: string
  message?: string | null
  html_url?: string
  posted_at?: string | null
  last_reply_at?: string | null
  delayed_post_at?: string | null
  published?: boolean
  locked?: boolean
  pinned?: boolean
  discussion_type?: string
  assignment_id?: CanvasId | null
  context_code?: string
  [key: string]: unknown
}

/** Everything one poll captured for a single course. */
export type CanvasCourseBundle = {
  assignmentGroups: CanvasAssignmentGroup[]
  assignments: CanvasAssignment[]
  submissions: CanvasSubmission[]
  files: CanvasFile[]
  modules: CanvasModule[]
  pages: CanvasPage[]
  announcements: CanvasDiscussionTopic[]
}

/**
 * The immutable snapshot payload. Stored verbatim in `snapshots.payload`;
 * normalization is always re-derived from it, never cached (plans/core.md,
 * "Snapshot → diff → changes").
 */
export type CanvasSnapshotPayload = {
  kind: "canvas"
  /** e.g. `https://canvas.example.edu` — no trailing slash. */
  baseUrl: string
  fetchedAt: number
  courses: CanvasCourse[]
  /** Keyed by stringified course id. Courses with no bundle were not polled. */
  byCourse: Record<string, CanvasCourseBundle>
  /** Set by fixture-mode polls so a snapshot can never be mistaken for real data. */
  fixture?: string
}

export const emptyCourseBundle = (): CanvasCourseBundle => ({
  assignmentGroups: [],
  assignments: [],
  submissions: [],
  files: [],
  modules: [],
  pages: [],
  announcements: [],
})
