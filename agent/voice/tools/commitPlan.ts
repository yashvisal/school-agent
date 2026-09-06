import { defineTool } from "eve/tools"
import { z } from "zod"

import { commitPlan, type PlanPick } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/** One block: which option, and when. The §4b `picks[]` contract. */
const pickSchema = z
  .object({
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
      .describe("The option's title, for free-standing work with neither id — with courseId."),
    courseId: z
      .string()
      .optional()
      .describe("The option's courseId. Required with `title`, ignored otherwise."),
    startMin: z
      .number()
      .int()
      .describe(
        "Block start, minutes from local midnight (540 = 9:00am). Must be inside one of that option's `fits` windows.",
      ),
    endMin: z.number().int().describe("Block end, minutes from local midnight."),
  })
  // EXACTLY one complete identity, checked here so the model is told what is
  // wrong before Core has to say it — Core enforces the same rule independently.
  // More than one is not redundancy: a taskId and a deadlineId that disagree
  // would be resolved by precedence rather than raised as the contradiction it is.
  .refine(
    (pick) =>
      [
        pick.taskId !== undefined,
        pick.deadlineId !== undefined,
        pick.title !== undefined || pick.courseId !== undefined,
      ].filter(Boolean).length === 1,
    {
      message:
        "Each pick needs exactly ONE identity: the option's taskId, or its deadlineId, or its title AND courseId together — never a mix.",
    },
  )
  .refine((pick) => !(pick.title !== undefined || pick.courseId !== undefined) || Boolean(pick.title && pick.courseId), {
    message: "Free-standing work needs title AND courseId together, not one of them.",
  })
  .refine((pick) => pick.endMin > pick.startMin, {
    message: "endMin must be after startMin.",
    path: ["endMin"],
  })

export const commitPlanInputSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .describe("The day this plan is for, YYYY-MM-DD — the same date you passed to getFeasibleActions."),
  picks: z
    .array(pickSchema)
    .min(1)
    .max(3)
    .describe("The 1-3 blocks you actually named, in the order you said them.")
    // A day is a sequence: two blocks cannot claim the same minutes.
    .refine(
      (picks) =>
        picks.every((pick, i) =>
          picks
            .slice(0, i)
            .every(
              (earlier) =>
                Math.max(earlier.startMin, pick.startMin) >=
                Math.min(earlier.endMin, pick.endMin),
            ),
        ),
      { message: "Two picks cannot cover the same minutes — the blocks must not overlap." },
    ),
})

export type CommitPlanInput = z.infer<typeof commitPlanInputSchema>

/**
 * The flat validated shape → the one-identity union the Core client takes.
 * The schema's refinement has already guaranteed one of these three branches;
 * the throw is the honest total case rather than a non-null assertion.
 */
function toPick(pick: CommitPlanInput["picks"][number]): PlanPick {
  const block = { startMin: pick.startMin, endMin: pick.endMin }
  if (pick.taskId) return { ...block, taskId: pick.taskId }
  if (pick.deadlineId) return { ...block, deadlineId: pick.deadlineId }
  if (pick.title && pick.courseId) {
    return { ...block, title: pick.title, courseId: pick.courseId }
  }
  throw new Error(
    "Each pick needs one complete identity: taskId, else deadlineId, else title + courseId.",
  )
}

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
    "Identify each pick the way getFeasibleActions gave it to you, with exactly one complete",
    "identity: `taskId` if the option has one, else `deadlineId`, else `title` AND `courseId`",
    "together. Times are minutes from local midnight and must be inside one of that option's",
    "`fits` windows, and two blocks may never cover the same minutes — Core checks all of it,",
    "and rejects the WHOLE commit if any block is not feasible or two overlap. Never round,",
    "shift, or invent a time here that differs from the one you said in the text.",
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
    const result = await commitPlan(student.studentId, input.date, input.picks.map(toPick))

    console.info("[voice/commitPlan]", {
      studentId: student.studentId,
      date: input.date,
      committed: result.committed.length,
      unplanned: result.unplanned,
    })
    return result
  },
})
