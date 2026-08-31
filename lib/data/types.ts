import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"

/**
 * The Face **view-model** — what panels render, produced by the adapter in
 * `hooks.ts` from Core's Convex docs (`convex/lib/validators.ts` is the stored
 * truth; `Doc<"courses">` &c. come from codegen).
 *
 * This file was originally a stand-in "until the schema lands" slated for
 * deletion; the schema landed, and it stays — deliberately — because several
 * fields here are *presentation*, not storage: `accent`, `Change.summary` /
 * `fields[]` / `toolLabel`, `Source.label` / `detail` / `covers`, the flat
 * `health` enum, ISO date strings. `hooks.ts` derives all of them per render.
 *
 * Two rules from the plan remain load-bearing:
 *  - **facts, not inference** (vision §9): nothing derived is *stored* on a
 *    record. Everything derived lives in the hook mapping, recomputable.
 *  - **provenance on every fact** (core.md): `source`, `sourceRef`,
 *    `confidence`, `snapshotId`. The UI shows it on click; absent means
 *    unknown, never zero.
 */

export type Id = string

/* ── enums, exactly as core.md states them ──────────────────────────────── */

export type SourceKind =
  | "canvas"
  | "ical"
  | "syllabus"
  | "site"
  | "schedule"
  | "calendar"

/** `changes.origin` — mirrors Core's `sourceKindV` */
export type ChangeOrigin =
  | "canvas"
  | "ical"
  | "syllabus"
  | "site"
  | "chat"
  | "manual"
  | "schedule"

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
  | "deadline_updated"
  | "submitted"
  | "grade_posted"
  | "course_added"
  | "course_updated"
  | "task_created"
  | "task_updated"
  | "availability_updated"
  | "chat_decision"
  | "other"
  /** legacy fixture-only kind; Core emits `course_updated` for scheme parses */
  | "grading_scheme_parsed"

/** two-tier apply rule (core.md "Two-tier apply rule") */
export type ChangeTier = "auto" | "needs_approval"

export type ChangeStatus =
  | "applied"
  | "pending"
  | "approved"
  | "rejected"
  | "expired"

export type SourceHealth = "healthy" | "degraded" | "failing" | "never_synced"

export type CourseStatus = "active" | "concluded" | "hidden"

/* ── provenance ─────────────────────────────────────────────────────────── */

/** Every fact carries this. Rendered by the provenance popover. */
export type Provenance = {
  source: ChangeOrigin
  /** the thing in the source this came from: a Canvas id, a page ref, a URL */
  sourceRef: string
  /** 0–1. Structured sources are 1; LLM extraction is whatever it reported.
   * Absent means UNKNOWN — never render it as 0. */
  confidence?: number
  snapshotId?: Id
  /** when the snapshot this fact came from was fetched (ISO 8601); absent when
   * Core has no observation timestamp for it */
  observedAt?: string
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
  submissionStatus?:
    | "submitted"
    | "unsubmitted"
    | "graded"
    | "missing"
    | "excused"
    | "unknown"
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

/**
 * The signed-in student as Core returns it (`api.auth.viewer`; null when signed
 * out). Derived from codegen so Face can never drift from Core's shape again.
 */
export type Viewer = FunctionReturnType<typeof api.auth.viewer>
