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
  init?: { method: "POST"; body: unknown },
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
  const response = await fetch(`${SPECTRUM_BASE}/projects/${creds.projectId}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: creds.authorization,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(SPECTRUM_TIMEOUT_MS),
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

/** The registered user for this number, if Photon already has one. */
async function findUser(creds: Credentials, phone: string): Promise<string | undefined> {
  const found = await spectrum(creds, `/users/?search=${encodeURIComponent(phone)}&limit=100`)
  if (!found.ok) return undefined
  const match = usersOf(found.json).find((user) => user.phoneNumber === phone)
  return typeof match?.id === "string" ? match.id : undefined
}

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

      const creds = credentials()
      if (!creds) {
        return Response.json(
          { error: "Photon project credentials are not configured on the Voice host." },
          { status: 502 },
        )
      }

      try {
        // Check-then-create, so re-registering a number the founder (or an
        // earlier save) already registered is a success, not a 4xx.
        const existing = await findUser(creds, phone)
        if (existing) {
          console.info("[voice/contact] already registered", { to: last4(phone) })
          return Response.json({ status: "already_registered", userId: existing }, { status: 200 })
        }

        const created = await spectrum(creds, "/users/", {
          method: "POST",
          body: {
            type: "shared",
            phoneNumber: phone,
            ...(firstName ? { firstName } : {}),
          },
        })
        if (!created.ok) {
          // The create raced another registration (or Photon rejects the
          // duplicate outright): whoever won, the number is registered.
          const raced = created.status === 409 ? await findUser(creds, phone) : undefined
          if (raced) {
            return Response.json({ status: "already_registered", userId: raced }, { status: 200 })
          }
          console.error("[voice/contact] registration failed", {
            to: last4(phone),
            status: created.status,
          })
          return Response.json(
            { error: `Photon returned ${created.status}: ${created.text.slice(0, 500)}` },
            { status: 502 },
          )
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
