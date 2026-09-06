import { defineAgent } from "eve"

import { MODEL } from "./lib/model.js"

/**
 * Voice — the planning agent, in iMessage.
 *
 * vision §10: eve runs the agent; Convex is the only truth. Voice sees the plan
 * only through `getFeasibleActions`, mutates only through `proposeChange` and
 * `commitPlan`, and learns only through `recordSignal`. Every other capability is
 * removed in `tools/` with `disableTool()` so the tool boundary is the seam,
 * not the prompt.
 *
 * All model calls route through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`).
 */
export default defineAgent({
  model: MODEL,
  /**
   * A runaway-cost circuit breaker, not a budget. One session is one iMessage
   * thread for up to 30 days (eve's default `sessionTimeoutMs`), and a morning
   * turn costs roughly 30k input tokens, so a healthy thread never comes close
   * to these numbers — 3M input tokens is about $9 of Sonnet input at the cap.
   * Tripping it means something is looping, not that a student talked a lot.
   *
   * When it trips, eve pauses the session and asks the student Approve/Stop
   * before the next model call. That is acceptable as a breaker and never as
   * normal operation: a student being asked to approve a token budget is a bug
   * report, so treat a trip as an incident rather than raising the number.
   */
  limits: {
    maxInputTokensPerSession: 3_000_000,
    maxOutputTokensPerSession: 150_000,
  },
})
