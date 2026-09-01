import { v } from "convex/values"

import { internalMutation } from "./_generated/server"
import { normalizePhone } from "./lib/phone"

/**
 * The inbound iMessage log (voice.md "Inbound mechanics", VOICE_TOOLS.md §8b).
 *
 * Photon delivers webhooks at least once (up to 6 attempts, no ordering, no
 * DLQ) and eve's channel does not dedupe, so Core owns it: the Voice channel's
 * `onMessage` calls `POST /voice/recordInbound` before dispatching a turn and
 * drops anything already seen. The documented dedupe key is
 * `${webhookId}:${message.id}`; eve does not surface the delivery header to
 * `onMessage`, so the channel sends no `webhookId` and the key degrades to
 * `photon:<messageId>` — message ids are unique per message, so this is
 * strictly at-least-as-strong for one registered webhook.
 *
 * The same log powers two more things:
 * - **Contact warmed** — Photon caps proactive sends at 10 replies until a
 *   contact has sent ≥3 messages, so each accepted inbound bumps
 *   `students.inboundCount` and the nightly trigger gates on
 *   `WARMED_MIN_INBOUND` (nightly.ts).
 * - **Evidence verification** — `evidence.inboundMessageId` on an inline
 *   confirmation is checked against this log before the change applies
 *   (lib/changes.ts).
 */

/** Photon suppresses proactive sends until a contact has sent this many texts. */
export const WARMED_MIN_INBOUND = 3

/** Rows older than this are pruned; the dedupe window Photon documents is 24-48h. */
export const INBOUND_TTL_MS = 48 * 60 * 60 * 1000

export const recordResultV = v.object({
  duplicate: v.boolean(),
  studentId: v.optional(v.id("students")),
  /** True once this student has sent `WARMED_MIN_INBOUND` deduped messages. */
  warmed: v.boolean(),
})

/**
 * Record one inbound message; returns `duplicate: true` when the dedupe key was
 * already seen (the caller must then NOT dispatch a turn). A number that
 * resolves to no student — or ambiguously to more than one — is still logged
 * (phone-only) so redeliveries of it dedupe too; `studentId` is simply absent.
 */
export const record = internalMutation({
  args: {
    phone: v.string(),
    messageId: v.string(),
    webhookId: v.optional(v.string()),
    text: v.optional(v.string()),
    receivedAt: v.optional(v.number()),
  },
  returns: recordResultV,
  handler: async (ctx, args) => {
    const phone = normalizePhone(args.phone)
    const dedupeKey = `${args.webhookId ?? "photon"}:${args.messageId}`

    const seen = await ctx.db
      .query("inboundMessages")
      .withIndex("by_dedupeKey", (q) => q.eq("dedupeKey", dedupeKey))
      .first()
    if (seen) {
      const count = seen.studentId
        ? ((await ctx.db.get("students", seen.studentId))?.inboundCount ?? 0)
        : 0
      return {
        duplicate: true,
        studentId: seen.studentId,
        warmed: count >= WARMED_MIN_INBOUND,
      }
    }

    const matches = await ctx.db
      .query("students")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .take(2)
    const student = matches.length === 1 ? matches[0] : null

    await ctx.db.insert("inboundMessages", {
      studentId: student?._id,
      phone,
      messageId: args.messageId,
      dedupeKey,
      text: args.text,
      receivedAt: args.receivedAt ?? Date.now(),
    })

    let count = 0
    if (student) {
      count = (student.inboundCount ?? 0) + 1
      await ctx.db.patch("students", student._id, { inboundCount: count })
    }

    return {
      duplicate: false,
      studentId: student?._id,
      warmed: count >= WARMED_MIN_INBOUND,
    }
  },
})

const PRUNE_BATCH = 500
const MAX_PRUNE_BATCHES = 10

/**
 * TTL cleanup, on a cron. Only the log rows go; `students.inboundCount` and any
 * evidence already copied onto a change survive. Evidence verification always
 * happens minutes after the message arrived, well inside the TTL.
 */
export const prune = internalMutation({
  args: { olderThanMs: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - (args.olderThanMs ?? INBOUND_TTL_MS)
    let deleted = 0
    for (let batch = 0; batch < MAX_PRUNE_BATCHES; batch++) {
      const stale = await ctx.db
        .query("inboundMessages")
        .withIndex("by_receivedAt", (q) => q.lt("receivedAt", cutoff))
        .take(PRUNE_BATCH)
      for (const row of stale) {
        await ctx.db.delete("inboundMessages", row._id)
        deleted++
      }
      if (stale.length < PRUNE_BATCH) break
    }
    return deleted
  },
})
