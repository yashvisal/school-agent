import { v } from "convex/values"

import type { Doc, Id } from "../_generated/dataModel"
import { internalMutation, internalQuery } from "../_generated/server"
import type { MutationCtx } from "../_generated/server"
import { proposeChangeInternal } from "../lib/changes"
import type { ChangeProposal } from "../lib/diff"
import { toDeadlineFields } from "../lib/diff"
import {
  describeSchedule,
  normalizeScheduleExtraction,
  normalizeSyllabusExtraction,
} from "../lib/extraction/normalize"
import {
  scheduleExtractionSchema,
  syllabusExtractionSchema,
} from "../lib/extraction/schemas"
import { applyProposals, storeSnapshot } from "../lib/ingest"
import { matchExtractedDeadline, normalizeTitle } from "../lib/merge"
import type { ExistingDeadlineRef } from "../lib/merge"
import type { NormalizedDeadline } from "../lib/normalized"
import { localDate } from "../lib/time"

/**
 * The database half of the LLM extraction adapters (core.md "Adapters" #3-5:
 * syllabus PDF, course website, class schedule).
 *
 * Split from the actions on purpose: `ingest/syllabus.ts`, `ingest/site.ts` and
 * `ingest/schedule.ts` all carry `"use node"` (the AI SDK and AnyDoc need the
 * Node runtime), and a `"use node"` module cannot export mutations. Everything
 * that touches the database therefore lives here, in the default runtime, which
 * also means the whole pipeline below is testable with convex-test by handing
 * it a fixture extraction — no gateway key, no network.
 *
 * Two-tier rule: every origin here (`syllabus`, `site`, `schedule`) is an LLM
 * interpretation, so `tierFor` makes every single proposal `needs_approval`.
 * Nothing in this file applies anything; the student's bulk-approve does
 * (core.md "Approval channels", rule 2).
 */

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/**
 * Everything the Node actions need before they can call a model, in one read:
 * the source's (unredacted) config plus the student's timezone and term window.
 *
 * One round trip rather than three, because an action's calls into the database
 * are each their own transaction — three reads is three chances to see a
 * half-updated student.
 */
export const context = internalQuery({
  args: { sourceId: v.id("sources") },
  returns: v.union(
    v.null(),
    v.object({
      sourceId: v.id("sources"),
      studentId: v.id("students"),
      kind: v.string(),
      config: v.any(),
      enabled: v.boolean(),
      timezone: v.string(),
      semesterStart: v.optional(v.string()),
      semesterEnd: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) return null
    const student = await ctx.db.get("students", source.studentId)
    if (!student) return null
    return {
      sourceId: source._id,
      studentId: source.studentId,
      kind: source.kind,
      config: source.config,
      enabled: source.enabled,
      timezone: student.timezone,
      ...(student.semesterStart ? { semesterStart: student.semesterStart } : {}),
      ...(student.semesterEnd ? { semesterEnd: student.semesterEnd } : {}),
    }
  },
})

// ---------------------------------------------------------------------------
// shared result shape
// ---------------------------------------------------------------------------

const documentResultV = v.object({
  snapshotId: v.id("snapshots"),
  /** False when the markdown hashed identically to the last snapshot. */
  created: v.boolean(),
  courseId: v.optional(v.id("courses")),
  proposed: v.number(),
  applied: v.number(),
  pending: v.number(),
  skipped: v.number(),
  /** Items an existing row already covers on the same day — nothing proposed. */
  deduped: v.number(),
  /** Same item, different date: held for approval, never silently applied. */
  conflicts: v.number(),
  /** Extracted deadlines held back because no course could be resolved. */
  deferred: v.number(),
  /** Items normalization refused, with the reason. Surfaced, never silent. */
  dropped: v.array(v.object({ title: v.string(), reason: v.string() })),
})

export type DocumentIngestResult = {
  snapshotId: Id<"snapshots">
  created: boolean
  courseId?: Id<"courses">
  proposed: number
  applied: number
  pending: number
  skipped: number
  deduped: number
  conflicts: number
  deferred: number
  dropped: { title: string; reason: string }[]
}

const emptyResult = (
  snapshotId: Id<"snapshots">,
  created: boolean
): DocumentIngestResult => ({
  snapshotId,
  created,
  proposed: 0,
  applied: 0,
  pending: 0,
  skipped: 0,
  deduped: 0,
  conflicts: 0,
  deferred: 0,
  dropped: [],
})

// ---------------------------------------------------------------------------
// syllabus / site
// ---------------------------------------------------------------------------

/**
 * Ingest one extracted document.
 *
 * `extraction` arrives as `v.any()` and is re-validated against
 * `syllabusExtractionSchema` here rather than trusted from the action. That is
 * not belt-and-braces: it is what lets the eval fixtures (`expected.json`) and
 * the convex-test pipeline tests enter the pipeline at exactly the point the
 * real model's output does, with the same guarantees.
 */
export const ingestDocument = internalMutation({
  args: {
    sourceId: v.id("sources"),
    origin: v.union(v.literal("syllabus"), v.literal("site")),
    /** The stored snapshot payload — `{ kind, markdown, fetchedAt, … }`. */
    payload: v.any(),
    contentHash: v.string(),
    extraction: v.any(),
    /** The course this document is about, when the caller already knows. */
    courseId: v.optional(v.id("courses")),
    /** Re-run against an unchanged document (after approving its new course). */
    force: v.optional(v.boolean()),
  },
  returns: documentResultV,
  handler: async (ctx, args): Promise<DocumentIngestResult> => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) throw new Error("404: source not found")
    const student = await ctx.db.get("students", source.studentId)
    if (!student) throw new Error("404: student not found")

    const parsed = syllabusExtractionSchema.safeParse(args.extraction)
    if (!parsed.success) {
      throw new Error(`ingest.${args.origin}: extraction failed schema validation`)
    }

    const fetchedAt =
      typeof args.payload?.fetchedAt === "number" ? args.payload.fetchedAt : undefined
    const { snapshotId, created } = await storeSnapshot(ctx, {
      sourceId: args.sourceId,
      studentId: source.studentId,
      payload: args.payload,
      contentHash: args.contentHash,
      label: args.origin,
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
    })
    if (!created && !args.force) return emptyResult(snapshotId, false)

    const normalized = normalizeSyllabusExtraction({
      extraction: parsed.data,
      timezone: student.timezone,
      source: args.origin,
      ...(student.semesterStart || student.semesterEnd
        ? {
            semester: {
              ...(student.semesterStart ? { start: student.semesterStart } : {}),
              ...(student.semesterEnd ? { end: student.semesterEnd } : {}),
            },
          }
        : {}),
    })

    const courseId = await resolveCourse(ctx, {
      studentId: source.studentId,
      explicit: args.courseId,
      course: normalized.course,
    })

    const result = emptyResult(snapshotId, created)
    result.dropped = normalized.dropped

    // No course to hang anything on. The grading scheme and the course itself
    // still become a proposal (the student approves it, and re-running the
    // upload then lands the deadlines), but the deadlines are HELD rather than
    // dropped: `applyProposals` would silently skip a `deadline_added` with no
    // course, and a silently skipped deadline is exactly the failure this
    // adapter exists to prevent. The caller reports `deferred` on source health.
    if (!courseId) {
      const outcome = await proposeChangeInternal(ctx, {
        studentId: source.studentId,
        kind: "course_added",
        entity: { table: "courses" },
        after: {
          name: normalized.course.name,
          ...(normalized.course.code ? { code: normalized.course.code } : {}),
          sourceRefs:
            args.origin === "site" && typeof args.payload?.url === "string"
              ? { siteUrl: args.payload.url }
              : {},
          ...(normalized.course.gradingScheme
            ? { gradingScheme: normalized.course.gradingScheme }
            : {}),
          status: "active",
          provenance: {
            source: args.origin,
            sourceRef: normalized.course.code ?? normalized.course.name,
            snapshotId,
          },
        },
        origin: args.origin,
        snapshotIds: [snapshotId],
        reason:
          `This ${args.origin === "site" ? "course site" : "syllabus"} is for ` +
          `"${normalized.course.name}", which isn't in your courses yet. ` +
          `Approve it and re-upload to pull in its ${normalized.deadlines.length} deadlines.`,
      })
      result.proposed = 1
      if (outcome.status === "pending") result.pending = 1
      else result.applied = 1
      result.deferred = normalized.deadlines.length
      return result
    }

    result.courseId = courseId

    const proposals: ChangeProposal[] = []
    const courseKey = `${args.origin}:course:${courseId}`
    const courseIds = new Map<string, Id<"courses">>([[courseKey, courseId]])

    // Merge precedence: the syllabus outranks Canvas for the GRADING SCHEME and
    // nothing else (core.md "Merge precedence"). So the course proposal carries
    // the scheme alone — not the name, not the code, not a provenance stamp that
    // would relabel a Canvas-sourced course as syllabus-sourced.
    if (normalized.course.gradingScheme) {
      proposals.push({
        kind: "course_updated",
        entity: "courses",
        key: courseKey,
        courseKey,
        entityId: courseId,
        after: { gradingScheme: normalized.course.gradingScheme },
        reason: `Grading scheme as the ${args.origin === "site" ? "course site" : "syllabus"} states it.`,
      })
    }

    const existing = await existingRefsForCourse(ctx, courseId)
    const sameDay = (a: number, b: number) =>
      localDate(a, student.timezone) === localDate(b, student.timezone)

    for (const deadline of normalized.deadlines) {
      const match = matchExtractedDeadline(deadline, existing, sameDay)
      if (match.outcome === "duplicate") {
        result.deduped++
        continue
      }
      if (match.outcome === "moved") {
        result.conflicts++
        proposals.push({
          kind: "deadline_moved",
          entity: "deadlines",
          key: deadline.key,
          courseKey,
          entityId: match.existing.key,
          before: { dueAt: match.existing.dueAt },
          after: { dueAt: deadline.dueAt, provenance: deadline.provenance },
          conflict: true,
          reason: movedReason(args.origin, deadline, match.existing),
        })
        continue
      }
      proposals.push({
        kind: "deadline_added",
        entity: "deadlines",
        key: deadline.key,
        courseKey,
        after: toDeadlineFields(deadline),
      })
    }

    const outcome = await applyProposals(ctx, {
      studentId: source.studentId,
      proposals,
      origin: args.origin,
      snapshotId,
      snapshotIds: [snapshotId],
      courseIds,
      fallbackCourseId: courseId,
    })

    return { ...result, ...outcome }
  },
})

function movedReason(
  origin: "syllabus" | "site",
  deadline: NormalizedDeadline,
  existing: ExistingDeadlineRef
): string {
  const what = origin === "site" ? "The course site" : "The syllabus"
  const to = deadline.dueAt !== undefined ? new Date(deadline.dueAt).toISOString() : "no date"
  if (existing.dueAt === undefined) {
    return `${what} gives "${existing.title}" a due date (${to}) that the row does not have. Confirm before it moves.`
  }
  return (
    `${what} says "${existing.title}" is due ${to}, but the row says ` +
    `${new Date(existing.dueAt).toISOString()}. Confirm which is right.`
  )
}

/**
 * Which course this document is about.
 *
 * Order: what the uploader said, then the course code (the one thing a syllabus
 * states unambiguously), then the course name. Never a fuzzy near-match — a
 * syllabus filed under the wrong course puts every one of its deadlines in the
 * wrong place, and an unresolved course is a question we can ask.
 */
/**
 * A course code with ALL separators removed: "CS103", "CS 103", "cs-103" and
 * "CS  103" are one code. Deliberately harsher than `normalizeTitle`, which
 * keeps word boundaries — a syllabus header and a Canvas course rarely agree on
 * the space, and treating them as different codes files the syllabus nowhere.
 */
const codeKey = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, "")

async function resolveCourse(
  ctx: MutationCtx,
  input: {
    studentId: Id<"students">
    explicit?: Id<"courses">
    course: { name: string; code?: string }
  }
): Promise<Id<"courses"> | undefined> {
  if (input.explicit) {
    const doc = await ctx.db.get("courses", input.explicit)
    // Tenancy: `courseId` reaches this through a public upload mutation, so an
    // id from another student must never resolve (see lib/changes.ts).
    if (!doc || doc.studentId !== input.studentId) {
      throw new Error("403: course does not belong to student")
    }
    return doc._id
  }

  const courses = await ctx.db
    .query("courses")
    .withIndex("by_student", (q) => q.eq("studentId", input.studentId))
    .take(200)

  if (input.course.code) {
    const code = codeKey(input.course.code)
    const hit = courses.find((course) => course.code && codeKey(course.code) === code)
    if (hit) return hit._id
  }
  const name = normalizeTitle(input.course.name)
  const hit = courses.find((course) => normalizeTitle(course.name) === name)
  return hit?._id
}

/**
 * The course's stored deadlines, projected for matching. Scoped to ONE course:
 * "Problem Set 3" exists in half the student's courses, and a title match across
 * them would suppress real work (see `matchExtractedDeadline`).
 */
async function existingRefsForCourse(
  ctx: MutationCtx,
  courseId: Id<"courses">,
  limit = 500
): Promise<ExistingDeadlineRef[]> {
  const rows = await ctx.db
    .query("deadlines")
    .withIndex("by_course", (q) => q.eq("courseId", courseId))
    .take(limit)
  return rows
    .filter((row: Doc<"deadlines">) => row.status === "active")
    .map((row) => ({
      key: row._id,
      ...(row.externalIds.canvasAssignmentId
        ? { canvasAssignmentId: row.externalIds.canvasAssignmentId }
        : {}),
      ...(row.externalIds.icalUid ? { icalUid: row.externalIds.icalUid } : {}),
      title: row.title,
      ...(row.dueAt !== undefined ? { dueAt: row.dueAt } : {}),
    }))
}

// ---------------------------------------------------------------------------
// class schedule
// ---------------------------------------------------------------------------

const scheduleResultV = v.object({
  snapshotId: v.id("snapshots"),
  created: v.boolean(),
  changeId: v.optional(v.id("changes")),
  blocks: v.number(),
  dropped: v.array(v.object({ title: v.string(), reason: v.string() })),
})

export type ScheduleIngestResult = {
  snapshotId: Id<"snapshots">
  created: boolean
  changeId?: Id<"changes">
  blocks: number
  dropped: { title: string; reason: string }[]
}

/**
 * One upload → ONE `availability_updated` change carrying the whole weekly grid
 * (core.md "Adapters" #5: "→ `needs_approval` (student verifies the parse in a
 * simple weekly view) → becomes the planner's class boundaries").
 *
 * One change, not one per block, because the grid is only meaningful whole: a
 * student approving four of five class blocks would leave the planner free to
 * schedule work over the fifth, which is the exact failure the hard-constraint
 * guarantee exists to prevent.
 */
export const ingestSchedule = internalMutation({
  args: {
    sourceId: v.id("sources"),
    payload: v.any(),
    contentHash: v.string(),
    extraction: v.any(),
    force: v.optional(v.boolean()),
  },
  returns: scheduleResultV,
  handler: async (ctx, args): Promise<ScheduleIngestResult> => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) throw new Error("404: source not found")
    const student = await ctx.db.get("students", source.studentId)
    if (!student) throw new Error("404: student not found")

    const parsed = scheduleExtractionSchema.safeParse(args.extraction)
    if (!parsed.success) {
      throw new Error("ingest.schedule: extraction failed schema validation")
    }

    const fetchedAt =
      typeof args.payload?.fetchedAt === "number" ? args.payload.fetchedAt : undefined
    const { snapshotId, created } = await storeSnapshot(ctx, {
      sourceId: args.sourceId,
      studentId: source.studentId,
      payload: args.payload,
      contentHash: args.contentHash,
      label: "schedule",
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
    })
    if (!created && !args.force) {
      return { snapshotId, created: false, blocks: 0, dropped: [] }
    }

    const { blocks, dropped, minConfidence } = normalizeScheduleExtraction(parsed.data)

    // An upload that yielded nothing must not propose an EMPTY grid: applying it
    // would wipe the class blocks the student already confirmed and hand the
    // planner a week with no classes in it.
    if (blocks.length === 0) {
      return { snapshotId, created, blocks: 0, dropped }
    }

    const outcome = await proposeChangeInternal(ctx, {
      studentId: source.studentId,
      kind: "availability_updated",
      entity: { table: "students", id: source.studentId },
      before: { classBlocks: student.classBlocks },
      after: { classBlocks: blocks },
      origin: "schedule",
      snapshotIds: [snapshotId],
      reason:
        describeSchedule(blocks) +
        (parsed.data.timezoneNote ? ` The upload notes: "${parsed.data.timezoneNote}".` : "") +
        (minConfidence !== undefined && minConfidence < 0.8
          ? ` Lowest block confidence was ${minConfidence.toFixed(2)} — check it closely.`
          : "") +
        (dropped.length > 0
          ? ` ${dropped.length} block(s) were unreadable and left out.`
          : ""),
    })

    return {
      snapshotId,
      created,
      changeId: outcome.changeId,
      blocks: blocks.length,
      dropped,
    }
  },
})
