import { v } from "convex/values"

import { internalQuery, mutation } from "./_generated/server"
import { requireIdentity } from "./lib/auth"
import { approveChangeInternal, proposeChangeInternal } from "./lib/changes"
import { normalizePhone } from "./lib/phone"
import { availabilityV, checkInPreferenceV, studentDocV } from "./lib/validators"

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

    if (args.availability !== undefined) next.availability = args.availability
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

    if (changed.length === 0) return { studentId: student._id, changed: [] }

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

    return { studentId: student._id, changed }
  },
})
