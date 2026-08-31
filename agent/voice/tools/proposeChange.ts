import { defineTool } from "eve/tools"
import { z } from "zod"

import { appendSpike, newId } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/**
 * The only way Voice mutates state (vision §10; core.md "Approval channels").
 *
 * Everything goes through `changes` at tier `needs_approval`. An inline chat
 * confirmation in the same exchange IS the approval, which is what
 * `confirmedInline` records — nothing from chat lands in the web queue.
 *
 * SPIKE STUB: appends to `.spike/changes.jsonl`.
 * TODO(core): call the Convex `proposeChange` mutation.
 */
export default defineTool({
  description: [
    "Propose a change to the student's plan or state. This is the ONLY way anything you learn",
    "becomes durable — you cannot write state any other way.",
    "",
    "Every change is held as `needs_approval`. If the student already confirmed it in this",
    "exchange (you asked, they said yes), set `confirmedInline: true` — that confirmation is",
    "the approval. If you inferred it and have not confirmed, set `confirmedInline: false` and",
    "ask them in your reply.",
    "",
    "Summarize only what the student actually said or what a tool actually returned. Never",
    "invent a date, a time, or a deadline in `before`/`after`.",
  ].join("\n"),
  inputSchema: z.object({
    kind: z.enum([
      "deadline_moved",
      "deadline_added",
      "deadline_removed",
      "task_skipped",
      "task_done",
      "chat_decision",
    ]),
    summary: z.string().min(1).describe("One plain sentence a student would recognize."),
    before: z.string().optional().describe("What we believed, if this replaces something."),
    after: z.string().optional().describe("What we now believe."),
    confirmedInline: z
      .boolean()
      .describe("True only if the student explicitly confirmed this in the current exchange."),
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
    const student = resolveStudent(ctx)
    const changeId = newId("chg")
    const status = input.confirmedInline ? "approved" : "pending"

    await appendSpike("changes.jsonl", {
      at: new Date().toISOString(),
      changeId,
      studentId: student.studentId,
      sessionId: ctx.session.id,
      surface: "voice",
      tier: "needs_approval",
      status,
      ...input,
    })

    console.info("[voice/proposeChange]", { changeId, kind: input.kind, status })
    return { changeId, tier: "needs_approval" as const, status }
  },
})
