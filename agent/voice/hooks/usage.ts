import { defineHook } from "eve/hooks"

import { appendSpike } from "../lib/core.js"

/**
 * Per-LLM-call usage logging (vision §10: mandatory from the first call).
 *
 * eve emits one `step.completed` per model call, and its payload carries
 * `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 * costUsd }`. That is genuinely per-call, not per-turn — the kill-criterion
 * question answers itself in the affirmative.
 *
 * Two gaps worth naming: `step.completed` does not carry the model id (only
 * `compaction.requested` does), so we read it from the session/agent config, and
 * `usage` is optional — a provider that reports nothing yields an empty object.
 *
 * SPIKE STUB: appends to `.spike/usage.jsonl`.
 * TODO(core): replace with the Convex `usage` mutation. The `usage` table does
 * not exist yet; Core owns it, and it is the one thing that must stay true
 * across a change of runtime.
 */
const MODEL = "anthropic/claude-sonnet-5"

export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const usage = event.data.usage ?? {}
      const row = {
        at: new Date().toISOString(),
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        stepIndex: event.data.stepIndex,
        // TODO(core): join to studentId via the session's auth principal once
        // the phone <-> student mapping lives in Convex.
        studentId: null as string | null,
        surface: "voice",
        model: MODEL,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        cacheReadTokens: usage.cacheReadTokens ?? null,
        cacheWriteTokens: usage.cacheWriteTokens ?? null,
        costUsd: usage.costUsd ?? null,
        finishReason: event.data.finishReason,
      }

      console.info("[voice/usage]", row)
      await appendSpike("usage.jsonl", row)
    },
  },
})
