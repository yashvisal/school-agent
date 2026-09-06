import type { Infer } from "convex/values"
import { v } from "convex/values"

import { internal } from "./_generated/api"
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server"
import { requireIdentity } from "./lib/auth"
import { approveChangeInternal, proposeChangeInternal } from "./lib/changes"
import { normalizePhone } from "./lib/phone"
import {
  availabilityV,
  checkInPreferenceV,
  photonRegistrationV,
  studentDocV,
  timeBlockV,
} from "./lib/validators"

const DEFAULT_TIMEZONE = "America/New_York"

/**
 * Upsert the students row for the signed-in Clerk identity. Idempotent: calling
 * it again returns the same row (and updates the timezone if one is supplied),
 * so onboarding can call it on every load.
 *
 * Identity comes from `ctx.auth` — never from an argument.
 */
export const ensure = mutation({
  args: { timezone: v.optional(v.string()) },
  returns: v.id("students"),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const existing = await ctx.db
      .query("students")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique()

    if (existing) {
      if (args.timezone && args.timezone !== existing.timezone) {
        await ctx.db.patch("students", existing._id, { timezone: args.timezone })
      }
      return existing._id
    }

    return await ctx.db.insert("students", {
      clerkId: identity.subject,
      timezone: args.timezone ?? DEFAULT_TIMEZONE,
      classBlocks: [],
      availability: { weekly: [], exceptions: [] },
      status: "active",
    })
  },
})

/** Internal: load a student by id (crons, adapters, agent tools). */
export const get = internalQuery({
  args: { studentId: v.id("students") },
  returns: v.union(v.null(), studentDocV),
  handler: async (ctx, args) => await ctx.db.get("students", args.studentId),
})

// ---------------------------------------------------------------------------
// Settings — the student editing their own row
// ---------------------------------------------------------------------------

/** E.164 as Photon hands it over and as the trigger route demands it. */
const E164 = /^\+[1-9]\d{6,14}$/

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/

/** The fields `updatePrefs` may touch, in the order `changed[]` reports them. */
const PREF_KEYS = [
  "phone",
  "timezone",
  "morningHourLocal",
  "availability",
  "checkInPreference",
  "semesterStart",
  "semesterEnd",
] as const

type PrefKey = (typeof PREF_KEYS)[number]

/**
 * Fields that describe the student's *schedule*. A change touching only these
 * is `availability_updated` — the schema's word for "the shape of this
 * student's week moved". Anything outside the set (`phone`, `timezone`) is
 * identity and routing, which `availability_updated` would misdescribe in the
 * change feed, so such a change is filed as `other`. Both kinds reach the same
 * `studentPatch` on apply (lib/changes.ts), so the choice is about honest
 * labelling, not about which fields land.
 */
const SCHEDULE_KEYS: ReadonlySet<PrefKey> = new Set<PrefKey>([
  "morningHourLocal",
  "availability",
  "checkInPreference",
  "semesterStart",
  "semesterEnd",
])

/** A real IANA zone, per the runtime's own tz database. */
function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
  } catch {
    throw new Error(`400: not a usable IANA timezone: ${timezone}`)
  }
}

function assertCalendarDate(field: string, date: string): void {
  const parsed = new Date(`${date}T12:00:00Z`)
  if (
    !YYYY_MM_DD.test(date) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`400: ${field} must be a real YYYY-MM-DD date`)
  }
}

const MINUTES_IN_DAY = 24 * 60

type TimeBlock = Infer<typeof timeBlockV>

/**
 * The planner subtracts these blocks from the day and offers what is left, so a
 * block the arithmetic cannot read is not a cosmetic problem: `endMin` before
 * `startMin` yields a negative window, a `dayOfWeek` of 9 silently never
 * matches, and a fractional minute makes every window boundary fractional. The
 * validator can only prove these are numbers, so the ranges are checked here.
 */
function assertTimeBlocks(where: string, blocks: readonly TimeBlock[]): void {
  blocks.forEach((block, index) => {
    const at = `${where}[${index}]`
    if (!Number.isInteger(block.dayOfWeek) || block.dayOfWeek < 0 || block.dayOfWeek > 6) {
      throw new Error(`400: ${at}.dayOfWeek must be a whole day 0-6 (0 = Sunday)`)
    }
    for (const field of ["startMin", "endMin"] as const) {
      const value = block[field]
      if (!Number.isInteger(value) || value < 0 || value > MINUTES_IN_DAY) {
        throw new Error(
          `400: ${at}.${field} must be a whole minute from midnight, 0-${MINUTES_IN_DAY}`
        )
      }
    }
    if (block.startMin >= block.endMin) {
      throw new Error(`400: ${at} starts at or after it ends`)
    }
  })
}

function assertAvailability(availability: Infer<typeof availabilityV>): void {
  assertTimeBlocks("availability.weekly", availability.weekly)
  availability.exceptions.forEach((exception, index) => {
    const at = `availability.exceptions[${index}]`
    assertCalendarDate(`${at}.date`, exception.date)
    assertTimeBlocks(`${at}.blocks`, exception.blocks)
  })
}

/**
 * Structural equality for the values this mutation compares. Availability is a
 * nested object, and a Settings form that re-submits an unchanged grid must not
 * mint a change row for it.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The student editing their own account and schedule from Settings.
 *
 * Identity-scoped: there is no `studentId` argument, because the only row this
 * can touch is the signed-in identity's own. Every write still goes through
 * `changes` — the single write path (vision §10) — proposed with origin
 * `manual` and approved in the same mutation, exactly like
 * `onboarding.resolvePastDeadlines`: the signed-in student tapping Save IS the
 * approval, equal to a web tap on the queue (core.md "Approval channels" rule 1).
 *
 * Nothing changed → no change row. A `changes` feed that fills with empty edits
 * every time a form is re-submitted is worse than no feed at all.
 *
 * Saving a new phone additionally schedules `registerContact`: a Photon shared
 * line can only message a REGISTERED user (voice.md "Pricing and quotas"), and
 * until this existed the only registered number was the founder's, registered
 * by hand during the spike.
 */
export const updatePrefs = mutation({
  args: {
    phone: v.optional(v.string()),
    timezone: v.optional(v.string()),
    /** Local hour 0-23 for the morning push. */
    morningHourLocal: v.optional(v.number()),
    availability: v.optional(availabilityV),
    checkInPreference: v.optional(checkInPreferenceV),
    semesterStart: v.optional(v.string()),
    semesterEnd: v.optional(v.string()),
  },
  returns: v.object({
    studentId: v.id("students"),
    changed: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx)
    const student = await ctx.db
      .query("students")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique()
    if (!student) {
      throw new Error("404: no student row — call students.ensure first")
    }

    // --- validate, then normalize, before anything is compared -------------
    const next: Partial<Record<PrefKey, unknown>> = {}

    if (args.phone !== undefined) {
      const phone = normalizePhone(args.phone)
      if (!E164.test(phone)) {
        throw new Error("400: phone is not a usable number")
      }
      // `by_phone` is how Voice resolves an inbound message to a student, so a
      // number shared by two rows makes both students unreachable — not a
      // cosmetic collision (convex/inbound.ts takes 2 and gives up on ties).
      const holders = await ctx.db
        .query("students")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .take(2)
      if (holders.some((held) => held._id !== student._id)) {
        throw new Error("409: phone already in use")
      }
      next.phone = phone
    }

    if (args.timezone !== undefined) {
      assertTimezone(args.timezone)
      next.timezone = args.timezone
    }

    if (args.morningHourLocal !== undefined) {
      if (!Number.isInteger(args.morningHourLocal)) {
        throw new Error("400: morningHourLocal must be a whole hour")
      }
      if (args.morningHourLocal < 0 || args.morningHourLocal > 23) {
        throw new Error("400: morningHourLocal must be between 0 and 23")
      }
      next.morningHourLocal = args.morningHourLocal
    }

    if (args.availability !== undefined) {
      assertAvailability(args.availability)
      next.availability = args.availability
    }
    if (args.checkInPreference !== undefined) {
      next.checkInPreference = args.checkInPreference
    }
    for (const field of ["semesterStart", "semesterEnd"] as const) {
      const value = args[field]
      if (value === undefined) continue
      assertCalendarDate(field, value)
      next[field] = value
    }

    // --- diff --------------------------------------------------------------
    const changed: PrefKey[] = []
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const key of PREF_KEYS) {
      if (!(key in next)) continue
      const current = (student as Record<string, unknown>)[key]
      if (sameValue(current, next[key])) continue
      changed.push(key)
      // Convex values cannot be `undefined`; a field the student never set is
      // simply absent from `before`, which reads correctly in the feed.
      if (current !== undefined) before[key] = current
      after[key] = next[key]
    }

    /**
     * A phone that did NOT change can still need registering: the last attempt
     * may have failed, or been skipped on a deployment with no Voice attached.
     * Settings' "try again" is a re-save, so this is that retry path — and it
     * writes no change row, because nothing about the student changed.
     */
    const registerPhone =
      next.phone !== undefined &&
      (changed.includes("phone") || student.photonRegistration?.status !== "registered")

    const scheduleRegistration = async () => {
      if (!registerPhone) return
      // Network call, so an action, so scheduled: the mutation must commit the
      // new number whether or not Photon is reachable. The number goes with it
      // so a late outcome cannot be pinned on a number it was never about.
      await ctx.scheduler.runAfter(0, internal.students.registerContact, {
        studentId: student._id,
        phone: next.phone as string,
      })
    }

    if (changed.length === 0) {
      await scheduleRegistration()
      return { studentId: student._id, changed: [] }
    }

    const scheduleOnly = changed.every((key) => SCHEDULE_KEYS.has(key))
    const { changeId } = await proposeChangeInternal(ctx, {
      studentId: student._id,
      kind: scheduleOnly ? "availability_updated" : "other",
      entity: { table: "students", id: student._id },
      before,
      after,
      origin: "manual",
      reason: `Settings: ${changed.join(", ")} updated by the student`,
    })
    await approveChangeInternal(ctx, changeId, "web")

    if (changed.includes("phone")) {
      // Patched directly rather than carried in the change: `photonRegistration`
      // is bookkeeping about our transport, not a fact about the student, and
      // it is deliberately outside `STUDENT_KEYS`. Clearing it is the point —
      // the old number's registration says nothing about the new one, and
      // leaving it would tell Settings we can text a number we never registered.
      await ctx.db.patch("students", student._id, { photonRegistration: undefined })
    }
    await scheduleRegistration()

    return { studentId: student._id, changed }
  },
})

// ---------------------------------------------------------------------------
// Photon contact registration
// ---------------------------------------------------------------------------

/**
 * The Voice contact route, mounted by `withEve` on the Next deployment
 * (`agent/voice/channels/contact.ts`). Same host and same shared secret as the
 * nightly trigger — Photon credentials live only on the Voice host, so Core
 * asks Voice to register rather than talking to Spectrum itself.
 */
export const VOICE_CONTACT_PATH = "/eve/agents/voice/eve/v1/contact"

/** How long the registration POST may take before it is a failure. */
export const VOICE_CONTACT_TIMEOUT_MS = 15_000

type RegistrationOutcome = {
  status: "registered" | "failed" | "skipped"
  at: number
  error?: string
}

/**
 * Records the registration outcome on the student row. **Not** through
 * `changes`: this is routing bookkeeping about our own transport, like
 * `inboundCount` — nothing a student proposes, approves, or should see in the
 * change feed. Settings reads it to say "we can text this number" or
 * "couldn't register — try again".
 */
export const markPhotonRegistration = internalMutation({
  args: {
    studentId: v.id("students"),
    /** The number the outcome is ABOUT, normalized. */
    phone: v.string(),
    registration: photonRegistrationV,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const student = await ctx.db.get("students", args.studentId)
    if (!student) return null
    if (student.phone !== args.phone) {
      // The number moved on while this registration was in flight. Writing the
      // outcome now would label the CURRENT number with a result that belongs
      // to a different one — "we can text this" about a number nobody
      // registered. The save that changed the phone scheduled its own run.
      console.warn("[students] stale Photon registration dropped", {
        studentId: args.studentId,
        status: args.registration.status,
      })
      return null
    }
    await ctx.db.patch("students", args.studentId, {
      photonRegistration: args.registration,
    })
    return null
  },
})

/**
 * `POST {EVE_VOICE_URL}/eve/agents/voice/eve/v1/contact` with
 * `x-voice-trigger-secret` and `{ phone }`, mirroring `triggerVoice`
 * (convex/nightly.ts) down to the skipped/failed semantics: a deployment with
 * no Voice attached, or one that set the URL but not the secret, records
 * `skipped` and never POSTs unauthenticated.
 *
 * Idempotent by construction — the route resolves an already-registered number
 * to the same success — so a retry is free.
 */
async function postContact(phone: string): Promise<RegistrationOutcome> {
  const at = Date.now()
  const baseUrl = process.env.EVE_VOICE_URL
  if (!baseUrl) return { status: "skipped", at, error: "EVE_VOICE_URL not set" }
  const secret = process.env.VOICE_TRIGGER_SECRET
  if (!secret) {
    return { status: "skipped", at, error: "VOICE_TRIGGER_SECRET not set" }
  }

  try {
    const response = await fetch(
      `${baseUrl.replace(/\/+$/, "")}${VOICE_CONTACT_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-voice-trigger-secret": secret,
        },
        // Core stores no name for a student today, so no `firstName` is sent;
        // the route takes one optionally for when it does.
        body: JSON.stringify({ phone }),
        signal: AbortSignal.timeout(VOICE_CONTACT_TIMEOUT_MS),
      }
    )
    if (!response.ok) {
      const text = await response.text()
      return {
        status: "failed",
        at: Date.now(),
        error: `voice returned ${response.status}: ${text.slice(0, 500)}`,
      }
    }
    return { status: "registered", at: Date.now() }
  } catch (error) {
    return {
      status: "failed",
      at: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Register one number with Photon so a shared line may message it.
 *
 * The number is an argument rather than a read of the row, so the outcome is
 * bound to what was actually registered: a student who corrects a typo twice in
 * a row has two runs in flight, and the slower one must not overwrite the
 * faster one's verdict. `markPhotonRegistration` drops any outcome whose number
 * is no longer the student's.
 *
 * Scheduled by `updatePrefs` on every phone save and on every re-save that has
 * not yet landed a registration; also safe to run by hand:
 * `npx convex run students:registerContact '{"studentId": "j57a...", "phone": "+15551234567"}'`.
 */
export const registerContact = internalAction({
  args: { studentId: v.id("students"), phone: v.string() },
  returns: photonRegistrationV,
  handler: async (ctx, args): Promise<RegistrationOutcome> => {
    const outcome = await postContact(args.phone)
    await ctx.runMutation(internal.students.markPhotonRegistration, {
      studentId: args.studentId,
      phone: args.phone,
      registration: outcome,
    })
    return outcome
  },
})
