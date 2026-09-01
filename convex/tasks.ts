import { v } from "convex/values"

import { query } from "./_generated/server"
import { getCurrentStudent } from "./lib/auth"
import { taskDocV } from "./lib/validators"

/**
 * Task reads for Face (lib/data/README.md). Identity-scoped.
 *
 * Serves the whole active set rather than a `from`/`to` window — resolving the
 * README's windowing question the simple way: a semester's tasks are a few
 * hundred rows at most, `plannedFor` is a calendar-date string, and Face
 * windows client-side.
 */
export const list = query({
  args: { courseId: v.optional(v.id("courses")) },
  returns: v.array(taskDocV),
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) return []
    const rows = await ctx.db
      .query("tasks")
      .withIndex("by_student_status", (q) => q.eq("studentId", student._id))
      .take(1000)
    return args.courseId === undefined
      ? rows
      : rows.filter((t) => t.courseId === args.courseId)
  },
})
