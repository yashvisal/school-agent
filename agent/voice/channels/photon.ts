import { photonIMessageChannel, defaultPhotonAuth } from "eve/channels/photon"

/**
 * Photon iMessage channel — hand-authored per the documented "configure the
 * channel by hand" path in eve's docs (`docs/channels/photon.mdx`). We do not
 * use Vercel Connect: portable credentials keep the spike host-agnostic.
 *
 * Webhook route: `/eve/v1/photon`, which under `withEve({ agents: { voice } })`
 * is publicly mounted at `/eve/agents/voice/eve/v1/photon`.
 *
 * What eve 0.47.3 does for us on inbound: HMAC-SHA256 signature verification
 * (`x-spectrum-signature` / `x-spectrum-timestamp`, 300s window), mark-as-read,
 * and one durable eve session per iMessage conversation.
 *
 * What it does NOT do (ours to build in Core):
 *  - Dedupe. Nothing in eve reads a webhook delivery id, and the Chat SDK state
 *    store is `createMemoryState()` — in-process, lost on restart. Photon
 *    delivers at least once (up to 6 attempts, no ordering guarantee). Dedupe on
 *    `${webhookId}:${message.id}` with a 24-48h TTL belongs in Convex.
 *    TODO(core): persist seen-message ids and drop replays before dispatch.
 *  - Ordering. Out-of-order redelivery is possible and unhandled.
 *
 * Because of that, `turnPolicy` is `"queue"`, not the default `"steer"`: with
 * `steer`, a Photon *retry* of a message we already answered would cancel a
 * half-composed reply. Queue costs latency on rapid-fire texts and buys us
 * safety until dedupe exists. Revisit once Core dedupes.
 */
/**
 * eve 0.47.3 ships `dist/src/compiled/chat/index.d.ts` referencing a
 * `messages-BSoJG691.js` module that is not in the package, so `Message`,
 * `Thread`, and `Attachment` have no resolvable types and every property access
 * on them is an implicit `any` under `strict`. Declared locally from what the
 * iMessage adapter actually builds (`{ type, name, mimeType, size }`).
 * TODO: drop this once eve fixes the broken type re-export.
 */
type InboundAttachment = {
  type?: "image" | "video" | "audio" | "file"
  name?: string
  mimeType?: string
  size?: number
}

export default photonIMessageChannel({
  async credentials() {
    const projectId = process.env.IMESSAGE_PROJECT_ID
    const projectSecret = process.env.IMESSAGE_PROJECT_SECRET
    if (!projectId || !projectSecret) {
      throw new Error("Photon project credentials are required.")
    }
    return { projectId, projectSecret }
  },
  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,
  turnPolicy: "queue",

  onMessage(_ctx, message) {
    if (message.author.isBot) return null

    // Inbound observability for Spike A item 3 (attachments both directions).
    // Photon webhooks carry attachment *metadata only* — bytes are fetched by
    // GUID through the SDK. eve's `messageToUserContent` only forwards an
    // attachment to the model when it has a `url`, and the iMessage adapter
    // never sets one, so an attachment-only message would otherwise dispatch
    // NOTHING. We put the metadata into `context` so the model can at least
    // name what arrived.
    // TODO(core): fetch bytes via the adapter's attachment handle and hand them
    // to the ingestion pipeline (PDF/screenshot -> markdown -> `changes`).
    const attachments: InboundAttachment[] = message.attachments ?? []
    console.info("[voice/photon] inbound", {
      messageId: message.id,
      threadId: message.threadId,
      from: `…${String(message.author.userId).slice(-4)}`,
      textLength: message.text?.length ?? 0,
      hasAttachments: attachments.length > 0,
      attachments: attachments.map((a: InboundAttachment) => ({
        name: a.name,
        type: a.type,
        mediaType: a.mimeType,
        size: a.size,
      })),
    })

    const context = [
      "The student is texting from iMessage. Plain text only — no markdown, no links.",
      // Surfaced so the model can cite the confirming message when it calls
      // proposeChange with confirmedInline: true (evidence.inboundMessageId).
      `[msgId ${message.id}]`,
    ]
    if (attachments.length > 0) {
      context.push(
        `The student sent ${attachments.length} attachment(s): ${attachments
          .map(
            (a) =>
              `${a.name ?? "(unnamed)"} (${a.mimeType ?? "unknown type"}, ${a.size ?? 0} bytes)`,
          )
          .join("; ")}. You cannot read the contents yet. Name them back exactly as received.`,
      )
    }

    return { auth: defaultPhotonAuth(message), context }
  },
})
