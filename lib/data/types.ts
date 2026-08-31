/**
 * Face-side mirrors of the Core state model (plans/core.md "State model — facts,
 * minimal"). These are hand-written *until Core ships the schema*; the moment
 * `convex/schema.ts` lands, delete this file and import `Doc<"courses">` &c.
 * from `convex/_generated/dataModel`.
 *
 * Two rules from the plan are load-bearing here and must survive that swap:
 *  - **facts, not inference** (vision §9): nothing derived is stored on a
 *    record. Importance, "hell weeks", pacing — all computed in the view.
 *  - **provenance on every fact** (core.md): `source`, `sourceRef`,
 *    `confidence`, `snapshotId`. The UI shows it on click; see
 *    `components/panels/ProvenancePopover.tsx`.
 */

export type Id = string

/* ── enums, exactly as core.md states them ──────────────────────────────── */

export type SourceKind = "canvas" | "ical" | "syllabus" | "site" | "schedule"

/** `changes.origin` */
export type ChangeOrigin =
  | "canvas"
  | "ical"
  | "syllabus"
  | "site"
  | "chat"
  | "manual"

export type DeadlineKind =
  | "homework"
  | "project"
  | "exam"
  | "quiz"
  | "reading"
  | "other"

export type TaskType = "do" | "prepared"

export type TaskStatus = "todo" | "in_progress" | "done" | "skipped"

export type TaskCreatedBy = "agent" | "student"

export type ChangeKind =
  | "deadline_added"
  | "deadline_moved"
  | "deadline_removed"
  | "submitted"
  | "grade_posted"
  | "course_added"
  | "chat_decision"
  | "grading_scheme_parsed"

/** two-tier apply rule (core.md "Two-tier apply rule") */
export type ChangeTier = "auto" | "needs_approval"

export type ChangeStatus = "applied" | "pending" | "approved" | "rejected"

export type SourceHealth = "healthy" | "degraded" | "failing" | "never_synced"

export type CourseStatus = "active" | "concluded"

/* ── provenance ─────────────────────────────────────────────────────────── */

/** Every fact carries this. Rendered by the provenance popover. */
export type Provenance = {
  source: ChangeOrigin
  /** the thing in the source this came from: a Canvas id, a page ref, a URL */
  sourceRef: string
  /** 0–1. Structured sources are 1; LLM extraction is whatever it reported. */
  confidence: number
  snapshotId: Id
  /** when the snapshot this fact came from was fetched (ISO 8601) */
  observedAt: string
}

/* ── records ────────────────────────────────────────────────────────────── */

export type GradingCategory = {
  name: string
  /** as stated by the syllabus — a fraction of the final grade, 0–1 */
  weight: number
  /** e.g. "lowest 1 dropped"; stored as stated, never interpreted */
  dropRule?: string
}

export type Course = {
  _id: Id
  studentId: Id
  name: string
  code: string
  /** short colour accent used across the shell; a display choice, not a fact */
  accent: string
  sourceRefs: {
    canvasCourseId?: string
    icalUrl?: string
    siteUrl?: string
  }
  gradingScheme: GradingCategory[]
  status: CourseStatus
  provenance: Provenance
}

export type Deadline = {
  _id: Id
  courseId: Id
  title: string
  kind: DeadlineKind
  /** ISO 8601 */
  dueAt: string
  pointsPossible?: number
  category?: string
  submissionStatus?: "submitted" | "unsubmitted" | "graded"
  description?: string
  provenance: Provenance
  /**
   * Not a stored fact — the id of the open `change` touching this deadline, so
   * Semester/Dashboard can highlight it. Core would derive this in the query.
   */
  pendingChangeId?: Id
}

export type Task = {
  _id: Id
  studentId: Id
  courseId?: Id
  deadlineId?: Id
  title: string
  type: TaskType
  status: TaskStatus
  /** ISO 8601 date-time of the planned window start */
  plannedFor?: string
  estEffortMin?: number
  actualEffortMin?: number
  createdBy: TaskCreatedBy
}

/** A before/after pair on one field, as the diff engine emits it. */
export type ChangeField = {
  field: string
  before: string | null
  after: string | null
}

export type Change = {
  _id: Id
  studentId: Id
  courseId?: Id
  deadlineId?: Id
  kind: ChangeKind
  /** one-line summary as the feed shows it */
  summary: string
  fields: ChangeField[]
  origin: ChangeOrigin
  tier: ChangeTier
  status: ChangeStatus
  /** the Core action that produced it — rendered as a tool chip */
  toolLabel: string
  confidence?: number
  snapshotIds: Id[]
  /** ISO 8601 */
  at: string
}

export type Source = {
  _id: Id
  studentId: Id
  kind: SourceKind
  label: string
  /** display-safe config summary; secrets never reach the client */
  detail: string
  /** ISO 8601, or null when it has never run */
  lastPolledAt: string | null
  health: SourceHealth
  /** what the source is currently feeding, for the connector card */
  covers: string[]
  note?: string
}

export type StudentSignalKind =
  | "pacing"
  | "availability"
  | "preference"
  | "difficulty"
  | "life_event"
  | "other"

export type StudentSignal = {
  _id: Id
  studentId: Id
  kind: StudentSignalKind
  /** as observed or told, never aggregated into a score (vision §4b) */
  text: string
  courseId?: Id
  deadlineId?: Id
  taskId?: Id
  origin: "chat" | "workspace" | "web" | "observed"
  observedAt: string
  /** signals are facts too, so they carry provenance like everything else
   * (core.md `studentSignals`; vision §10 "facts, not inference") */
  provenance: Provenance
}

/** The identity Convex sees for the signed-in student (`api.auth.viewer`). */
export type Viewer = {
  subject: string
  issuer: string
  name?: string
  email?: string
} | null
