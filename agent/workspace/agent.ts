import { defineAgent } from "eve"

/**
 * The course-workspace agent (vision §10, face.md M3).
 *
 * Separate eve agent from Voice (`agent/voice`): separate instructions, tools,
 * skills, evals and traces. Scope is enforced by *tool availability*, not by
 * prompt — this agent has no planning tools and never will.
 *
 * Model: a cheap gateway model while the seam is being de-risked. Every call is
 * logged to the `usage` table via `hooks/usage.ts` (vision §10 cost posture).
 */
export default defineAgent({
  model: "anthropic/claude-haiku-4.5",
  description:
    "Course workspace agent: answers within one course's materials and hydrated state. No planning.",
  // Keep a Spike-B session from silently burning budget.
  limits: {
    maxInputTokensPerSession: 200_000,
    maxOutputTokensPerSession: 20_000,
  },
})
