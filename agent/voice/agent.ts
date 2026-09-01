import { defineAgent } from "eve"

import { MODEL } from "./lib/model.js"

/**
 * Voice — the planning agent, in iMessage.
 *
 * vision §10: eve runs the agent; Convex is the only truth. Voice sees the plan
 * only through `getFeasibleActions`, mutates only through `proposeChange`, and
 * learns only through `recordSignal`. Every other capability is removed in
 * `tools/` with `disableTool()` so the tool boundary is the seam, not the prompt.
 *
 * All model calls route through the Vercel AI Gateway (`AI_GATEWAY_API_KEY`).
 */
export default defineAgent({
  model: MODEL,
})
