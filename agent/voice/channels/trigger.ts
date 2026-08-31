import { defineChannel, POST } from "eve/channels"
import { z } from "zod"

import photon from "./photon.js"

/**
 * External trigger — Spike A kill criterion 1.
 *
 * "A Convex cron hits an endpoint for that student and a morning text goes out
 * with no inbound message first." eve schedules are deliberately NOT used:
 * Convex decides who gets a run and hands it what's true (voice.md M1 #2).
 *
 * Route note: custom-channel route paths are app URLs, and `withEve` only
 * proxies `/eve/agents/voice/eve/v1/:path+` from Next to the eve server. A route
 * at `/trigger` would therefore be unreachable in the mounted topology, so this
 * lives at `/eve/v1/trigger` — the same namespace eve's own Photon channel uses
 * for its webhook. Public URL: `/eve/agents/voice/eve/v1/trigger`.
 */

const TriggerBody = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use E.164, e.g. +15551234567."),
  operationId: z.string().min(1),
  kind: z.enum(["morning", "checkin"]),
  // Required, and computed by the caller in the STUDENT's timezone (voice.md
  // M1 #2: Convex decides who gets a run and hands it what's true). Deriving a
  // default here from UTC could plan the wrong calendar day.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (d) => {
        const t = new Date(`${d}T12:00:00Z`)
        return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
      },
      { message: "Not a real calendar date." },
    ),
  // The stored nightly snapshot this trigger describes. Traceability only: the
  // agent's getFeasibleActions call returns this same snapshot via Core's plan
  // cache, so the prompt never needs to carry it.
  planRunId: z.string().min(1).optional(),
})

/**
 * Dedupe. In-memory only — a restart or a second serverless instance forgets
 * everything — which is fine, because the DURABLE idempotency lives in Core:
 * `planRuns.operationId` is create-once per student-day and a run already
 * `triggered` is never re-POSTed (convex/nightly.ts). This set only absorbs a
 * same-process retry storm between Core's POST and its `markTrigger` write.
 */
const seenOperations = new Set<string>()

/**
 * iMessage thread ids are `imessage:<chatGuid>` or `imessage:<chatGuid>~<phone>`.
 * On a Photon shared line the DM chat GUID for a registered user is
 * `any;-;<E.164>` and the space's own `phone` is the literal `"shared"` — both
 * confirmed against the live project with `spectrum-ts`'s `space.create(phone)`.
 * `channelIdFromThreadId` is the identity function, so the thread id is also the
 * channel id.
 * TODO(core): on a dedicated line (Business plan) the chat GUID is line-specific;
 * resolve it through `space.create()` and store it per student instead.
 */
export function imessageThreadId(phone: string, line = "shared"): string {
  return `imessage:any;-;${phone}~${line}`
}

/** The same principal shape `defaultPhotonAuth` produces for an inbound message. */
function photonPrincipal(phone: string) {
  return {
    attributes: { trigger: "external" },
    authenticator: "photon-imessage",
    issuer: "photon",
    principalId: `photon:${phone}`,
    principalType: "user" as const,
    subject: phone,
  }
}

function triggerPrompt(kind: "morning" | "checkin", date: string): string {
  if (kind === "checkin") {
    return [
      `CHECK-IN for ${date}. Call getFeasibleActions for that date, then ask one short,`,
      `specific question about whether the planned work happened. No links, no media.`,
      `Plain text only.`,
    ].join(" ")
  }
  return [
    `MORNING PUSH for ${date}. Call getFeasibleActions with that date, pick 1-3 actions,`,
    `and text the plan. First message rule: no links, no media. Plain text only, no`,
    `markdown. Two or three short lines. Concrete times from the fits the tool returned;`,
    `never invent one.`,
  ].join(" ")
}

export default defineChannel({
  routes: [
    POST("/eve/v1/trigger", async (request, ctx) => {
      if (request.headers.get("x-voice-trigger-secret") !== process.env.VOICE_TRIGGER_SECRET) {
        return new Response("unauthorized", { status: 401 })
      }

      const parsed = TriggerBody.safeParse(await request.json().catch(() => null))
      if (!parsed.success) {
        return Response.json({ error: parsed.error.issues }, { status: 400 })
      }
      const { phone, operationId, kind, date, planRunId } = parsed.data

      if (seenOperations.has(operationId)) {
        return Response.json({ status: "duplicate", operationId }, { status: 200 })
      }
      seenOperations.add(operationId)

      const threadId = imessageThreadId(phone)
      const day = date

      const startedAt = Date.now()
      let session
      try {
        session = await ctx
          .to(photon, { threadId, adapterName: "imessage" })
          .send(triggerPrompt(kind, day), { auth: photonPrincipal(phone) })
      } catch (error) {
        seenOperations.delete(operationId)
        console.error("[voice/trigger] hand-off failed", {
          to: `…${phone.slice(-4)}`,
          error: String(error),
        })
        return Response.json({ error: String(error), threadId }, { status: 502 })
      }

      console.info("[voice/trigger] handed off to photon", {
        operationId,
        kind,
        date: day,
        planRunId,
        to: `…${phone.slice(-4)}`,
        sessionId: session.id,
        handoffMs: Date.now() - startedAt,
      })

      return Response.json(
        { status: "accepted", sessionId: session.id, threadId, operationId },
        { status: 202 },
      )
    }),
  ],
})
