import { defineChannel, POST } from "eve/channels"
import { z } from "zod"

/**
 * Contact registration — the other half of "the student texts this number".
 *
 * A Photon **shared line can only message registered users** (voice.md
 * "Pricing and quotas"), and nothing registered a student's number until now:
 * the founder's was created by hand during the spike. Core calls this route
 * whenever a student saves a phone in Settings (`convex/students.ts`
 * `registerContact`), because the Photon project credentials live only here,
 * on the Voice host, and Core has no business holding them.
 *
 * Route note: as with `trigger.ts`, custom-channel route paths are app URLs and
 * `withEve` only proxies `/eve/agents/voice/eve/v1/:path+`, so this lives at
 * `/eve/v1/contact`. Public URL: `/eve/agents/voice/eve/v1/contact`. eve
 * discovers channels by file (the stem is the channel id), so the file is the
 * whole registration.
 *
 * Which Photon call: **the documented REST user API**, not the SDK. The
 * installed `spectrum-ts` 12.8.0 exposes `space.create(users)` — "resolve or
 * create a *space* from its participants" (the spike used it to learn the DM
 * chat GUID) — and no user/contact registration call at all. Spectrum's
 * OpenAPI (https://spectrum.photon.codes/openapi/json) documents
 * `POST /projects/{projectId}/users/` ("Create user": `{ type: "shared" |
 * "dedicated", phoneNumber, firstName?, lastName?, email? }`, basic auth
 * `projectId:projectSecret`) and `GET /projects/{projectId}/users/`
 * (`search`, `limit`, `offset` → `{ succeed, data: { users, total } }`), which
 * is exactly registration. So: look the number up, create it if absent.
 */

const ContactBody = z.object({
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use E.164, e.g. +15551234567."),
  firstName: z.string().trim().min(1).max(100).optional(),
})

const SPECTRUM_BASE = "https://spectrum.photon.codes"

/** Registration is a fast REST call; anything slower is a Photon problem. */
const SPECTRUM_TIMEOUT_MS = 10_000

/**
 * The deadline for the WHOLE route, deliberately shorter than Core's
 * `VOICE_CONTACT_TIMEOUT_MS` (15s, `convex/students.ts`). Per-call timeouts are
 * not enough on their own: a paginated lookup of 10s pages outlives Core's
 * budget, and then Core has recorded `failed` and stopped listening while this
 * route pages on and possibly creates the user — Core believing the number is
 * unregistered at the exact moment Photon registers it. Answering inside the
 * caller's budget is what keeps the two ends' views of a number in step.
 */
const ROUTE_DEADLINE_MS = 12_000

/** Below this there is no time left to make a call worth making. */
const MIN_CALL_MS = 500

/** What is left of the route's deadline, measured from one start time. */
type Budget = { remaining: () => number }

const budgetFrom = (startedAt: number): Budget => ({
  remaining: () => ROUTE_DEADLINE_MS - (Date.now() - startedAt),
})

/** Never log a whole number — same rule as `trigger.ts`. */
const last4 = (phone: string) => `…${phone.slice(-4)}`

type Credentials = { projectId: string; authorization: string }

function credentials(): Credentials | null {
  const projectId = process.env.IMESSAGE_PROJECT_ID
  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET
  if (!projectId || !projectSecret) return null
  return {
    projectId,
    authorization: `Basic ${btoa(`${projectId}:${projectSecret}`)}`,
  }
}

type SpectrumUser = { id?: unknown; phoneNumber?: unknown }

/**
 * Both endpoints answer `{ succeed, data: … }`. Read defensively: a bare
 * payload (no envelope) is accepted too, so a shape change on Photon's side
 * degrades to "couldn't find it, try to create" rather than a hard failure.
 */
function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: unknown }).data
  }
  return payload
}

function usersOf(payload: unknown): SpectrumUser[] {
  const data = unwrap(payload)
  if (Array.isArray(data)) return data as SpectrumUser[]
  if (data && typeof data === "object" && Array.isArray((data as { users?: unknown }).users)) {
    return (data as { users: SpectrumUser[] }).users
  }
  return []
}

function totalOf(payload: unknown): number | undefined {
  const data = unwrap(payload)
  if (data && typeof data === "object") {
    const total = (data as { total?: unknown }).total
    if (typeof total === "number") return total
  }
  return undefined
}

function userIdOf(payload: unknown): string | undefined {
  const data = unwrap(payload)
  if (data && typeof data === "object") {
    const id = (data as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return undefined
}

async function spectrum(
  creds: Credentials,
  path: string,
  budget: Budget,
  init?: { method: "POST"; body: unknown },
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
  const response = await fetch(`${SPECTRUM_BASE}/projects/${creds.projectId}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: creds.authorization,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    // Whichever runs out first: this call's own patience or the route's. Never
    // clamped upwards — a floor here would hand an already-spent budget another
    // `MIN_CALL_MS` and put the answer back outside Core's window. Callers
    // check `remaining()` before spending it, so this is positive.
    signal: AbortSignal.timeout(Math.min(SPECTRUM_TIMEOUT_MS, budget.remaining())),
  })
  const text = await response.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // A non-JSON body is only ever used for the error message.
  }
  return { ok: response.ok, status: response.status, text, json }
}

/** 20 pages of 100 is 2 000 users — well past a shared line's documented capacity. */
const USER_PAGE_SIZE = 100
const MAX_USER_PAGES = 20

/**
 * `{ ok: false }` means we do not KNOW whether the number is registered, which
 * is not the same as knowing it is not. `timedOut` is that same ignorance
 * arrived at by running out of clock rather than by an error.
 */
type Lookup =
  | { ok: true; userId?: string }
  | { ok: false; timedOut: true; unresolved?: false }
  | { ok: false; timedOut?: false; unresolved: true }
  | { ok: false; timedOut?: false; unresolved?: false; status: number; text: string }

/**
 * The registered user for this number, if Photon already has one.
 *
 * Paginated: `search` is not documented to match an exact phone number, so a
 * project with more registered users than one page could hide the match behind
 * an offset. Walks until the number is found, the list is exhausted, the page
 * bound is hit, or the route's budget runs out — a walk that outlives the
 * caller's patience has stopped being useful to anyone.
 */
async function findUser(
  creds: Credentials,
  phone: string,
  budget: Budget,
): Promise<Lookup> {
  for (let page = 0; page < MAX_USER_PAGES; page++) {
    if (budget.remaining() < MIN_CALL_MS) return { ok: false, timedOut: true }

    const offset = page * USER_PAGE_SIZE
    let found
    try {
      found = await spectrum(
        creds,
        `/users/?search=${encodeURIComponent(phone)}&limit=${USER_PAGE_SIZE}&offset=${offset}`,
        budget,
      )
    } catch (error) {
      // An abort with no budget left is the deadline, not a Photon fault.
      if (budget.remaining() < MIN_CALL_MS) return { ok: false, timedOut: true }
      throw error
    }
    if (!found.ok) return { ok: false, status: found.status, text: found.text }

    const users = usersOf(found.json)
    const match = users.find((user) => user.phoneNumber === phone)
    if (typeof match?.id === "string") return { ok: true, userId: match.id }

    // A short page, or `total` reached, is the END of the list: the number is
    // conclusively absent. Only then is "not found" a fact.
    if (users.length < USER_PAGE_SIZE) return { ok: true }
    const total = totalOf(found.json)
    if (total !== undefined && offset + users.length >= total) return { ok: true }
  }
  // Every page was full and none was the last: the list may go on past the
  // cap. That is not "absent" — `search` is a partial match, not an exact
  // number lookup — so creating here could duplicate a user further down.
  return { ok: false, unresolved: true }
}

/**
 * The 502 for running out of clock, in one wording: Core stores this string as
 * the registration's `error`, and one deadline should read as one reason
 * wherever in the route it was hit.
 */
const outOfTime = () => Response.json({ error: "lookup timed out" }, { status: 502 })

/** The 502 a failed Spectrum call becomes. */
const spectrumFailed = (what: string, status: number, text: string) =>
  Response.json(
    { error: `Photon ${what} returned ${status}: ${text.slice(0, 500)}` },
    { status: 502 },
  )

export default defineChannel({
  routes: [
    POST("/eve/v1/contact", async (request) => {
      if (request.headers.get("x-voice-trigger-secret") !== process.env.VOICE_TRIGGER_SECRET) {
        return new Response("unauthorized", { status: 401 })
      }

      const parsed = ContactBody.safeParse(await request.json().catch(() => null))
      if (!parsed.success) {
        return Response.json({ error: parsed.error.issues }, { status: 400 })
      }
      const { phone, firstName } = parsed.data
      // One clock for the whole request, started before any network call.
      const budget = budgetFrom(Date.now())

      const creds = credentials()
      if (!creds) {
        return Response.json(
          { error: "Photon project credentials are not configured on the Voice host." },
          { status: 502 },
        )
      }

      try {
        // Check-then-create, so re-registering a number the founder (or an
        // earlier save) already registered is a success, not a 4xx. A lookup
        // that FAILED stops here rather than falling through to create: we
        // would be creating blind, and a duplicate user for a number Photon
        // already holds is worse than telling Core to retry.
        const existing = await findUser(creds, phone, budget)
        if (!existing.ok) {
          if (existing.timedOut) {
            // Out of clock is out of knowledge: we never learned whether the
            // number is registered, so creating now could duplicate a user
            // Photon already holds. Core records `failed` and the next save
            // retries with a fresh budget.
            console.error("[voice/contact] lookup timed out", { to: last4(phone) })
            return outOfTime()
          }
          if (existing.unresolved) {
            // Fail closed: the page cap was reached without an exact match and
            // without the list ending, so whether the number exists is unknown.
            console.error("[voice/contact] lookup unresolved at the page cap", {
              to: last4(phone),
              pages: MAX_USER_PAGES,
            })
            return Response.json(
              { error: `lookup unresolved: ${MAX_USER_PAGES} pages without an exact match` },
              { status: 502 },
            )
          }
          console.error("[voice/contact] lookup failed", {
            to: last4(phone),
            status: existing.status,
          })
          return spectrumFailed("user lookup", existing.status, existing.text)
        }
        if (existing.userId) {
          console.info("[voice/contact] already registered", { to: last4(phone) })
          return Response.json(
            { status: "already_registered", userId: existing.userId },
            { status: 200 },
          )
        }

        // The lookup can finish with too little left to create in. Starting the
        // POST anyway would run past the deadline Core is timing us against,
        // and a create that lands after Core gave up leaves the two ends
        // disagreeing about the number for a whole retry cycle.
        if (budget.remaining() < MIN_CALL_MS) {
          console.error("[voice/contact] no budget left to register", {
            to: last4(phone),
          })
          return outOfTime()
        }

        const created = await spectrum(creds, "/users/", budget, {
          method: "POST",
          body: {
            type: "shared",
            phoneNumber: phone,
            ...(firstName ? { firstName } : {}),
          },
        })
        if (!created.ok) {
          // A 409 usually means the create raced another registration. Success
          // is reported only when a second lookup actually FINDS the number: a
          // 409 we cannot corroborate stays a 502, so nothing ever tells Core a
          // number is reachable on the strength of an error code alone.
          if (created.status === 409) {
            if (budget.remaining() < MIN_CALL_MS) {
              console.error("[voice/contact] no budget left to confirm a 409", {
                to: last4(phone),
              })
              return outOfTime()
            }
            const raced = await findUser(creds, phone, budget)
            if (raced.ok && raced.userId) {
              return Response.json(
                { status: "already_registered", userId: raced.userId },
                { status: 200 },
              )
            }
          }
          console.error("[voice/contact] registration failed", {
            to: last4(phone),
            status: created.status,
          })
          return spectrumFailed("registration", created.status, created.text)
        }

        const userId = userIdOf(created.json)
        console.info("[voice/contact] registered", { to: last4(phone), userId })
        return Response.json({ status: "registered", userId }, { status: 200 })
      } catch (error) {
        console.error("[voice/contact] registration errored", {
          to: last4(phone),
          error: String(error),
        })
        return Response.json({ error: String(error) }, { status: 502 })
      }
    }),
  ],
})
