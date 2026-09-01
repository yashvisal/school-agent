import { httpRouter } from "convex/server"

import { internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { httpAction } from "./_generated/server"
import {
  asDate,
  asNumber,
  asObject,
  asString,
  checkBearer,
  codedError,
  errorResponse,
  jsonResponse,
  readJsonObject,
} from "./lib/httpAuth"

/**
 * The agent HTTP surface — how eve's Voice agent reaches Core.
 *
 * Six routes: the three planning tools, usage logging, phone → student
 * resolution, and the inbound-message log (dedupe / contact-warmed / evidence).
 * Every one:
 *
 * - requires `Authorization: Bearer <CORE_AGENT_SECRET>` (constant-time compare),
 * - treats the body as `unknown` and narrows each field, 400 on anything else,
 * - calls an `internal*` function, so nothing here widens the public API.
 *
 * The request/response contract is documented in `convex/VOICE_TOOLS.md`; that
 * file is the seam and should be updated in the same PR as any change here.
 */

const http = httpRouter()

/**
 * Maps a thrown error to a status.
 *
 * Two recognised shapes: Convex's `ArgumentValidationError`, thrown when a
 * client-supplied id is malformed or points at the wrong table (a clean 400, not
 * an opaque 500), and Core's own `NNN: message` convention, parsed by
 * `codedError`.
 *
 * **Anything else is a 500 with a fixed body.** An unrecognised error is by
 * definition one we did not design for, and echoing its message hands the caller
 * internal detail — table names, ids, stack fragments — for no operational gain.
 * It is logged instead, where it is actually useful (CR 3892161906).
 */
function errorToResponse(error: unknown, route: string): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/ArgumentValidationError|Validator error|ArgumentValidation/i.test(message)) {
    // Same rule as the 500 branch: Convex validation messages embed the
    // rejected value, table name, and validator shape (CR 3897465358). The
    // caller keeps the 400-vs-500 distinction; the detail goes to the log.
    console.error(`http ${route}: argument validation failed`, error)
    return errorResponse(400, "invalid arguments")
  }
  const coded = codedError(error)
  if (coded) return errorResponse(coded.status, coded.message)
  console.error(`http ${route}: unhandled error`, error)
  return errorResponse(500, "internal error")
}

/** Auth, then a JSON object body. Returns the body or the Response to send. */
async function gate(
  request: Request
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const unauthorized = checkBearer(request)
  if (unauthorized) return { response: unauthorized }
  return await readJsonObject(request)
}

/** `studentId` is a client-supplied string until the internal function validates it. */
const studentIdOf = (body: Record<string, unknown>) =>
  asString(body.studentId) as Id<"students"> | undefined

// ---------------------------------------------------------------------------
// getFeasibleActions
// ---------------------------------------------------------------------------

http.route({
  path: "/voice/getFeasibleActions",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const gated = await gate(request)
    if ("response" in gated) return gated.response

    const studentId = studentIdOf(gated.body)
    const date = asDate(gated.body.date)
    if (!studentId) return errorResponse(400, "studentId is required")
    if (!date) return errorResponse(400, "date is required, as YYYY-MM-DD")

    try {
      const plan = await ctx.runQuery(internal.voice.getFeasibleActions, {
        studentId,
        date,
        now: asNumber(gated.body.now),
      })
      return jsonResponse({ ok: true, plan })
    } catch (error) {
      return errorToResponse(error, "/voice/getFeasibleActions")
    }
  }),
})

// ---------------------------------------------------------------------------
// proposeChange
// ---------------------------------------------------------------------------

http.route({
  path: "/voice/proposeChange",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const gated = await gate(request)
    if ("response" in gated) return gated.response

    const studentId = studentIdOf(gated.body)
    const change = asObject(gated.body.change)
    if (!studentId) return errorResponse(400, "studentId is required")
    if (!change) return errorResponse(400, "change must be an object")

    try {
      // Shape is enforced by the mutation's validators; a bad payload throws
      // ArgumentValidationError, which `errorToResponse` turns into a 400.
      const result = await ctx.runMutation(internal.voice.proposeChange, {
        studentId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        change: change as any,
      })
      return jsonResponse({ ok: true, ...result })
    } catch (error) {
      return errorToResponse(error, "/voice/proposeChange")
    }
  }),
})

// ---------------------------------------------------------------------------
// recordSignal
// ---------------------------------------------------------------------------

http.route({
  path: "/voice/recordSignal",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const gated = await gate(request)
    if ("response" in gated) return gated.response

    const studentId = studentIdOf(gated.body)
    const signal = asObject(gated.body.signal)
    if (!studentId) return errorResponse(400, "studentId is required")
    if (!signal) return errorResponse(400, "signal must be an object")

    try {
      const signalId = await ctx.runMutation(internal.voice.recordSignal, {
        studentId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        signal: signal as any,
      })
      return jsonResponse({ ok: true, signalId })
    } catch (error) {
      return errorToResponse(error, "/voice/recordSignal")
    }
  }),
})

// ---------------------------------------------------------------------------
// logUsage — every LLM call, from day one
// ---------------------------------------------------------------------------

http.route({
  path: "/voice/logUsage",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const gated = await gate(request)
    if ("response" in gated) return gated.response

    const model = asString(gated.body.model)
    const promptTokens = asNumber(gated.body.promptTokens)
    const completionTokens = asNumber(gated.body.completionTokens)
    if (!model) return errorResponse(400, "model is required")
    if (promptTokens === undefined || completionTokens === undefined) {
      return errorResponse(400, "promptTokens and completionTokens are required")
    }

    try {
      const usageId = await ctx.runMutation(internal.voice.logUsage, {
        studentId: studentIdOf(gated.body),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        surface: asString(gated.body.surface) as any,
        model,
        promptTokens,
        completionTokens,
        costUsd: asNumber(gated.body.costUsd),
        sessionId: asString(gated.body.sessionId),
        at: asNumber(gated.body.at),
        idempotencyKey: asString(gated.body.idempotencyKey),
      })
      return jsonResponse({ ok: true, usageId })
    } catch (error) {
      return errorToResponse(error, "/voice/logUsage")
    }
  }),
})

// ---------------------------------------------------------------------------
// recordInbound — webhook dedupe + the contact-warmed count + evidence log
// ---------------------------------------------------------------------------

http.route({
  path: "/voice/recordInbound",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const gated = await gate(request)
    if ("response" in gated) return gated.response

    const phone = asString(gated.body.phone)
    const messageId = asString(gated.body.messageId)
    if (!phone) return errorResponse(400, "phone is required")
    if (!messageId) return errorResponse(400, "messageId is required")

    try {
      const result = await ctx.runMutation(internal.inbound.record, {
        phone,
        messageId,
        webhookId: asString(gated.body.webhookId),
        text: asString(gated.body.text),
      })
      return jsonResponse({ ok: true, ...result })
    } catch (error) {
      return errorToResponse(error, "/voice/recordInbound")
    }
  }),
})

// ---------------------------------------------------------------------------
// resolveStudent — an inbound number is the only handle Voice starts with
// ---------------------------------------------------------------------------

http.route({
  path: "/voice/resolveStudent",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const gated = await gate(request)
    if ("response" in gated) return gated.response

    const phone = asString(gated.body.phone)
    const clerkId = asString(gated.body.clerkId)
    if (!phone && !clerkId) {
      return errorResponse(400, "one of phone or clerkId is required")
    }

    try {
      const student = await ctx.runQuery(internal.voice.resolveStudent, {
        phone,
        clerkId,
      })
      if (!student) return errorResponse(404, "no student for that identifier")
      return jsonResponse({ ok: true, ...student })
    } catch (error) {
      return errorToResponse(error, "/voice/resolveStudent")
    }
  }),
})

export default http
