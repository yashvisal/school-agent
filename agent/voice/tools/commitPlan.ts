import { defineTool } from "eve/tools"
import { z } from "zod"

import { commitPlan } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/**
 * The §4b contract (convex/VOICE_TOOLS.md). Exported so an eval asserts against
 * the exact shape the tool enforces rather than a hand-copied one.
 */
export const commitPlanInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .describe("The day this plan is for, YYYY-MM-DD — the same date you passed to getFeasibleActions."),
  picks: z
    .array(
      z.object({
        taskId: z
          .string()
          .optional()
          .describe("The option's taskId, copied verbatim, when it has one."),
        deadlineId: z
          .string()
          .optional()
          .describe("The option's deadlineId, copied verbatim, when it has no taskId."),
        title: z
          .string()
          .optional()
          .describe("The option's title, for free-standing work with no ids."),
        courseId: z.string().optional().describe("The option's courseId, with `title`."),
        startMin: z
          .number()
          .int()
          .describe("Block start, minutes from local midnight (540 = 9:00am). Must be inside one of that option's `fits` windows."),
        endMin: z.number().int().describe("Block end, minutes from local midnight."),
      }),
    )
    .min(1)
    .max(3)
    .describe("The 1-3 blocks you actually named, in the order you said them."),
})

export type CommitPlanInput = z.infer<typeof commitPlanInputSchema>

/**
 * Persist the plan you just told the student.
 *
 * Without this the text is the only record: no task exists, the web app shows an
 * empty day, and tomorrow's replan cannot see what today's plan was. Core
 * re-verifies every pick against the feasible set before applying, so a block
 * outside a free window is rejected outright rather than quietly stored.
 */
export default defineTool({
  description: [
    "Commit the plan you just wrote — the 1-3 blocks you named, with their times. Call this",
    "after composing the text, every time you tell the student what to do on a day.",
    "",
    "Identify each pick the way getFeasibleActions gave it to you: `taskId` if the option has",
    "one, else `deadlineId`, else `title` + `courseId`. Times are minutes from local midnight",
    "and must be inside one of that option's `fits` windows — Core checks, and rejects the",
    "whole commit if any block is not feasible. Never round, shift, or invent a time here that",
    "differs from the one you said in the text.",
    "",
    "A commit REPLACES the plan for that date: anything you planned for that day and did not",
    "include this time is unplanned again. So when a replan changes the day, call this again",
    "with the new picks — do not call it with a partial list.",
    "",
    "This is not a state change and needs no confirmation; it is the plan itself. Never",
    "announce it, never mention saving or logging anything.",
  ].join("\n"),
  inputSchema: commitPlanInputSchema,
  async execute(input, ctx) {
    const student = await resolveStudent(ctx)
    const result = await commitPlan(student.studentId, input.date, input.picks)

    console.info("[voice/commitPlan]", {
      studentId: student.studentId,
      date: input.date,
      committed: result.committed.length,
      unplanned: result.unplanned,
    })
    return result
  },
})
