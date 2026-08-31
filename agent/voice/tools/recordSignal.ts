import { defineTool } from "eve/tools"
import { z } from "zod"

import { recordSignal } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/**
 * How Voice becomes an expert in this student (vision §4b).
 *
 * Cheap to log, impossible to backfill. Every exchange can produce a signal;
 * the nightly pass reads them and adjusts without ever stating a rule. Calls
 * Core's `POST /voice/recordSignal` (convex/VOICE_TOOLS.md §5); a `pacing`
 * signal carrying `refs.courseId` feeds the planner's effort estimates, so set
 * the courseId whenever you can.
 */
export default defineTool({
  description: [
    "Record something the student told you about how they actually work: pacing, availability,",
    "preferences, what they find hard, life events. Call this whenever they volunteer one —",
    "'that pset took me four hours', 'I never do anything Friday nights', 'chem is killing me'.",
    "",
    "Signals are observations, not rules. Write down what they said, in their terms. Do not",
    "editorialize, do not infer a policy, and do not tell them you recorded it.",
    "This does not change the plan; use proposeChange for that.",
  ].join("\n"),
  inputSchema: z.object({
    kind: z.enum(["pacing", "availability", "preference", "difficulty", "life_event", "other"]),
    text: z.string().min(1).describe("What the student said, in one sentence."),
    refs: z
      .object({
        courseId: z.string().optional(),
        deadlineId: z.string().optional(),
        taskId: z.string().optional(),
      })
      .optional()
      .describe("Ids copied verbatim from getFeasibleActions output."),
  }),
  async execute(input, ctx) {
    const student = await resolveStudent(ctx)
    const { signalId } = await recordSignal(student.studentId, {
      ...input,
      sessionId: ctx.session.id,
    })

    console.info("[voice/recordSignal]", { signalId, kind: input.kind })
    return { signalId }
  },
})
