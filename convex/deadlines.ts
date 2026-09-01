import { v } from "convex/values"

import type { Id } from "./_generated/dataModel"
import { query } from "./_generated/server"
import { getCurrentStudent } from "./lib/auth"
import { deadlineDocV } from "./lib/validators"

/**
 * Deadline reads for Face (lib/data/README.md). Identity-scoped.
 *
 * Each row is annotated with `pendingChangeId` — the open (`pending`) change
 * touching that deadline, if any — so Semester/Dashboard can highlight
 * moved/added/pending without a second round trip. Derived here, never stored
 * (vision §9): the truth is the `changes` row.
 */

const annotatedDeadlineV = v.object({
  ...deadlineDocV.fields,
  pendingChangeId: v.optional(v.id("changes")),
})

/** How many pending changes we scan for annotations; the queue is meant to drain. */
const PENDING_SCAN = 500

export const list = query({
  args: {
    /** ms since epoch, inclusive. Absent → no lower bound. */
    from: v.optional(v.number()),
    /** ms since epoch, inclusive. Absent → no upper bound. */
    to: v.optional(v.number()),
    courseId: v.optional(v.id("courses")),
  },
  returns: v.array(annotatedDeadlineV),
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) return []

    const rows = await ctx.db
      .query("deadlines")
      .withIndex("by_student_dueAt", (q) => {
        const base = q.eq("studentId", student._id)
        if (args.from !== undefined && args.to !== undefined)
          return base.gte("dueAt", args.from).lte("dueAt", args.to)
        if (args.from !== undefined) return base.gte("dueAt", args.from)
        if (args.to !== undefined) return base.lte("dueAt", args.to)
        return base
      })
      .take(2000)

    const pending = await ctx.db
      .query("changes")
      .withIndex("by_student_status", (q) =>
        q.eq("studentId", student._id).eq("status", "pending")
      )
      .take(PENDING_SCAN)
    const pendingByDeadline = new Map<string, Id<"changes">>()
    for (const change of pending) {
      if (change.entity.table === "deadlines" && change.entity.id) {
        pendingByDeadline.set(change.entity.id, change._id)
      }
    }

    return rows
      .filter(
        (d) =>
          d.status === "active" &&
          (args.courseId === undefined || d.courseId === args.courseId)
      )
      .map((d) => {
        const pendingChangeId = pendingByDeadline.get(d._id)
        return {
          ...d,
          ...(pendingChangeId !== undefined ? { pendingChangeId } : {}),
        }
      })
  },
})
