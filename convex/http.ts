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
  errorResponse,
  jsonResponse,
  readJsonObject,
} from "./lib/httpAuth"

/**
 * The agent HTTP surface — how eve's Voice agent reaches Core.
 *
 * Four routes for the tools (three planning tools + usage logging) and one for
 * phone → student resolution. Every one:
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
 * Maps a thrown error to a status. Convex throws `ArgumentValidationError` when
 * a client-supplied id is malformed or points at the wrong table, which must
 * surface as a clean 400 rather than an opaque 500.
 */
function errorToResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  if (/ArgumentValidationError|Validator error|ArgumentValidation/i.test(message)) {
    return errorResponse(400, message)
  }
  const coded = /^(400|401|403|404|409):\s*(.*)$/.exec(message)
  if (coded) return errorResponse(Number(coded[1]), coded[2] || message)
  return errorResponse(500, message)
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
      return errorToResponse(error)
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
      return errorToResponse(error)
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
      return errorToResponse(error)
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
      })
      return jsonResponse({ ok: true, usageId })
    } catch (error) {
      return errorToResponse(error)
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
      return errorToResponse(error)
    }
  }),
})

export default http
