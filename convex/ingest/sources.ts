import { v } from "convex/values"

import type { Doc } from "../_generated/dataModel"
import { internalMutation, internalQuery, mutation, query } from "../_generated/server"
import { getCurrentStudent, requireStudent } from "../lib/auth"
import { sourceConfigKindV, sourceHealthV } from "../lib/validators"

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
 * Hostnames the backend must never be talked into fetching. `config` is a
 * student-supplied URL that a poller later fetches *from the server*, with a
 * Canvas bearer token attached in the Canvas case, and whose response body is
 * stored in `snapshots` — i.e. a textbook SSRF lever if it is left unchecked.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"])

const isBlockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true
  // IPv4 literals in the private / loopback / link-local ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  }
  // IPv6 loopback / link-local / unique-local.
  if (host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true
  }
  return false
}

/** Throws `400: …` unless `raw` is an absolute, public http(s) URL. */
function requireFetchableUrl(label: string, raw: unknown): void {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`400: ${label} must be a URL`)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`400: ${label} must be an absolute URL`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`400: ${label} must be http(s), not ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error(`400: ${label} must not embed credentials`)
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`400: ${label} must not point at a private or loopback host`)
  }
}

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
