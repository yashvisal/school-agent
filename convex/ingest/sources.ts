import { v } from "convex/values"

import type { Doc, Id } from "../_generated/dataModel"
import { internalMutation, internalQuery, mutation, query } from "../_generated/server"
import { getCurrentStudent, requireStudent } from "../lib/auth"
import { requireFetchableUrl } from "../lib/net"
import { sourceConfigKindV, sourceHealthV } from "../lib/validators"
import { isPollableKind, isUploadKind, schedulePoll, scheduleReextract } from "./dispatch"

/**
 * Source registration and health (core.md "State model": `sources` — studentId,
 * kind, config, lastPolledAt, health).
 *
 * The student is always derived from `ctx.auth`, never from an argument: a
 * `studentId` parameter on a public mutation here would let any signed-in user
 * attach a Canvas token to someone else's account.
 *
 * `config` holds secrets (a Canvas per-user token). It is `v.any()` in the
 * schema because each adapter needs a different shape, which makes redaction on
 * the read path non-negotiable — see `redactConfig`.
 */

const SECRET_KEYS = new Set([
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "password",
  "secret",
  "apiKey",
])

/**
 * Never return a token to a client. Presence is still useful to the UI ("your
 * Canvas token is set"), so secrets become a boolean-ish marker rather than
 * vanishing.
 */
export function redactConfig(config: unknown): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) return config
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key) ? (value ? "[set]" : null) : value
  }
  return out
}

const sourceSummaryV = v.object({
  _id: v.id("sources"),
  _creationTime: v.number(),
  studentId: v.id("students"),
  kind: sourceConfigKindV,
  config: v.any(),
  enabled: v.boolean(),
  lastPolledAt: v.optional(v.number()),
  health: sourceHealthV,
})

const summarize = (source: Doc<"sources">) => ({
  _id: source._id,
  _creationTime: source._creationTime,
  studentId: source.studentId,
  kind: source.kind,
  config: redactConfig(source.config),
  enabled: source.enabled,
  lastPolledAt: source.lastPolledAt,
  health: source.health,
})

/**
 * Register a source for the signed-in student. Idempotent per (kind, identity
 * key) so onboarding can re-submit a Canvas token without stacking duplicate
 * sources that would each poll on their own schedule.
 */
export const add = mutation({
  args: {
    kind: sourceConfigKindV,
    config: v.any(),
    enabled: v.optional(v.boolean()),
  },
  returns: v.id("sources"),
  handler: async (ctx, args) => {
    const student = await getCurrentStudent(ctx)
    if (!student) throw new Error("404: no student for this identity; call students.ensure")

    validateSourceConfig(args.kind, args.config)

    const identityKey = sourceIdentityKey(args.kind, args.config)
    const existing = await ctx.db
      .query("sources")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(100)
    const match = existing.find(
      (source) =>
        source.kind === args.kind &&
        sourceIdentityKey(source.kind, source.config) === identityKey
    )

    if (match) {
      await ctx.db.patch("sources", match._id, {
        config: args.config,
        enabled: args.enabled ?? true,
      })
      return match._id
    }

    return await ctx.db.insert("sources", {
      studentId: student._id,
      kind: args.kind,
      config: args.config,
      enabled: args.enabled ?? true,
      health: { status: "unknown", at: Date.now() },
    })
  },
})

// ---------------------------------------------------------------------------
// config validation
// ---------------------------------------------------------------------------

/**
 * `config` is a student-supplied URL that a poller later fetches *from the
 * server*, with a Canvas bearer token attached in the Canvas case, and whose
 * response body is stored in `snapshots` — i.e. a textbook SSRF lever if left
 * unchecked. The host rules live in `convex/lib/net.ts`, shared with the Canvas
 * client's pagination follower (which faces the same lever via `rel="next"`).
 */

/**
 * Per-kind shape check for `config`. The schema keeps `v.any()` because every
 * adapter needs a different bag, which is exactly why the check has to live
 * here, on the only public write path. `mode: "fixture"` is exempt: it never
 * touches the network (core.md "Test data").
 */
export function validateSourceConfig(kind: string, config: unknown): void {
  const bag =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {}
  const isFixture = bag.mode === "fixture"

  switch (kind) {
    case "ical":
    case "calendar": {
      if (isFixture) return
      requireFetchableUrl("ical config.url", bag.url)
      return
    }
    case "canvas": {
      if (isFixture) return
      requireFetchableUrl("canvas config.baseUrl", bag.baseUrl)
      if (typeof bag.token !== "string" || bag.token.trim().length === 0) {
        throw new Error("400: canvas config.token must be a non-empty string")
      }
      return
    }
    case "site": {
      if (isFixture) return
      // A course site is fetched server-side by `ingest/site.ts`, and the links
      // it discovers in the response are fetched too, so the seed gets exactly
      // the same treatment as an iCal feed.
      requireFetchableUrl("site config.url", bag.url)
      return
    }
    case "syllabus":
    case "schedule": {
      // Uploads, not feeds: nothing here is ever fetched from the network, so
      // there is no URL to require. The config carries Convex references
      // (`storageId`, `courseId`) that `ingest/uploads.ts` sets server-side.
      // A URL is not *needed*, but if one is supplied it must still be safe —
      // an unchecked url on a source row is a lever waiting for the next
      // adapter that decides to fetch it.
      if (bag.url !== undefined) requireFetchableUrl(`${kind} config.url`, bag.url)
      return
    }
    default:
      throw new Error(`400: sources.add does not accept kind "${kind}" yet`)
  }
}

/** What distinguishes two sources of the same kind: the thing being polled. */
function sourceIdentityKey(kind: string, config: unknown): string {
  const bag =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {}
  const parts = [bag.baseUrl, bag.url, bag.courseId, bag.mode]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join("|")
  return `${kind}:${parts}`
}

/** The student's own sources, tokens redacted. Health drives the Face banner. */
export const list = query({
  args: {},
  returns: v.array(sourceSummaryV),
  handler: async (ctx) => {
    const student = await getCurrentStudent(ctx)
    if (!student) return []
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .take(100)
    return sources.map(summarize)
  },
})

/** Disable a source without deleting its snapshots (they stay the audit trail). */
export const setEnabled = mutation({
  args: { sourceId: v.id("sources"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) throw new Error("404: source not found")
    await requireStudent(ctx, source.studentId)
    await ctx.db.patch("sources", args.sourceId, { enabled: args.enabled })
    return null
  },
})

/**
 * "Re-sync now" from the Face connectors view.
 *
 * Feeds (canvas, ical, site) run exactly the poll the cron would have run for
 * this one source; uploads (syllabus, schedule) re-run their extraction from
 * the `storageId` the upload already stored on the config. Both are scheduled,
 * not awaited: a poll is a network call plus a model call, and the tap that
 * asked for it should return immediately.
 *
 * Health is set to `unknown` synchronously so the card can show "syncing…" the
 * moment the mutation lands; the poll or extraction writes the real health when
 * it finishes, exactly as it does on the cron path.
 *
 * Rate-limited per source, because the button is cheap to press and the work
 * behind it is not. An upload re-sync re-runs the extraction past the snapshot
 * hash by design (otherwise an unchanged document is a no-op), so every tap is
 * a model call whether or not the document moved — five minutes. A feed poll
 * only costs a fetch, so it gets a shorter one, enough to absorb a double-tap
 * and an impatient student.
 */
const RESYNC_COOLDOWN_MS = { upload: 5 * 60_000, poll: 60_000 } as const

/** A "re-sync requested" health older than this is an abandoned run, not a live one. */
const RESYNC_IN_FLIGHT_MAX_MS = 15 * 60_000

export const resync = mutation({
  args: { sourceId: v.id("sources") },
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx, args) => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) throw new Error("404: source not found")
    // Ownership on the row, not just "is someone signed in": `sourceId` is a
    // caller-supplied opaque string, and re-syncing someone else's Canvas token
    // is both a write on their account and a probe of ours.
    await requireStudent(ctx, source.studentId)

    // A disabled source is disabled on every path. Re-syncing one would poll a
    // feed the student explicitly switched off and write changes from it.
    if (!source.enabled) throw new Error("400: source is disabled; enable it first")

    const now = Date.now()
    const cooldownMs = isUploadKind(source.kind)
      ? RESYNC_COOLDOWN_MS.upload
      : RESYNC_COOLDOWN_MS.poll
    const since = source.lastResyncRequestedAt
    if (since !== undefined && now - since < cooldownMs) {
      const ago = Math.round((now - since) / 1000)
      const wait = Math.ceil((cooldownMs - (now - since)) / 1000)
      // The message is the UI copy: Face shows it verbatim on the card.
      throw new Error(
        `429: re-sync was requested ${ago}s ago; try again in ${wait}s`
      )
    }

    // Past the cooldown, an UPLOAD re-extraction that is still running must not
    // be joined by a second one: two concurrent model calls on the same
    // document is the exact bill the cooldown exists to prevent. "Running" is
    // the health this mutation wrote and the adapter has not yet replaced; a
    // marker older than `RESYNC_IN_FLIGHT_MAX_MS` is an abandoned run, so a
    // crash cannot wedge the button. Feed polls are a fetch, not a model call,
    // and their own cooldown is enough.
    const inFlight =
      isUploadKind(source.kind) &&
      source.health.status === "unknown" &&
      source.health.message === "re-sync requested" &&
      now - source.health.at < RESYNC_IN_FLIGHT_MAX_MS
    if (inFlight) {
      const ago = Math.round((now - source.health.at) / 1000)
      throw new Error(
        `409: re-sync is still running (requested ${ago}s ago); wait for it to finish`
      )
    }

    // Stamped before anything is scheduled, so the cooldown starts the moment
    // the request is accepted. A request that is then REFUSED (no stored
    // document, no adapter) throws, which rolls the stamp back with the rest of
    // the transaction — a rejected tap must not burn the student's next five
    // minutes.
    await ctx.db.patch("sources", args.sourceId, {
      lastResyncRequestedAt: now,
      health: { status: "unknown", message: "re-sync requested", at: now },
    })

    if (isPollableKind(source.kind)) {
      await schedulePoll(ctx.scheduler, source.kind, args.sourceId)
    } else if (isUploadKind(source.kind)) {
      const storageId = storageIdOf(source.config)
      if (!storageId) {
        throw new Error("400: this upload has no stored document to re-extract")
      }
      await scheduleReextract(ctx.scheduler, source.kind, args.sourceId, storageId)
    } else {
      // `calendar` is registered by the schema but has no adapter yet (core.md
      // "Adapters" #6, Milestone 2). Refusing beats silently doing nothing.
      throw new Error(`400: re-sync is not supported for ${source.kind} sources yet`)
    }

    return { scheduled: true }
  },
})

const storageIdOf = (config: unknown): Id<"_storage"> | undefined => {
  const value =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).storageId
      : undefined
  return typeof value === "string" ? (value as Id<"_storage">) : undefined
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

/** Internal only: this returns the UNREDACTED config, tokens included. */
export const get = internalQuery({
  args: { sourceId: v.id("sources") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("sources"),
      studentId: v.id("students"),
      kind: sourceConfigKindV,
      config: v.any(),
      enabled: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) return null
    return {
      _id: source._id,
      studentId: source.studentId,
      kind: source.kind,
      config: source.config,
      enabled: source.enabled,
    }
  },
})

/** Every enabled source of the given kinds, across students — the cron's worklist. */
export const listEnabled = internalQuery({
  args: {
    kinds: v.array(sourceConfigKindV),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("sources"),
      studentId: v.id("students"),
      kind: sourceConfigKindV,
    })
  ),
  handler: async (ctx, args) => {
    const limit = clamp(args.limit, 500, 2000)
    const out: { _id: Doc<"sources">["_id"]; studentId: Doc<"sources">["studentId"]; kind: Doc<"sources">["kind"] }[] =
      []
    for (const kind of args.kinds) {
      const rows = await ctx.db
        .query("sources")
        .withIndex("by_kind_enabled", (q) => q.eq("kind", kind).eq("enabled", true))
        .take(limit)
      for (const row of rows) {
        out.push({ _id: row._id, studentId: row.studentId, kind: row.kind })
      }
      if (out.length >= limit) break
    }
    return out.slice(0, limit)
  },
})

/**
 * A Canvas per-user token is ToS-gray on institutional instances and can break
 * silently (core.md "Test data"), so health is surfaced rather than logged.
 */
export const setHealth = internalMutation({
  args: {
    sourceId: v.id("sources"),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("stale"),
      v.literal("unknown")
    ),
    message: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) return null
    await ctx.db.patch("sources", args.sourceId, {
      health: {
        status: args.status,
        ...(args.message ? { message: args.message.slice(0, 500) } : {}),
        at: Date.now(),
      },
    })
    return null
  },
})

/** Bumped on every poll, including the ones whose hash was unchanged. */
export const markPolled = internalMutation({
  args: { sourceId: v.id("sources"), at: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) return null
    const at = args.at
    await ctx.db.patch("sources", args.sourceId, {
      lastPolledAt: at !== undefined && Number.isFinite(at) ? at : Date.now(),
    })
    return null
  },
})

function clamp(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback
  return Math.min(Math.floor(value), max)
}
