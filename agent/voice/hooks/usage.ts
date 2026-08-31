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
 * the cached resolveStudent. A failure to attribute — or to log at all — must
 * never break the turn; it is shouted to the log instead.
 */
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
      } catch (error) {
        // Loud, because a silent gap here is an unmetered LLM call.
        console.error("[voice/usage] FAILED to log usage row", String(error))
      }
    },
  },
})
