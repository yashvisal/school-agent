import type { Infer } from "convex/values"

import type { ChangeProposal } from "./diff"
import { toDeadlineFields } from "./diff"
import type { NormalizedDeadline } from "./normalized"
import type { sourceKindV } from "./validators"

/**
 * Merge precedence and cross-source reconciliation.
 *
 * plans/core.md: "Canvas (status/dates) > syllabus (grading scheme) > iCal >
 * site. Unresolvable conflict → `needs_approval`, never a silent pick."
 */

export type SourceKind = Infer<typeof sourceKindV>

/**
 * Keyed by the source-kind union, not `string`: adding a source kind to
 * `validators.ts` is then a type error here until it is given a rank, rather
 * than silently defaulting to zero.
 */
export const SOURCE_PRECEDENCE: Record<SourceKind, number> = {
  // The student typing it themselves outranks every feed.
  manual: 100,
  canvas: 40,
  syllabus: 30,
  ical: 20,
  site: 10,
  schedule: 10,
  chat: 5,
}

export const precedenceOf = (source: SourceKind): number => SOURCE_PRECEDENCE[source] ?? 0

/** True when `candidate` may overwrite a fact currently sourced from `incumbent`. */
export const outranks = (candidate: SourceKind, incumbent: SourceKind): boolean =>
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
        const bothDated = match.dueAt !== undefined && deadline.dueAt !== undefined
        const drift = bothDated
          ? Math.abs((match.dueAt as number) - (deadline.dueAt as number))
          : 0
        // One side has no date at all. The two cases are NOT symmetric:
        //   - Canvas has a date, the feed does not: Canvas outranks iCal on
        //     dates, so it simply wins. Nothing to ask the student about.
        //   - The feed has a date and the Canvas row does not: the sources
        //     disagree about whether a date exists at all, which is exactly the
        //     "unresolvable conflict → needs_approval, never a silent pick"
        //     case in core.md.
        const feedOnlyDate = match.dueAt === undefined && deadline.dueAt !== undefined
        if (drift > CONFLICT_TOLERANCE_MS || feedOnlyDate) {
          proposals.push({
            kind: "deadline_moved",
            entity: "deadlines",
            key: match.key,
            entityId: match.key,
            ...(match.courseKey !== undefined ? { courseKey: match.courseKey } : {}),
            before: { dueAt: match.dueAt },
            after: { dueAt: deadline.dueAt },
            conflict: true,
            reason: feedOnlyDate
              ? `The calendar feed says ${new Date(deadline.dueAt as number).toISOString()} ` +
                `but Canvas has no due date for this at all. ` +
                `Canvas normally wins, so this is held for you to confirm.`
              : `The calendar feed says ${new Date(deadline.dueAt as number).toISOString()} ` +
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

// ---------------------------------------------------------------------------
// LLM extraction (syllabus / course site) vs. what state already holds
// ---------------------------------------------------------------------------

/**
 * What to do with one extracted deadline, given the deadlines already stored
 * for the same course.
 *
 * - `duplicate` — Canvas (or an earlier parse) already has this item on this
 *   day. The syllabus adds nothing, so nothing is proposed. Silence here is
 *   correct: precedence says syllabus never outranks Canvas on dates, so a
 *   re-statement of the same date is not news.
 * - `moved` — same item, different day. NOT applied: the syllabus loses to
 *   Canvas on dates, and "loses" does not mean "is discarded", it means the
 *   disagreement is surfaced. Always `conflict: true` → `needs_approval`.
 * - `new` — no counterpart. A genuinely new deadline the feeds never carried
 *   (dated readings and psets that live only in the syllabus are the whole
 *   reason adapter #3 exists).
 */
export type ExtractedMatch =
  | { outcome: "duplicate"; existing: ExistingDeadlineRef }
  | { outcome: "moved"; existing: ExistingDeadlineRef }
  | { outcome: "new" }

/**
 * Match an extracted deadline against existing rows **of the same course**.
 *
 * The caller narrows `existing` to one course before calling: a syllabus is a
 * per-course document, and "Problem Set 3" exists in half the student's
 * courses, so a title match across courses would suppress real work.
 *
 * `sameDay` is injected rather than computed here because "the same day" is a
 * question about the student's wall clock — a syllabus states a date, and this
 * module has no timezone. Callers pass a comparison in the student's zone.
 */
export function matchExtractedDeadline(
  deadline: NormalizedDeadline,
  existing: ExistingDeadlineRef[],
  sameDay: (a: number, b: number) => boolean
): ExtractedMatch {
  const title = normalizeTitle(deadline.title)
  if (title.length === 0) return { outcome: "new" }

  let undatedMatch: ExistingDeadlineRef | undefined
  let movedCandidate: ExistingDeadlineRef | undefined
  for (const ref of existing) {
    if (normalizeTitle(ref.title) !== title) continue

    // The syllabus states no date. Whatever the row has, the syllabus does not
    // contradict it, so there is nothing to add and nothing to ask about.
    if (deadline.dueAt === undefined) return { outcome: "duplicate", existing: ref }

    if (ref.dueAt === undefined) {
      // The row has no date and the syllabus does. That IS a disagreement about
      // whether a date exists — core.md's "one-sided disagreement" case — but
      // keep looking for a dated row with the same title first, which would be
      // the more specific answer.
      undatedMatch = undatedMatch ?? ref
      continue
    }
    if (sameDay(ref.dueAt, deadline.dueAt)) return { outcome: "duplicate", existing: ref }
    // Same title, different day — but a course can hold two same-titled rows
    // ("Quiz" on Oct 1 and Oct 8), so keep scanning: a same-day row later in
    // the list must win over this one, or iteration order manufactures a
    // conflict that is not real (CR 3898632555).
    movedCandidate = movedCandidate ?? ref
  }

  if (movedCandidate) return { outcome: "moved", existing: movedCandidate }
  return undatedMatch ? { outcome: "moved", existing: undatedMatch } : { outcome: "new" }
}

function findFuzzyMatch(
  deadline: NormalizedDeadline,
  existing: ExistingDeadlineRef[]
): ExistingDeadlineRef | undefined {
  const title = normalizeTitle(deadline.title)
  if (title.length === 0) return undefined
  for (const ref of existing) {
    if (normalizeTitle(ref.title) !== title) continue
    // "Problem Set 3" exists in half the student's courses. When BOTH sides
    // name a course, a mismatch is decisive: suppressing here would silently
    // drop a real deadline from another course. When either side is silent
    // (a bare `.ics` names no course), fall back to title + date alone.
    if (
      deadline.courseKey !== undefined &&
      ref.courseKey !== undefined &&
      deadline.courseKey !== ref.courseKey
    ) {
      continue
    }
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
