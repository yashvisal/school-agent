import { v } from "convex/values"

import { query } from "./_generated/server"
import { getCurrentStudent, requireStudent } from "./lib/auth"
import { courseDocV, courseStatusV } from "./lib/validators"

/**
 * Course reads for Face (lib/data/README.md). Identity-scoped: the student is
 * always the signed-in one — Face never passes a studentId. A signed-out or
 * not-yet-provisioned identity gets an empty list, which renders as a loading→
 * empty shell rather than an error.
 */

export const list = query({
  args: { status: v.optional(courseStatusV) },
  returns: v.array(courseDocV),
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) return []
    const courses = await ctx.db
      .query("courses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(200)
    // `hidden` (unpublished shells &c.) never reaches the UI unless asked for.
    return courses.filter((c) =>
      args.status === undefined ? c.status !== "hidden" : c.status === args.status
    )
  },
})

/** One course, for `/courses/[courseId]`. 403s on someone else's course. */
export const get = query({
  args: { courseId: v.id("courses") },
  returns: v.union(v.null(), courseDocV),
  handler: async (ctx, args) => {
    const course = await ctx.db.get("courses", args.courseId)
    if (!course) return null
    await requireStudent(ctx, course.studentId)
    return course
  },
})
