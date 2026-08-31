import { defineHook } from "eve/hooks"

import { logUsage } from "../lib/core.js"
import { MODEL } from "../lib/model.js"
import { resolveStudent, sessionPhone } from "../lib/students.js"

/**
 * Per-LLM-call usage logging (vision §10: mandatory from the first call).
 *
 * eve emits one `step.completed` per model call with
 * `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 * costUsd }`. Each writes one row to Core's `usage` table over
 * `POST /voice/logUsage` (convex/VOICE_TOOLS.md §7) — the one cost record that
 * survives a change of agent runtime, which is why it lives in Convex, not eve.
 *
 * Two gaps worth naming: `step.completed` does not carry the model id, so it
 * comes from the shared `MODEL` pin; and `usage` is optional — a provider that
 * reports nothing yields zeros, which the row still records (a call happened).
 *
 * `studentId` is best-effort: resolved from the session's Photon principal via
 * the cached resolveStudent.
 *
 * Failure posture (review-discussed): the write is retried with short backoff,
 * then shouted to the log. It deliberately does NOT fail the turn — the
 * student's conversation outranks bookkeeping — and there is no durable replay
 * queue in eve, because nothing durable may live in eve (the truth rule,
 * vision §10). If retries ever prove insufficient, the fix is a Core-side
 * reconciliation against eve's traces, not eve-side persistence.
 */

/** Backoff before each attempt; three tries covers a transient blip. */
const RETRY_DELAYS_MS = [0, 500, 2000]
export default defineHook({
  events: {
    async "step.completed"(event, ctx) {
      const usage = event.data.usage ?? {}

      // Attribution works for a Photon session AND for the VOICE_DEV_PHONE
      // dev/eval fallback (resolveStudent handles both); only a session with
      // neither identity is left unattributed — Core accepts the row anyway.
      let studentId: string | undefined
      const attributable =
        sessionPhone(ctx as { session: { auth?: unknown } }) !== null ||
        Boolean(process.env.VOICE_DEV_PHONE?.trim())
      if (attributable) {
        try {
          studentId = (await resolveStudent(ctx as { session: { auth?: unknown } })).studentId
        } catch (error) {
          console.warn("[voice/usage] could not attribute studentId", String(error))
        }
      }

      // Cache reads/writes are prompt-side tokens; Core's schema keeps the
      // two-column shape, so they fold into promptTokens.
      const promptTokens =
        (usage.inputTokens ?? 0) +
        (usage.cacheReadTokens ?? 0) +
        (usage.cacheWriteTokens ?? 0)

      let lastError: unknown
      for (const delayMs of RETRY_DELAYS_MS) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        try {
          const { usageId } = await logUsage({
            studentId,
            surface: "voice",
            model: MODEL,
            promptTokens,
            completionTokens: usage.outputTokens ?? 0,
            costUsd: usage.costUsd,
            sessionId: ctx.session.id,
          })
          console.info("[voice/usage]", {
            usageId,
            sessionId: ctx.session.id,
            turnId: event.data.turnId,
            stepIndex: event.data.stepIndex,
            promptTokens,
            completionTokens: usage.outputTokens ?? 0,
            costUsd: usage.costUsd,
            finishReason: event.data.finishReason,
          })
          return
        } catch (error) {
          lastError = error
        }
      }
      // Loud, because a silent gap here is an unmetered LLM call.
      console.error(
        `[voice/usage] FAILED to log usage row after ${RETRY_DELAYS_MS.length} attempts`,
        String(lastError)
      )
    },
  },
})
