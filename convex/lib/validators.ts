import { v } from "convex/values"

/**
 * Shared validators for the Core schema (plans/core.md, "State model").
 *
 * Conventions:
 * - Timestamps (`*At`, `createdAt`, `observedAt`) are ms since epoch — `v.number()`.
 * - Calendar dates are `"YYYY-MM-DD"` strings in the student's timezone.
 * - Times of day are minutes-from-midnight in the student's timezone.
 *
 * Table field shapes are exported as plain objects (`studentFields`, …) so that
 * `schema.ts` can build the table and functions can build matching document
 * return validators without redeclaring fields.
 */

// ---------------------------------------------------------------------------
// Enums / unions
// ---------------------------------------------------------------------------

/** Where a fact came from. */
export const sourceKindV = v.union(
  v.literal("canvas"),
  v.literal("ical"),
  v.literal("syllabus"),
  v.literal("site"),
  v.literal("chat"),
  v.literal("manual"),
  v.literal("schedule")
)

/** Origin of a change — same set as `sourceKindV`; the two-tier rule keys off it. */
export const originV = sourceKindV

export const provenanceV = v.object({
  source: sourceKindV,
  sourceRef: v.string(),
  /** 0..1. Structured sources are 1; LLM extraction carries the model's confidence. */
  confidence: v.number(),
  snapshotId: v.optional(v.id("snapshots")),
})

/** A block on the weekly grid. 0 = Sunday. Minutes from local midnight. */
export const timeBlockV = v.object({
  dayOfWeek: v.number(),
  startMin: v.number(),
  endMin: v.number(),
  label: v.optional(v.string()),
  courseId: v.optional(v.id("courses")),
})

export const availabilityV = v.object({
  weekly: v.array(timeBlockV),
  exceptions: v.array(
    v.object({
      date: v.string(),
      blocks: v.array(timeBlockV),
    })
  ),
})

export const studentStatusV = v.union(v.literal("active"), v.literal("paused"))

export const courseStatusV = v.union(
  v.literal("active"),
  v.literal("concluded"),
  v.literal("hidden")
)

export const deadlineKindV = v.union(
  v.literal("homework"),
  v.literal("project"),
  v.literal("exam"),
  v.literal("quiz"),
  v.literal("reading"),
  v.literal("other")
)

export const submissionStatusV = v.union(
  v.literal("unsubmitted"),
  v.literal("submitted"),
  v.literal("graded"),
  v.literal("missing"),
  v.literal("excused"),
  v.literal("unknown")
)

export const deadlineStatusV = v.union(v.literal("active"), v.literal("removed"))

export const taskTypeV = v.union(v.literal("do"), v.literal("prepared"))

export const taskStatusV = v.union(
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("skipped")
)

export const effortConfidenceV = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high")
)

export const createdByV = v.union(v.literal("agent"), v.literal("student"))

export const changeKindV = v.union(
  v.literal("deadline_added"),
  v.literal("deadline_moved"),
  v.literal("deadline_removed"),
  v.literal("deadline_updated"),
  v.literal("submitted"),
  v.literal("grade_posted"),
  v.literal("course_added"),
  v.literal("course_updated"),
  v.literal("task_created"),
  v.literal("task_updated"),
  v.literal("availability_updated"),
  v.literal("chat_decision"),
  v.literal("other")
)

export const entityTableV = v.union(
  v.literal("deadlines"),
  v.literal("courses"),
  v.literal("tasks"),
  v.literal("students")
)

export const changeEntityV = v.object({
  table: entityTableV,
  /** Set once the entity exists; `deadline_added` fills it in on apply. */
  id: v.optional(v.string()),
})

export const tierV = v.union(v.literal("auto"), v.literal("needs_approval"))

export const changeStatusV = v.union(
  v.literal("applied"),
  v.literal("pending"),
  v.literal("approved"),
  v.literal("rejected"),
  v.literal("expired")
)

export const resolvedViaV = v.union(
  v.literal("chat"),
  v.literal("web"),
  v.literal("auto"),
  v.literal("expired")
)

export const sourceConfigKindV = v.union(
  v.literal("canvas"),
  v.literal("ical"),
  v.literal("syllabus"),
  v.literal("site"),
  v.literal("schedule"),
  v.literal("calendar")
)

export const sourceHealthV = v.object({
  status: v.union(
    v.literal("ok"),
    v.literal("error"),
    v.literal("stale"),
    v.literal("unknown")
  ),
  message: v.optional(v.string()),
  at: v.number(),
})

export const materialKindV = v.union(
  v.literal("file"),
  v.literal("module"),
  v.literal("page"),
  v.literal("announcement")
)

export const surfaceV = v.union(
  v.literal("voice"),
  v.literal("workspace"),
  v.literal("ingestion"),
  v.literal("planner")
)

export const signalKindV = v.union(
  v.literal("pacing"),
  v.literal("availability"),
  v.literal("preference"),
  v.literal("difficulty"),
  v.literal("life_event"),
  v.literal("other")
)

export const signalOriginV = v.union(
  v.literal("chat"),
  v.literal("workspace"),
  v.literal("web"),
  v.literal("observed")
)

export const triggerStatusV = v.union(
  v.literal("pending"),
  v.literal("triggered"),
  v.literal("failed"),
  v.literal("skipped")
)

export const gradingSchemeV = v.object({
  categories: v.array(
    v.object({
      name: v.string(),
      weight: v.optional(v.number()),
      dropLowest: v.optional(v.number()),
      canvasGroupId: v.optional(v.string()),
    })
  ),
  notes: v.optional(v.string()),
})

// ---------------------------------------------------------------------------
// Table field shapes
// ---------------------------------------------------------------------------

export const studentFields = {
  clerkId: v.string(),
  /** IANA zone, e.g. "America/New_York". */
  timezone: v.string(),
  phone: v.optional(v.string()),
  semesterStart: v.optional(v.string()),
  semesterEnd: v.optional(v.string()),
  /** Hard class blocks — the planner never proposes a window overlapping these. */
  classBlocks: v.array(timeBlockV),
  availability: availabilityV,
  status: studentStatusV,
  /** Local hour (0-23) the nightly precompute + Voice trigger should run. */
  nightlyHourLocal: v.optional(v.number()),
}

export const courseFields = {
  studentId: v.id("students"),
  name: v.string(),
  code: v.optional(v.string()),
  sourceRefs: v.object({
    canvasCourseId: v.optional(v.string()),
    icalUrl: v.optional(v.string()),
    siteUrl: v.optional(v.string()),
  }),
  gradingScheme: v.optional(gradingSchemeV),
  status: courseStatusV,
  provenance: provenanceV,
}

export const deadlineFields = {
  studentId: v.id("students"),
  courseId: v.id("courses"),
  title: v.string(),
  kind: deadlineKindV,
  dueAt: v.optional(v.number()),
  pointsPossible: v.optional(v.number()),
  category: v.optional(v.string()),
  submissionStatus: submissionStatusV,
  score: v.optional(v.number()),
  description: v.optional(v.string()),
  url: v.optional(v.string()),
  externalIds: v.object({
    canvasAssignmentId: v.optional(v.string()),
    icalUid: v.optional(v.string()),
  }),
  provenance: provenanceV,
  status: deadlineStatusV,
}

export const taskFields = {
  studentId: v.id("students"),
  courseId: v.optional(v.id("courses")),
  deadlineId: v.optional(v.id("deadlines")),
  title: v.string(),
  type: taskTypeV,
  status: taskStatusV,
  /** "YYYY-MM-DD" in the student's timezone. */
  plannedFor: v.optional(v.string()),
  plannedStartMin: v.optional(v.number()),
  estEffortMin: v.optional(v.number()),
  estEffortConfidence: v.optional(effortConfidenceV),
  actualEffortMin: v.optional(v.number()),
  createdBy: createdByV,
}

export const changeFields = {
  studentId: v.id("students"),
  courseId: v.optional(v.id("courses")),
  kind: changeKindV,
  entity: changeEntityV,
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  origin: originV,
  tier: tierV,
  status: changeStatusV,
  snapshotIds: v.array(v.id("snapshots")),
  reason: v.optional(v.string()),
  conflict: v.optional(v.boolean()),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
  resolvedVia: v.optional(resolvedViaV),
}

export const sourceFields = {
  studentId: v.id("students"),
  kind: sourceConfigKindV,
  /** e.g. `{ baseUrl, token }`, `{ url }`, `{ courseId }`. */
  config: v.any(),
  enabled: v.boolean(),
  lastPolledAt: v.optional(v.number()),
  health: sourceHealthV,
}

export const snapshotFields = {
  sourceId: v.id("sources"),
  studentId: v.id("students"),
  fetchedAt: v.number(),
  contentHash: v.string(),
  payload: v.any(),
  label: v.optional(v.string()),
}

export const materialFields = {
  studentId: v.id("students"),
  courseId: v.id("courses"),
  kind: materialKindV,
  title: v.string(),
  externalId: v.string(),
  storageId: v.optional(v.id("_storage")),
  raw: v.any(),
  provenance: provenanceV,
}

export const usageFields = {
  studentId: v.optional(v.id("students")),
  surface: surfaceV,
  model: v.string(),
  promptTokens: v.number(),
  completionTokens: v.number(),
  costUsd: v.optional(v.number()),
  sessionId: v.optional(v.string()),
  at: v.number(),
}

export const studentSignalFields = {
  studentId: v.id("students"),
  kind: signalKindV,
  /** As observed or told — never aggregated into a stored score (vision §4b). */
  text: v.string(),
  refs: v.object({
    courseId: v.optional(v.id("courses")),
    deadlineId: v.optional(v.id("deadlines")),
    taskId: v.optional(v.id("tasks")),
  }),
  origin: signalOriginV,
  observedAt: v.number(),
  provenance: provenanceV,
}

export const planRunFields = {
  studentId: v.id("students"),
  /** Target day, "YYYY-MM-DD". */
  date: v.string(),
  computedAt: v.number(),
  feasible: v.any(),
  pendingAnnotations: v.any(),
  signalsDigest: v.any(),
  /** Idempotency key for the eve Voice session trigger. */
  operationId: v.string(),
  voiceSessionId: v.optional(v.string()),
  triggerStatus: triggerStatusV,
  error: v.optional(v.string()),
}

// ---------------------------------------------------------------------------
// Document validators (fields + system fields), for `returns` on queries
// ---------------------------------------------------------------------------

export const studentDocV = v.object({
  _id: v.id("students"),
  _creationTime: v.number(),
  ...studentFields,
})

export const courseDocV = v.object({
  _id: v.id("courses"),
  _creationTime: v.number(),
  ...courseFields,
})

export const deadlineDocV = v.object({
  _id: v.id("deadlines"),
  _creationTime: v.number(),
  ...deadlineFields,
})

export const taskDocV = v.object({
  _id: v.id("tasks"),
  _creationTime: v.number(),
  ...taskFields,
})

export const changeDocV = v.object({
  _id: v.id("changes"),
  _creationTime: v.number(),
  ...changeFields,
})
