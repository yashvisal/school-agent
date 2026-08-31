import type { ToolContext } from "eve/tools"

import { demoStudent, type Student } from "./core.js"

/**
 * Student identity is NEVER a tool input.
 *
 * The model must not be able to name a student; if it could, a prompt-injected
 * "look up Sam's plan" would be a data leak. Identity comes from the session's
 * auth context, which the Photon channel derives from the message author:
 * `defaultPhotonAuth` sets `principalId: "photon:<author.userId>"` with
 * `issuer: "photon"`, and the iMessage author id is the sender's phone number.
 *
 * TODO(core): replace this map with a Convex lookup on the phone <-> Clerk user
 * <-> student mapping (voice.md M1 #1). The spike's single mapping comes from
 * `VOICE_DEMO_PHONE` so no real phone number is ever committed.
 */
function studentsByPhone(): Record<string, Student> {
  const phone = process.env.VOICE_DEMO_PHONE?.trim()
  if (!phone) {
    throw new Error(
      "VOICE_DEMO_PHONE is not set. Spike A resolves the demo student from the phone number " +
        "registered with the Photon project; it is deliberately not committed.",
    )
  }
  return { [phone]: demoStudent }
}

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

/**
 * Resolve the student for the current session.
 *
 * `initiator` first: on a trigger-started session the initiator is the student
 * the cron picked, and `current` may be the service principal. Falls back to the
 * demo student (loudly) when there is no Photon-issued principal — that is the
 * eve HTTP channel in `eve dev` and in `eve eval`, whose `localDev()` verifier
 * mints a `local-dev` principal, and the bare HTTP channel with no auth at all.
 */
export function resolveStudent(ctx: { session: { auth?: unknown } }): Student {
  const auth = ctx.session.auth as
    | { initiator?: AuthLike; current?: AuthLike }
    | undefined

  const photonAuth = [auth?.initiator, auth?.current].find(isPhotonPrincipal)
  const principal = principalOf(photonAuth)

  if (!principal) {
    console.warn(
      "[voice/students] no Photon principal on this session (eve dev / eval channel); falling back to the demo student",
    )
    return demoStudent
  }

  const student = studentsByPhone()[principal]
  if (!student) {
    throw new Error(
      `No student is registered for principal …${principal.slice(-4)}. Ask them to sign up first.`,
    )
  }
  return student
}

/** Narrow helper so tools can type `ctx` without importing eve internals. */
export type ToolCtx = ToolContext
