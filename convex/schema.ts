import { defineSchema, defineTable } from "convex/server"

import {
  changeFields,
  courseFields,
  deadlineFields,
  materialFields,
  planRunFields,
  snapshotFields,
  sourceFields,
  studentFields,
  studentSignalFields,
  taskFields,
  usageFields,
} from "./lib/validators"

/**
 * Core state model — facts only, with provenance (plans/core.md, vision §5/§9).
 *
 * Nothing here stores an inferred score, priority, or importance: sources say
 * what they say, and interpretation belongs to the agent. Every write to a
 * student-facing table goes through `changes` (CLAUDE.md hard constraint).
 */
export default defineSchema({
  students: defineTable(studentFields)
    .index("by_clerkId", ["clerkId"])
    // Voice resolves an inbound iMessage number to its student (voice.md M1 #1).
    .index("by_phone", ["phone"])
    .index("by_status", ["status"]),

  courses: defineTable(courseFields)
    .index("by_student", ["studentId"])
    // Canvas dedupe: exact join on the Canvas course id.
    .index("by_student_canvasCourseId", ["studentId", "sourceRefs.canvasCourseId"]),

  deadlines: defineTable(deadlineFields)
    .index("by_course", ["courseId"])
    .index("by_student_dueAt", ["studentId", "dueAt"])
    // Canvas dedupe: exact join on the Canvas assignment id.
    .index("by_student_canvasAssignmentId", [
      "studentId",
      "externalIds.canvasAssignmentId",
    ])
    // iCal dedupe: Canvas feeds encode `event-assignment-<id>` in the UID.
    .index("by_student_icalUid", ["studentId", "externalIds.icalUid"]),

  tasks: defineTable(taskFields)
    .index("by_student_status", ["studentId", "status"])
    .index("by_deadline", ["deadlineId"]),

  changes: defineTable(changeFields)
    .index("by_student_status", ["studentId", "status"])
    .index("by_student_createdAt", ["studentId", "createdAt"])
    // "has anything landed since the plan was computed?" — the cached nightly
    // snapshot is invalidated by a change resolved after `planRuns.computedAt`.
    .index("by_student_resolvedAt", ["studentId", "resolvedAt"]),

  sources: defineTable(sourceFields)
    .index("by_student", ["studentId"])
    .index("by_kind_enabled", ["kind", "enabled"]),

  // Immutable; written only when the content hash changes.
  snapshots: defineTable(snapshotFields)
    .index("by_source_fetchedAt", ["sourceId", "fetchedAt"])
    .index("by_source_hash", ["sourceId", "contentHash"]),

  materials: defineTable(materialFields)
    .index("by_course", ["courseId"])
    .index("by_course_externalId", ["courseId", "externalId"]),

  usage: defineTable(usageFields).index("by_student_at", ["studentId", "at"]),

  studentSignals: defineTable(studentSignalFields).index("by_student_observedAt", [
    "studentId",
    "observedAt",
  ]),

  planRuns: defineTable(planRunFields)
    .index("by_student_date", ["studentId", "date"])
    .index("by_operationId", ["operationId"]),
})
