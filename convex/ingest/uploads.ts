import { v } from "convex/values"

import { internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import { mutation } from "../_generated/server"
import { getCurrentStudent } from "../lib/auth"

/**
 * The public entry point for uploaded documents (core.md "Adapters" #3 and #5:
 * syllabus PDF, class schedule) — the two adapters a student drives by hand
 * rather than by polling.
 *
 * Two mutations, both scoped entirely by `ctx.auth`:
 *   `generateUploadUrl()` — a short-lived Convex storage upload URL for Face.
 *   `start({ kind, storageId, courseId? })` — registers (or reuses) the source
 *   row and schedules the right Node action.
 *
 * There is no `studentId` argument anywhere here, deliberately. The student is
 * derived from the signed-in identity; a `studentId` parameter would let any
 * signed-in user file a document — and its extracted deadlines — into someone
 * else's account. `courseId` IS a parameter, because it is a *selector*, and it
 * is proven to belong to the caller before it is stored.
 */

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const student = await getCurrentStudent(ctx)
    if (!student) {
      throw new Error("404: no student for this identity; call students.ensure")
    }
    return await ctx.storage.generateUploadUrl()
  },
})

export const start = mutation({
  args: {
    kind: v.union(v.literal("syllabus"), v.literal("schedule")),
    storageId: v.id("_storage"),
    /** Which course this syllabus is for. Ignored for a schedule upload. */
    courseId: v.optional(v.id("courses")),
    filename: v.optional(v.string()),
  },
  returns: v.object({ sourceId: v.id("sources") }),
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) {
      throw new Error("404: no student for this identity; call students.ensure")
    }

    let courseId: Id<"courses"> | undefined
    if (args.kind === "syllabus" && args.courseId) {
      const course = await ctx.db.get("courses", args.courseId)
      // Ownership on the *document* the id points at, not just "is someone
      // signed in" — otherwise a guessed id files a syllabus into another
      // student's course.
      if (!course || course.studentId !== student._id) {
        throw new Error("403: course does not belong to you")
      }
      courseId = course._id
    }

    // One source row per (kind, course) rather than one per upload, so a
    // re-uploaded syllabus lands in the SAME source and its markdown snapshot
    // diffs against the previous one. A per-upload source would make every
    // revision look like a first sighting and re-propose every deadline.
    // Unassigned syllabi are keyed PER UPLOAD: one shared "unassigned" key
    // would make the second no-course upload patch over the first one's
    // storageId and diff against an unrelated document (CR 3898632520). Once a
    // course is known, the per-course key restores re-upload-diffs-in-place.
    const identity =
      args.kind === "schedule"
        ? "schedule"
        : `syllabus:${courseId ?? `unassigned:${args.storageId}`}`

    const existing = await ctx.db
      .query("sources")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(200)
    const match = existing.find(
      (source) => source.kind === args.kind && identityKeyOf(source.config) === identity
    )

    const config = {
      identity,
      storageId: args.storageId,
      ...(courseId ? { courseId } : {}),
      ...(args.filename ? { filename: args.filename } : {}),
    }

    let sourceId: Id<"sources">
    if (match) {
      await ctx.db.patch("sources", match._id, { config, enabled: true })
      sourceId = match._id
    } else {
      sourceId = await ctx.db.insert("sources", {
        studentId: student._id,
        kind: args.kind,
        config,
        enabled: true,
        health: { status: "unknown", at: Date.now() },
      })
    }

    // Scheduled, not awaited: extraction is a model call plus a document
    // conversion, and the upload request should not hold a transaction open for
    // either. Face watches `sources.health` and the change feed for the result.
    if (args.kind === "syllabus") {
      await ctx.scheduler.runAfter(0, internal.ingest.syllabus.run, {
        sourceId,
        storageId: args.storageId,
        ...(courseId ? { courseId } : {}),
        ...(args.filename ? { filename: args.filename } : {}),
      })
    } else {
      await ctx.scheduler.runAfter(0, internal.ingest.schedule.run, {
        sourceId,
        storageId: args.storageId,
        ...(args.filename ? { filename: args.filename } : {}),
      })
    }

    return { sourceId }
  },
})

const identityKeyOf = (config: unknown): string | undefined => {
  const value =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).identity
      : undefined
  return typeof value === "string" ? value : undefined
}
