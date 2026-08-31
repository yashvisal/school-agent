import { v } from "convex/values"

import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import { internalAction, internalMutation } from "../_generated/server"
import type { MutationCtx } from "../_generated/server"
import { icalFixturePayload } from "../dev/fixtures"
import { proposeChangeInternal } from "../lib/changes"
import { diffDeadlines, hashSnapshotPayload } from "../lib/diff"
import { normalizeIcal } from "../lib/ical/parse"
import {
  applyProposals,
  courseIdIndex,
  loadCourses,
  storeSnapshot,
} from "../lib/ingest"
import { reconcileIcalWithCanvas, type ExistingDeadlineRef } from "../lib/merge"
import type { NormalizedDeadline } from "../lib/normalized"

/**
 * The iCal adapter (core.md "Adapters" #2): VEVENTs → deadlines, title and date
 * only.
 *
 * Canvas feeds encode the assignment id in the event UID, so dedupe against the
 * Canvas adapter is an exact join on id and Canvas wins on conflict — the one
 * exception being a real date disagreement, which becomes a `conflict` change
 * held for approval rather than a silent pick.
 *
 * `event-calendar-event-*` items are class meetings, not deadlines. They are
 * parsed and left in the snapshot payload for the class-schedule adapter
 * (core.md "Adapters" #5) to turn into the student's hard class blocks; nothing
 * here proposes an `availability_updated` off a raw feed.
 */

type IcalPayload = { kind: "ical"; url: string; fetchedAt: number; text: string }

/** Per-request wall clock for the outbound feed fetch. */
const ICAL_TIMEOUT_MS = 30_000

const isIcalPayload = (payload: unknown): payload is IcalPayload =>
  !!payload &&
  typeof payload === "object" &&
  (payload as { kind?: unknown }).kind === "ical" &&
  typeof (payload as { text?: unknown }).text === "string"

const ingestResultV = v.object({
  snapshotId: v.id("snapshots"),
  created: v.boolean(),
  proposed: v.number(),
  applied: v.number(),
  pending: v.number(),
  skipped: v.number(),
  /** Feed items Canvas (or a fuzzy title match) already covers. */
  deduped: v.number(),
  classEvents: v.number(),
})

type IngestResult = {
  snapshotId: Id<"snapshots">
  created: boolean
  proposed: number
  applied: number
  pending: number
  skipped: number
  deduped: number
  classEvents: number
}

/** `code:sta210` — how an iCal `[STA210]` suffix finds its course. */
const codeKey = (code: string) => `code:${code.toLowerCase()}`

const withCourseKeys = (deadlines: NormalizedDeadline[]): NormalizedDeadline[] =>
  deadlines.map((deadline) =>
    deadline.courseCode ? { ...deadline, courseKey: codeKey(deadline.courseCode) } : deadline
  )

export const ingestPayload = internalMutation({
  args: {
    sourceId: v.id("sources"),
    payload: v.any(),
    contentHash: v.string(),
    label: v.optional(v.string()),
  },
  returns: ingestResultV,
  handler: async (ctx, args): Promise<IngestResult> => {
    const source = await ctx.db.get("sources", args.sourceId)
    if (!source) throw new Error("404: source not found")
    if (!isIcalPayload(args.payload)) {
      throw new Error("ingest.ical: payload is not an iCal snapshot")
    }

    const { snapshotId, created, previous } = await storeSnapshot(ctx, {
      sourceId: args.sourceId,
      studentId: source.studentId,
      payload: args.payload,
      contentHash: args.contentHash,
      label: args.label,
      fetchedAt: args.payload.fetchedAt,
    })

    const parsed = normalizeIcal(args.payload.text, args.payload.url)
    if (!created) {
      return {
        snapshotId,
        created: false,
        proposed: 0,
        applied: 0,
        pending: 0,
        skipped: 0,
        deduped: 0,
        classEvents: parsed.classEvents.length,
      }
    }

    const deadlines = withCourseKeys(parsed.deadlines)
    const existingRows = await loadDeadlines(ctx, source.studentId)
    const courses = await loadCourses(ctx, source.studentId)
    const courseIds = courseIdIndex(courses)
    const courseKeyByCourseId = new Map<Id<"courses">, string>()
    for (const course of courses) {
      const key = course.sourceRefs.canvasCourseId
        ? `canvas:course:${course.sourceRefs.canvasCourseId}`
        : course.code
          ? codeKey(course.code)
          : `courseid:${course._id}`
      courseIds.set(key, course._id)
      courseKeyByCourseId.set(course._id, key)
    }

    const existing: ExistingDeadlineRef[] = existingRows.map((row) => ({
      key: row._id,
      ...(row.externalIds.canvasAssignmentId
        ? { canvasAssignmentId: row.externalIds.canvasAssignmentId }
        : {}),
      ...(row.externalIds.icalUid ? { icalUid: row.externalIds.icalUid } : {}),
      title: row.title,
      ...(row.dueAt !== undefined ? { dueAt: row.dueAt } : {}),
      ...(courseKeyByCourseId.has(row.courseId)
        ? { courseKey: courseKeyByCourseId.get(row.courseId) }
        : {}),
    }))

    const reconciled = reconcileIcalWithCanvas(deadlines, existing)

    // iCal-vs-iCal diff, for the items Canvas does not own. Fuzzy-suppressed
    // items are excluded from BOTH sides, or one would look removed next poll.
    const fuzzy = new Set(reconciled.fuzzyKeys)
    const isOwn = (deadline: NormalizedDeadline) =>
      !deadline.externalIds.canvasAssignmentId && !fuzzy.has(deadline.key)

    const previousDeadlines =
      previous && isIcalPayload(previous.payload)
        ? withCourseKeys(normalizeIcal(previous.payload.text, previous.payload.url).deadlines)
        : []

    const ownProposals = diffDeadlines(
      previousDeadlines.filter(isOwn),
      deadlines.filter(isOwn)
    )

    const snapshotIds = previous ? [previous._id, snapshotId] : [snapshotId]

    const fallbackCourseId =
      ownProposals.length > 0
        ? await ensureCalendarCourse(ctx, {
            studentId: source.studentId,
            url: args.payload.url,
            courses,
            snapshotIds,
          })
        : undefined

    const outcome = await applyProposals(ctx, {
      studentId: source.studentId,
      proposals: [...reconciled.proposals, ...ownProposals],
      origin: "ical",
      snapshotIds,
      courseIds,
      ...(fallbackCourseId ? { fallbackCourseId } : {}),
    })

    return {
      snapshotId,
      created: true,
      ...outcome,
      deduped: reconciled.matchedKeys.length,
      classEvents: parsed.classEvents.length,
    }
  },
})

async function loadDeadlines(
  ctx: MutationCtx,
  studentId: Id<"students">,
  limit = 1000
): Promise<Doc<"deadlines">[]> {
  return await ctx.db
    .query("deadlines")
    .withIndex("by_student_dueAt", (q) => q.eq("studentId", studentId))
    .take(limit)
}

/**
 * A `deadlines` row must belong to a course, but a plain `.ics` need not name
 * one. Rather than invent a course per event or drop the deadline, everything
 * unattributable from one feed lands in a single per-feed course the student
 * can see and rename.
 *
 * Created through `proposeChangeInternal`, not `ctx.db.insert`: this is a
 * student-facing `courses` row, and the changes pipeline is the only write path
 * to student state (CLAUDE.md). Origin `ical` is authoritative and unconflicted,
 * so the change applies immediately and the feed can still explain where the
 * course came from.
 */
async function ensureCalendarCourse(
  ctx: MutationCtx,
  input: {
    studentId: Id<"students">
    url: string
    courses: Doc<"courses">[]
    snapshotIds: Id<"snapshots">[]
  }
): Promise<Id<"courses"> | undefined> {
  const existing = input.courses.find(
    (course) => course.sourceRefs.icalUrl === input.url
  )
  if (existing) return existing._id

  let label = "Calendar"
  try {
    label = `Calendar (${new URL(input.url).hostname})`
  } catch {
    // A fixture or relative url: the generic label is fine.
  }

  const outcome = await proposeChangeInternal(ctx, {
    studentId: input.studentId,
    kind: "course_added",
    entity: { table: "courses" },
    after: {
      name: label,
      sourceRefs: { icalUrl: input.url },
      status: "active",
      provenance: {
        source: "ical",
        sourceRef: input.url,
        confidence: 1,
        snapshotId: input.snapshotIds[input.snapshotIds.length - 1],
      },
    },
    origin: "ical",
    snapshotIds: input.snapshotIds,
    reason: `Deadlines from ${input.url} name no course, so they land here.`,
  })

  const change = await ctx.db.get("changes", outcome.changeId)
  return change?.entity.id as Id<"courses"> | undefined
}

/**
 * One poll of one iCal source. `config.mode === "fixture"` reads the bundled
 * hand-authored feed instead of the network (core.md "Test data").
 */
export const poll = internalAction({
  args: { sourceId: v.id("sources") },
  returns: v.object({
    ok: v.boolean(),
    created: v.boolean(),
    proposed: v.number(),
    pending: v.number(),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const source = await ctx.runQuery(internal.ingest.sources.get, {
      sourceId: args.sourceId,
    })
    if (!source) throw new Error("404: source not found")
    if (source.kind !== "ical") {
      throw new Error(`ingest.ical.poll: source ${args.sourceId} is ${source.kind}`)
    }

    try {
      const payload = await icalPayloadFor(source.config)
      const contentHash = await hashSnapshotPayload(payload)
      const result: IngestResult = await ctx.runMutation(
        internal.ingest.ical.ingestPayload,
        { sourceId: args.sourceId, payload, contentHash }
      )
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: "ok",
      })
      return {
        ok: true,
        created: result.created,
        proposed: result.proposed,
        pending: result.pending,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: "error",
        message,
      })
      await ctx.runMutation(internal.ingest.sources.markPolled, {
        sourceId: args.sourceId,
      })
      return { ok: false, created: false, proposed: 0, pending: 0, error: message }
    }
  },
})

async function icalPayloadFor(config: unknown): Promise<IcalPayload> {
  const bag =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {}

  if (bag.mode === "fixture") {
    const variant =
      bag.variant === "generic" || bag.variant === "conflict"
        ? (bag.variant as "generic" | "conflict")
        : "canvas"
    return icalFixturePayload({ variant })
  }

  const url = typeof bag.url === "string" ? bag.url : ""
  if (!url) throw new Error("ical source config needs { url } or { mode: 'fixture' }")

  // Bounded like the Canvas client: a stalled host would otherwise hold the
  // action open until the platform limit and delay every later poll.
  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(ICAL_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`iCal ${response.status} for ${url}`)
  const text = await response.text()
  return { kind: "ical", url, fetchedAt: Date.now(), text }
}
