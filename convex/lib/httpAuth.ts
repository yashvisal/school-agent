/**
 * Shared auth + body handling for the agent HTTP routes (`convex/http.ts`).
 *
 * The Voice agent runs on eve, outside Convex, so it reaches the three tools
 * over HTTP rather than through the client SDK. One shared secret
 * (`CORE_AGENT_SECRET`, set per deployment with `npx convex env set`) gates every
 * route; the tools themselves stay `internal*` so nothing is publicly reachable.
 *
 * Web Crypto is available in the default Convex runtime, but a plain constant-
 * time byte compare is enough here and keeps these routes out of the Node
 * runtime (`"use node"` would break `http.ts`).
 */

/** Length-independent byte compare. No early exit on the first differing byte. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  let diff = left.length ^ right.length
  const length = Math.max(left.length, right.length, 1)
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return diff === 0
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

export const errorResponse = (status: number, error: string): Response =>
  jsonResponse({ ok: false, error }, status)

/**
 * `null` when the caller is authorized; otherwise the Response to return.
 *
 * A missing `CORE_AGENT_SECRET` fails closed: an unconfigured deployment must
 * not silently expose the agent surface.
 */
export function checkBearer(request: Request): Response | null {
  const secret = process.env.CORE_AGENT_SECRET
  if (!secret) {
    return errorResponse(401, "CORE_AGENT_SECRET is not set on this deployment")
  }
  const header = request.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match || !timingSafeEqual(match[1], secret)) {
    return errorResponse(401, "unauthorized")
  }
  return null
}

/** Parses a JSON object body. Anything else — bad JSON, an array, a scalar — is a 400. */
export async function readJsonObject(
  request: Request
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return { response: errorResponse(400, "body must be valid JSON") }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { response: errorResponse(400, "body must be a JSON object") }
  }
  return { body: parsed as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// Field narrowing — the body is `unknown` until proven otherwise
// ---------------------------------------------------------------------------

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

export const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

export const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined

export const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** "YYYY-MM-DD" and nothing else — the planner's date arg is client-supplied. */
export const asDate = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
