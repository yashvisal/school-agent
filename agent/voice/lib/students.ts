import type { ToolContext } from "eve/tools"

import { resolveStudentByPhone, type ResolvedStudent } from "./core.js"

/**
 * Student identity is NEVER a tool input.
 *
 * The model must not be able to name a student; if it could, a prompt-injected
 * "look up Sam's plan" would be a data leak. Identity comes from the session's
 * auth context, which the Photon channel derives from the message author:
 * `defaultPhotonAuth` sets `principalId: "photon:<author.userId>"` with
 * `issuer: "photon"`, and the iMessage author id is the sender's phone number.
 *
 * The number resolves to a student through Core's `/voice/resolveStudent`
 * (phone ↔ Clerk ↔ student mapping lives in Convex, voice.md M1 #1). The Spike
 * A `VOICE_DEMO_PHONE` fixture map is gone; the one remaining escape hatch is
 * `VOICE_DEV_PHONE`, which stands in for the principal on channels that have no
 * Photon auth (`eve dev`'s HTTP channel, `eve eval`) — it still resolves
 * through Core, so it only works against a seeded deployment.
 */

/** `photon:+15551234567` / `+15551234567` -> `+15551234567`. */
export function normalizePrincipal(principalId: string | undefined | null): string | null {
  if (!principalId) return null
  const raw = principalId.startsWith("photon:") ? principalId.slice("photon:".length) : principalId
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

type AuthLike =
  | { principalId?: string; subject?: string; issuer?: string; authenticator?: string }
  | null
  | undefined

function principalOf(auth: AuthLike): string | null {
  return normalizePrincipal(auth?.principalId ?? auth?.subject ?? null)
}

/** Only Photon-issued principals identify a student; anything else is dev tooling. */
function isPhotonPrincipal(auth: AuthLike): boolean {
  return auth?.issuer === "photon" || (auth?.principalId ?? "").startsWith("photon:")
}

export type Student = ResolvedStudent & { phone: string }

/**
 * Cache so one turn's several tool calls (and the usage hook's per-step rows)
 * don't each pay a resolveStudent round trip. Short TTL: `status` (paused) and
 * re-linked numbers must not stick for long.
 */
const CACHE_TTL_MS = 60_000
const cache = new Map<string, { value: Student; at: number }>()

async function resolveByPhone(phone: string): Promise<Student> {
  const hit = cache.get(phone)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const resolved = await resolveStudentByPhone(phone)
  const value: Student = {
    studentId: resolved.studentId,
    timezone: resolved.timezone,
    status: resolved.status,
    phone,
  }
  cache.set(phone, { value, at: Date.now() })
  return value
}

/** The phone the current session belongs to, or null on a no-auth dev channel. */
export function sessionPhone(ctx: { session: { auth?: unknown } }): string | null {
  const auth = ctx.session.auth as
    | { initiator?: AuthLike; current?: AuthLike }
    | undefined
  // `initiator` first: on a trigger-started session the initiator is the student
  // the cron picked, and `current` may be the service principal.
  const photonAuth = [auth?.initiator, auth?.current].find(isPhotonPrincipal)
  return principalOf(photonAuth)
}

/**
 * Resolve the student for the current session. Throws when the number is not
 * registered (never fall back to another student — VOICE_TOOLS.md §2) and when
 * there is no Photon principal and no `VOICE_DEV_PHONE`.
 */
export async function resolveStudent(ctx: { session: { auth?: unknown } }): Promise<Student> {
  let phone = sessionPhone(ctx)
  if (!phone) {
    const devPhone = process.env.VOICE_DEV_PHONE?.trim()
    if (!devPhone) {
      throw new Error(
        "No Photon principal on this session and VOICE_DEV_PHONE is unset — cannot resolve a student.",
      )
    }
    console.warn(
      "[voice/students] no Photon principal (eve dev / eval channel); resolving VOICE_DEV_PHONE via Core",
    )
    phone = devPhone
  }
  try {
    return await resolveByPhone(phone)
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 404) {
      throw new Error(
        `No student is registered for …${phone.slice(-4)}. Ask them to sign up first.`,
      )
    }
    throw error
  }
}

/** Narrow helper so tools can type `ctx` without importing eve internals. */
export type ToolCtx = ToolContext
