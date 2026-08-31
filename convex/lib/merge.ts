import type { ChangeProposal } from "./diff"
import { toDeadlineFields } from "./diff"
import type { NormalizedDeadline } from "./normalized"

/**
 * Merge precedence and cross-source reconciliation.
 *
 * plans/core.md: "Canvas (status/dates) > syllabus (grading scheme) > iCal >
 * site. Unresolvable conflict → `needs_approval`, never a silent pick."
 */

export const SOURCE_PRECEDENCE: Record<string, number> = {
  // The student typing it themselves outranks every feed.
  manual: 100,
  canvas: 40,
  syllabus: 30,
  ical: 20,
  site: 10,
  schedule: 10,
  chat: 5,
}

export const precedenceOf = (source: string): number => SOURCE_PRECEDENCE[source] ?? 0

/** True when `candidate` may overwrite a fact currently sourced from `incumbent`. */
export const outranks = (candidate: string, incumbent: string): boolean =>
  precedenceOf(candidate) > precedenceOf(incumbent)

/**
 * Two datetimes count as agreeing within a minute. Canvas and its own iCal feed
 * round differently on some instances, and a sub-minute delta is noise, not a
 * rescheduled deadline.
 */
export const CONFLICT_TOLERANCE_MS = 60_000

/** Fuzzy fallback window: same title, due within a day. */
export const FUZZY_WINDOW_MS = 24 * 60 * 60 * 1000

/** A deadline already in the database, projected to what reconciliation needs. */
export type ExistingDeadlineRef = {
  /** Opaque to this module; the ingest layer passes the document id. */
  key: string
  canvasAssignmentId?: string
  icalUid?: string
  title: string
  dueAt?: number
  courseKey?: string
}

export type IcalReconciliation = {
  /** Conflicts to hold for approval. Never applied automatically. */
  proposals: ChangeProposal[]
  /** iCal items with no counterpart in existing state — genuinely new. */
  unmatched: NormalizedDeadline[]
  /** Items suppressed because Canvas (or a fuzzy match) already covers them. */
  matchedKeys: string[]
  /**
   * The subset of `matchedKeys` suppressed by the FUZZY fallback. The caller
   * must exclude these from its own iCal-vs-iCal diff, or an item that was
   * suppressed on ingest would look "removed" on the next poll.
   */
  fuzzyKeys: string[]
}

/** Lowercase alphanumerics only, so punctuation and spacing never break a match. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Join an iCal feed against deadlines already in state.
 *
 * Canvas encodes the assignment id in the UID (`event-assignment-<id>`), so the
 * primary join is exact on that id — no fuzzy matching, no duplicates. When it
 * hits, iCal contributes nothing, because Canvas outranks it. The one exception
 * is a real disagreement about the date: that is not a silent pick, so it
 * becomes a `deadline_moved` proposal flagged `conflict`, which the two-tier
 * rule turns into `needs_approval` even though iCal is a structured source.
 *
 * Fuzzy matching (same normalized title, due within a day) is the fallback for
 * NON-Canvas UIDs only, and only ever suppresses a duplicate — it never
 * proposes a change, because a title match is not evidence enough to move a date.
 */
export function reconcileIcalWithCanvas(
  icalDeadlines: NormalizedDeadline[],
  existing: ExistingDeadlineRef[]
): IcalReconciliation {
  const byCanvasId = new Map<string, ExistingDeadlineRef>()
  const byIcalUid = new Map<string, ExistingDeadlineRef>()
  for (const ref of existing) {
    if (ref.canvasAssignmentId) byCanvasId.set(ref.canvasAssignmentId, ref)
    if (ref.icalUid) byIcalUid.set(ref.icalUid, ref)
  }

  const proposals: ChangeProposal[] = []
  const unmatched: NormalizedDeadline[] = []
  const matchedKeys: string[] = []
  const fuzzyKeys: string[] = []

  for (const deadline of icalDeadlines) {
    const canvasId = deadline.externalIds.canvasAssignmentId

    if (canvasId) {
      const match = byCanvasId.get(canvasId)
      if (match) {
        matchedKeys.push(deadline.key)
        const drift =
          match.dueAt !== undefined && deadline.dueAt !== undefined
            ? Math.abs(match.dueAt - deadline.dueAt)
            : 0
        if (drift > CONFLICT_TOLERANCE_MS) {
          proposals.push({
            kind: "deadline_moved",
            entity: "deadlines",
            key: match.key,
            entityId: match.key,
            ...(match.courseKey !== undefined ? { courseKey: match.courseKey } : {}),
            before: { dueAt: match.dueAt },
            after: { dueAt: deadline.dueAt },
            conflict: true,
            reason:
              `The calendar feed says ${new Date(deadline.dueAt as number).toISOString()} ` +
              `but Canvas says ${new Date(match.dueAt as number).toISOString()}. ` +
              `Canvas normally wins, so this is held for you to confirm.`,
          })
        }
        continue
      }
      // A Canvas-style UID with no Canvas row yet: the feed is ahead of the
      // poll (or the course was not returned). Treat it as genuinely new.
      unmatched.push(deadline)
      continue
    }

    const uidMatch = deadline.externalIds.icalUid
      ? byIcalUid.get(deadline.externalIds.icalUid)
      : undefined
    if (uidMatch) {
      matchedKeys.push(deadline.key)
      continue
    }

    const fuzzy = findFuzzyMatch(deadline, existing)
    if (fuzzy) {
      matchedKeys.push(deadline.key)
      fuzzyKeys.push(deadline.key)
      continue
    }

    unmatched.push(deadline)
  }

  return { proposals, unmatched, matchedKeys, fuzzyKeys }
}

function findFuzzyMatch(
  deadline: NormalizedDeadline,
  existing: ExistingDeadlineRef[]
): ExistingDeadlineRef | undefined {
  const title = normalizeTitle(deadline.title)
  if (title.length === 0) return undefined
  for (const ref of existing) {
    if (normalizeTitle(ref.title) !== title) continue
    if (deadline.dueAt === undefined || ref.dueAt === undefined) return ref
    if (Math.abs(ref.dueAt - deadline.dueAt) <= FUZZY_WINDOW_MS) return ref
  }
  return undefined
}

/**
 * Convenience for the ingest layer: the `after` bag for an iCal-only deadline,
 * shaped like the `deadlines` document fields the changes pipeline applies.
 */
export const icalDeadlineFields = (deadline: NormalizedDeadline) =>
  toDeadlineFields(deadline)
