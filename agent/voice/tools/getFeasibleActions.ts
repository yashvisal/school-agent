import { defineTool } from "eve/tools"
import { z } from "zod"

import { getFeasibleActions, localDate } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/**
 * The only window Voice has onto the plan (vision §10, voice.md "Architecture").
 * Calls Core's `POST /voice/getFeasibleActions` (convex/VOICE_TOOLS.md §3) and
 * returns the plan verbatim — Core's shapes are the contract.
 */
export default defineTool({
  description: [
    "Get the feasible set of study actions for one day, for the student you are texting.",
    "",
    "This is the ONLY source of truth about deadlines, free windows, effort estimates,",
    "pending changes and what the student has told you about themselves. Every `fits` slot",
    "is guaranteed not to overlap a class and not to run past the deadline it belongs to.",
    "Pick from `options`; never propose a time that is not in that option's `fits`.",
    "",
    "Reading the result: `windows` are the day's free intervals; `startMin`/`endMin` are",
    "minutes from local midnight (540 = 9:00am). Each option's `facts` are plain-English,",
    "true statements — they are what you weigh; there is no score or rank and never will",
    "be. `pending` entries are UNCONFIRMED changes: plan on the applied facts, and surface",
    "one pending item for a one-word confirmation when it affects the day. An `overdue`",
    "option has no fits — it is there so you can raise the miss, calmly.",
    "",
    "Never state a deadline, a time, a duration, a course, or a free window that did not",
    "come out of this tool. If it is not here, you do not know it — say so instead of",
    "guessing. You do not name the student; identity comes from who is texting.",
  ].join("\n"),
  inputSchema: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
      .optional()
      .describe(
        "The day to plan, YYYY-MM-DD in the student's timezone. A MORNING PUSH trigger names the date; otherwise defaults to tomorrow.",
      ),
  }),
  async execute({ date }, ctx) {
    const student = await resolveStudent(ctx)
    const plan = await getFeasibleActions(
      student.studentId,
      date ?? localDate(student.timezone, 1),
    )
    console.info("[voice/getFeasibleActions]", {
      studentId: student.studentId,
      date: plan.date,
      cached: plan.cached,
      planRunId: plan.planRunId,
      options: plan.options.length,
      pending: plan.pending.length,
    })
    return plan
  },
})
