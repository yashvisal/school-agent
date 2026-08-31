import { defineHook } from "eve/hooks"

/**
 * Log usage on every LLM call (vision §10 cost posture — mandatory from the
 * first call, and it must live in Core, not in eve).
 *
 * In eve 0.47 the model-usage fields ride on `step.completed`
 * (`data.usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 * costUsd }`); the model id rides on the preceding `step.started`
 * (`data.modelId`). Hooks fire once per durably-recorded event and are
 * at-least-once: an interrupted step re-emits under new `meta.id`s, so Core
 * should key the `usage` row on `meta.id`.
 */

// modelId is only on step.started, so carry it to the matching step.completed.
// A cancelled or interrupted step never emits step.completed, so the entry
// would otherwise live for the lifetime of the server process — bounded here,
// oldest first (Map preserves insertion order).
const MAX_PENDING_STEPS = 512
const modelBySession = new Map<string, string>()

function rememberModel(key: string, modelId: string): void {
  if (modelBySession.size >= MAX_PENDING_STEPS) {
    const oldest = modelBySession.keys().next().value
    if (oldest !== undefined) modelBySession.delete(oldest)
  }
  modelBySession.set(key, modelId)
}

function stepKey(sessionId: string, turnId: string, stepIndex: number): string {
  return `${sessionId}:${turnId}:${stepIndex}`
}

export default defineHook({
  events: {
    "step.started"(event, ctx) {
      rememberModel(
        stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex),
        event.data.modelId,
      )
    },

    "step.completed"(event, ctx) {
      const key = stepKey(ctx.session.id, event.data.turnId, event.data.stepIndex)
      const model = modelBySession.get(key) ?? "unknown"
      modelBySession.delete(key)

      const usage = event.data.usage
      const row = {
        surface: "workspace" as const,
        model,
        promptTokens: usage?.inputTokens ?? 0,
        completionTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        costUsd: usage?.costUsd,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        eventId: event.meta.id,
        at: event.meta.at,
      }

      // TODO(core): write to the convex usage table (vision §10 cost posture).
      // Idempotency key = eventId (meta.id is stable across reconnects/rewinds).
      console.info("[usage]", JSON.stringify(row))
    },
  },
})
