import { defineTool } from "eve/tools"
import { z } from "zod"

import { proposeChange } from "../lib/core.js"
import { resolveStudent } from "../lib/students.js"

/**
 * The §4 `change` contract (convex/VOICE_TOOLS.md), plus the `evidence` field.
 * Exported so the confirmation evals assert against the exact shape the tool
 * enforces instead of a hand-copied one.
 */
export const proposeChangeInputSchema = z
  .object({
    kind: z.enum([
      "deadline_added",
      "deadline_moved",
      "deadline_removed",
      "deadline_updated",
      "submitted",
      "grade_posted",
      "course_added",
      "course_updated",
      "task_created",
      "task_updated",
      "availability_updated",
      "chat_decision",
      "other",
    ]),
    entity: z.object({
      table: z.enum(["deadlines", "courses", "tasks", "students"]),
      id: z
        .string()
        .optional()
        .describe("Id copied verbatim from getFeasibleActions output. Omit when creating."),
    }),
    before: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The prior values, if this replaces something we believed."),
    after: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("The new values. Omit for removals."),
    courseId: z.string().optional(),
    reason: z
      .string()
      .optional()
      .describe("One plain sentence for the change feed, in terms the student would recognize."),
    conflict: z
      .boolean()
      .optional()
      .describe("True when what the student said contradicts a structured source."),
    confirmedInline: z
      .boolean()
      .describe(
        "True ONLY if the student explicitly confirmed this change in the current exchange.",
      ),
    evidence: z
      .object({
        quotedReply: z
          .string()
          .min(1)
          .describe("The student's confirming message, quoted verbatim — no paraphrase."),
        inboundMessageId: z
          .string()
          .optional()
          .describe("The [msgId ...] of that confirming message, when the channel showed one."),
      })
      .optional()
      .describe("Required when confirmedInline is true; omit otherwise."),
  })
  .refine((c) => !c.confirmedInline || (c.evidence?.quotedReply ?? "").trim().length > 0, {
    message:
      "confirmedInline: true requires evidence.quotedReply — the student's confirming message, verbatim.",
    path: ["evidence"],
  })
  .refine((c) => c.confirmedInline || c.evidence === undefined, {
    message: "evidence only accompanies confirmedInline: true.",
    path: ["evidence"],
  })

export type ProposeChangeInput = z.infer<typeof proposeChangeInputSchema>

/**
 * The only way Voice mutates state (vision §10; convex/VOICE_TOOLS.md §4 —
 * this schema mirrors that contract's `change` object).
 *
 * Everything goes through `changes` at tier `needs_approval`. An inline chat
 * confirmation in the same exchange IS the approval (core.md rule 1) — and it
 * must be evidenced: `confirmedInline: true` requires `evidence.quotedReply`,
 * the student's confirming message quoted verbatim, plus the Photon message id
 * (`evidence.inboundMessageId`) when the channel surfaced one. Core verifies a
 * supplied `inboundMessageId` against its stored inbound log and rejects a
 * fabricated citation with a 400.
 */
export default defineTool({
  description: [
    "Propose a change to the student's plan or state. This is the ONLY way anything you learn",
    "becomes durable — you cannot write state any other way.",
    "",
    "Every change is held as `needs_approval`. Set `confirmedInline: true` ONLY when the",
    "student affirmatively confirmed this exact change in the current conversation, and pass",
    "`evidence`: their confirming reply quoted VERBATIM in `quotedReply`, and the bracketed",
    "[msgId ...] of that reply as `inboundMessageId` when one was shown. Never confirm on the",
    "student's behalf. If their reply was ambiguous, ask once; if still unconfirmed, call this",
    "with `confirmedInline: false` and no evidence — the change stays pending, which is safe.",
    "",
    "Describe only what the student actually said or what a tool actually returned. Never",
    "invent a date, a time, or a deadline in `before`/`after`.",
  ].join("\n"),
  inputSchema: proposeChangeInputSchema,
  async execute(input, ctx) {
    const student = await resolveStudent(ctx)
    const result = await proposeChange(student.studentId, input)

    console.info("[voice/proposeChange]", {
      changeId: result.changeId,
      kind: input.kind,
      status: result.status,
      evidenced: input.evidence !== undefined,
    })
    return result
  },
})
