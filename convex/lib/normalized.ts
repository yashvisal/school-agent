import type { Infer } from "convex/values"

import type {
  courseStatusV,
  deadlineKindV,
  gradingSchemeV,
  materialKindV,
  provenanceV,
  submissionStatusV,
} from "./validators"

/**
 * The adapter-neutral shape every ingestion adapter normalizes into, and the
 * only thing `diff.ts` compares. Deliberately *not* the Convex document shape:
 * it carries stable external keys instead of `Id<...>`, so the diff is a pure
 * function of two snapshots with no database access (plans/core.md,
 * "Snapshot → diff → changes").
 *
 * Facts only, with provenance (vision §9). Nothing here is inferred.
 */

export type Provenance = Infer<typeof provenanceV>
export type DeadlineKind = Infer<typeof deadlineKindV>
export type SubmissionStatus = Infer<typeof submissionStatusV>
export type CourseStatus = Infer<typeof courseStatusV>
export type GradingScheme = Infer<typeof gradingSchemeV>
export type MaterialKind = Infer<typeof materialKindV>

/** `canvas:<courseId>` — stable across polls, unique per source. */
export type CourseKey = string
/** `canvas:<assignmentId>` or `ical:<uid>`. */
export type DeadlineKey = string

export type NormalizedCourse = {
  key: CourseKey
  name: string
  code?: string
  sourceRefs: {
    canvasCourseId?: string
    icalUrl?: string
    siteUrl?: string
  }
  gradingScheme?: GradingScheme
  status: CourseStatus
  provenance: Provenance
}

export type NormalizedDeadline = {
  key: DeadlineKey
  /** Absent for feeds that don't name a course (a bare `.ics`). */
  courseKey?: CourseKey
  /** Course code parsed out of an iCal SUMMARY like `Pset 3 [CS201]`. */
  courseCode?: string
  title: string
  kind: DeadlineKind
  /** ms since epoch. Absent when the source says there is no due date. */
  dueAt?: number
  pointsPossible?: number
  category?: string
  submissionStatus: SubmissionStatus
  score?: number
  description?: string
  url?: string
  externalIds: {
    canvasAssignmentId?: string
    icalUid?: string
  }
  provenance: Provenance
}

export type NormalizedMaterial = {
  courseKey: CourseKey
  kind: MaterialKind
  title: string
  /** Unique within the course, e.g. `file-8001`, `page-office-hours`. */
  externalId: string
  raw: unknown
  provenance: Provenance
}

/**
 * A class meeting from a calendar feed. NOT a deadline — it belongs to the
 * student's hard class blocks, which the schedule adapter owns (core.md
 * "Adapters" #5). Ingestion leaves these in the snapshot for it to pick up.
 */
export type NormalizedClassEvent = {
  key: string
  title: string
  courseCode?: string
  startAt: number
  endAt?: number
  allDay: boolean
  location?: string
  externalIds: { icalUid?: string }
  provenance: Provenance
}

export type NormalizedState = {
  courses: NormalizedCourse[]
  deadlines: NormalizedDeadline[]
  materials: NormalizedMaterial[]
}

export const emptyNormalizedState = (): NormalizedState => ({
  courses: [],
  deadlines: [],
  materials: [],
})
