import { v } from "convex/values"

import { mutation, query } from "./_generated/server"
import { requireStudent } from "./lib/auth"
import { approveChangeInternal, proposeChangeInternal } from "./lib/changes"
import { deadlineDocV } from "./lib/validators"

/**
 * Mid-semester onboarding (plans/core.md "Mid-semester onboarding", vision §3.6).
 *
 * A student joining in week 7 arrives with a backlog of past-due deadlines the
 * sources can't fully settle: Canvas marks what was submitted through it, but
 * paper homework, in-class quizzes, and half-used Canvas courses leave rows at
 * `unsubmitted`/`unknown`. Asking about them one by one is the Notion-template
 * death (vision §3.1); planning around them as open work poisons the feasible
 * set. So: everything Canvas already answered stays answered, and the rest gets
 * ONE prompt — "assume these N are done?" — resolved in bulk here.
 */

const PAST_STATUSES = ["unsubmitted", "unknown"] as const

/**
 * The past-due deadlines only the student can settle. Canvas-submitted rows
 * never appear (their status is already a fact); active rows only.
 */
export const pastDeadlineReview = query({
  args: { studentId: v.id("students") },
  returns: v.object({
    deadlines: v.array(deadlineDocV),
    count: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireStudent(ctx, args.studentId)
    const now = Date.now()
    const past = await ctx.db
      .query("deadlines")
      .withIndex("by_student_dueAt", (q) =>
        q.eq("studentId", args.studentId).lt("dueAt", now)
      )
      // Descending: with a huge backlog the 500-row page keeps the RECENT
      // past-due items (and pushes undated rows, which sort low, off the end)
      // rather than showing only ancient history (CR 3898632572).
      .order("desc")
      .take(500)
    const deadlines = past.filter(
      (d) =>
        d.status === "active" &&
        d.dueAt !== undefined &&
        (PAST_STATUSES as readonly string[]).includes(d.submissionStatus)
    )
    return { deadlines, count: deadlines.length }
  },
})

/**
 * The one-prompt resolution. `as: "done"` records the work as submitted (the
 * student's own word — a real fact about the world, sourced `manual`);
 * `as: "missed"` records `missing`, which keeps the row out of every future
 * feasible set without pretending it was handed in.
 *
 * Each row still goes through `changes` (the only write path): proposed with
 * origin `manual` and approved in the same mutation — the signed-in student
 * tapping the button IS the approval, exactly like a web tap on the queue.
 */
export const resolvePastDeadlines = mutation({
  args: {
    studentId: v.id("students"),
    deadlineIds: v.array(v.id("deadlines")),
    as: v.union(v.literal("done"), v.literal("missed")),
  },
  returns: v.object({ resolved: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    await requireStudent(ctx, args.studentId)
    if (args.deadlineIds.length > 200) {
      throw new Error("400: at most 200 deadlines per call")
    }
    const submissionStatus = args.as === "done" ? "submitted" : "missing"
    let resolved = 0
    let skipped = 0

    for (const deadlineId of args.deadlineIds) {
      const deadline = await ctx.db.get("deadlines", deadlineId)
      if (
        !deadline ||
        deadline.studentId !== args.studentId ||
        deadline.status !== "active" ||
        // Same past-due condition as the review query: a client-supplied id
        // for FUTURE work must not be marked done/missing and silently drop
        // out of every feasible set (CR 3898632581).
        deadline.dueAt === undefined ||
        deadline.dueAt >= Date.now() ||
        !(PAST_STATUSES as readonly string[]).includes(deadline.submissionStatus)
      ) {
        skipped++
        continue
      }
      const { changeId } = await proposeChangeInternal(ctx, {
        studentId: args.studentId,
        courseId: deadline.courseId,
        kind: "deadline_updated",
        entity: { table: "deadlines", id: deadlineId },
        before: { submissionStatus: deadline.submissionStatus },
        after: { submissionStatus },
        origin: "manual",
        reason:
          args.as === "done"
            ? "Mid-semester onboarding: marked done by the student"
            : "Mid-semester onboarding: marked missed by the student",
      })
      await approveChangeInternal(ctx, changeId, "web")
      resolved++
    }
    return { resolved, skipped }
  },
})
