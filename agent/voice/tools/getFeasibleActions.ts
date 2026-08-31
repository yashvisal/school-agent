import { defineTool } from "eve/tools"
import { z } from "zod"

import { getFeasibleActionsFor, localDate } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/**
 * The only window Voice has onto the plan (vision §10, voice.md "Architecture").
 *
 * SPIKE STUB: reads `fixtures/student-demo.json`.
 * TODO(core): call the Convex `getFeasibleActions` query. The output shape here
 * is the contract Core must satisfy.
 */
export default defineTool({
  description: [
    "Get the feasible set of study actions for one day, for the student you are texting.",
    "",
    "This is the ONLY source of truth about deadlines, class schedule, free windows, effort",
    "estimates, pending changes and what the student has told you about themselves. Every",
    "window it returns is guaranteed not to overlap a class and not to run past the deadline",
    "it belongs to. Pick from `options`; do not construct your own.",
    "",
    "Never state a deadline, a time, a duration, a course, or a free window that did not come",
    "out of this tool. If it is not here, you do not know it — say so instead of guessing.",
    "You do not name the student in the input; identity comes from who is texting.",
  ].join("\n"),
  inputSchema: z.object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
      .optional()
      .describe(
        "The day to plan, YYYY-MM-DD in the student's timezone. Defaults to tomorrow.",
      ),
  }),
  async execute({ date }, ctx) {
    const student = resolveStudent(ctx)
    const result = getFeasibleActionsFor(student, date ?? localDate(student.timezone, 1))
    console.info("[voice/getFeasibleActions]", {
      studentId: student.studentId,
      date: result.date,
      options: result.options.length,
      pendingChanges: result.pendingChanges.length,
    })
    return result
  },
})
