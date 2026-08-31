import type { ChangeKind } from "./changes"
import type {
  NormalizedCourse,
  NormalizedDeadline,
  NormalizedState,
  SubmissionStatus,
} from "./normalized"

/**
 * The diff engine (plans/core.md, "Snapshot → diff → changes").
 *
 * Pure and keyed by external id: `diff(prevNormalized, nextNormalized)` never
 * touches the database, so it can be replayed over any two snapshots and is
 * fully testable on fixtures with no Canvas access. State updates come *only*
 * from applying the changes it emits.
 */

export type ProposalEntity = "deadlines" | "courses"

export type ChangeProposal = {
  kind: ChangeKind
  entity: ProposalEntity
  /** The external key of the affected entity (`canvas:assignment:5103`). */
  key: string
  /** External key of the owning course, when the entity is a deadline. */
  courseKey?: string
  /**
   * Set when the caller already knows the Convex document id (reconciliation
   * works against rows, not snapshots). The ingest layer prefers this over
   * looking the row up by external id.
   */
  entityId?: string
  before?: unknown
  after?: unknown
  reason?: string
  /** Sources disagree, so it is held for approval rather than silently picked. */
  conflict?: boolean
}

// ---------------------------------------------------------------------------
// document projections
// ---------------------------------------------------------------------------

/**
 * The subset of `deadlines` fields a change carries. Matches `DEADLINE_KEYS` in
 * `lib/changes.ts`, minus `courseId`, which only the ingest layer can resolve
 * (it needs the database to map a course key to an `Id<"courses">`).
 */
export function toDeadlineFields(deadline: NormalizedDeadline) {
  return {
    title: deadline.title,
    kind: deadline.kind,
    ...(deadline.dueAt !== undefined ? { dueAt: deadline.dueAt } : {}),
    ...(deadline.pointsPossible !== undefined
      ? { pointsPossible: deadline.pointsPossible }
      : {}),
    ...(deadline.category !== undefined ? { category: deadline.category } : {}),
    submissionStatus: deadline.submissionStatus,
    ...(deadline.score !== undefined ? { score: deadline.score } : {}),
    ...(deadline.description !== undefined
      ? { description: deadline.description }
      : {}),
    ...(deadline.url !== undefined ? { url: deadline.url } : {}),
    externalIds: deadline.externalIds,
    provenance: deadline.provenance,
    status: "active" as const,
  }
}

export function toCourseFields(course: NormalizedCourse) {
  return {
    name: course.name,
    ...(course.code !== undefined ? { code: course.code } : {}),
    sourceRefs: course.sourceRefs,
    ...(course.gradingScheme !== undefined
      ? { gradingScheme: course.gradingScheme }
      : {}),
    status: course.status,
    provenance: course.provenance,
  }
}

// ---------------------------------------------------------------------------
// deadlines
// ---------------------------------------------------------------------------

const byKey = <T extends { key: string }>(items: T[]) =>
  new Map(items.map((item) => [item.key, item]))

/** `undefined === undefined`, and a missing value never equals a present one. */
const sameNumber = (a: number | undefined, b: number | undefined) =>
  a === undefined ? b === undefined : b !== undefined && a === b

/** Nothing has been handed in yet — the work is still the student's to do. */
const OPEN_SUBMISSION: ReadonlySet<SubmissionStatus> = new Set<SubmissionStatus>([
  "unsubmitted",
  "unknown",
])

/**
 * A submission that went BACKWARDS: a submission deleted, a resubmission window
 * reopened, a grade retracted. The work is the student's again, so this has to
 * reach the row — `submitted`/`grade_posted` would both read as progress.
 */
function isReopening(before: SubmissionStatus, next: SubmissionStatus): boolean {
  if (OPEN_SUBMISSION.has(next) && !OPEN_SUBMISSION.has(before)) return true
  return next === "submitted" && before === "graded"
}

/**
 * One proposal per *fact that changed*, not one per document: a poll that both
 * moves a due date and posts a grade is two separate things worth telling the
 * student, and each proposal carries the full new field set so applying them in
 * any order converges on the same row.
 *
 * Order is deliberate — schedule facts first, then status facts — because the
 * change feed is read top-down.
 */
export function diffDeadlines(
  prev: NormalizedDeadline[],
  next: NormalizedDeadline[]
): ChangeProposal[] {
  const prevByKey = byKey(prev)
  const nextByKey = byKey(next)
  const proposals: ChangeProposal[] = []

  for (const deadline of next) {
    const before = prevByKey.get(deadline.key)
    const after = toDeadlineFields(deadline)
    const base = {
      entity: "deadlines" as const,
      key: deadline.key,
      ...(deadline.courseKey !== undefined ? { courseKey: deadline.courseKey } : {}),
    }

    if (!before) {
      proposals.push({ ...base, kind: "deadline_added", after })
      continue
    }

    if (!sameNumber(before.dueAt, deadline.dueAt)) {
      const from = before.dueAt
      const to = deadline.dueAt
      proposals.push({
        ...base,
        kind: "deadline_moved",
        before: toDeadlineFields(before),
        after,
        reason:
          from !== undefined && to !== undefined
            ? `Due date moved from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`
            : "Due date changed",
      })
    }

    if (
      before.title !== deadline.title ||
      before.kind !== deadline.kind ||
      before.category !== deadline.category ||
      !sameNumber(before.pointsPossible, deadline.pointsPossible)
    ) {
      proposals.push({
        ...base,
        kind: "deadline_updated",
        before: toDeadlineFields(before),
        after,
      })
    }

    // Status transitions. The final `else if` is the catch-all that matters
    // most: a submission that REGRESSES (submitted → unsubmitted after a
    // deletion, graded → submitted after a grade is retracted) must still emit
    // a proposal, or the stored row keeps `submissionStatus: "submitted"` and a
    // stale score, and the planner drops the work from every future plan.
    const statusChanged = before.submissionStatus !== deadline.submissionStatus
    if (statusChanged && isReopening(before.submissionStatus, deadline.submissionStatus)) {
      proposals.push({
        ...base,
        kind: "deadline_updated",
        before: toDeadlineFields(before),
        // A reopened submission must also CLEAR fields the source no longer
        // asserts — `null` here means "unset" to the apply layer (pickDeadline
        // in lib/changes.ts); omitting the key would leave a stale score.
        after: {
          ...after,
          ...(before.score !== undefined && deadline.score === undefined
            ? { score: null }
            : {}),
        },
        reason:
          `Submission reopened: status went from ${before.submissionStatus} ` +
          `back to ${deadline.submissionStatus}`,
      })
    } else if (statusChanged && deadline.submissionStatus === "submitted") {
      proposals.push({
        ...base,
        kind: "submitted",
        before: toDeadlineFields(before),
        after,
      })
    } else if (
      deadline.submissionStatus === "graded" &&
      (statusChanged || !sameNumber(before.score, deadline.score))
    ) {
      proposals.push({
        ...base,
        kind: "grade_posted",
        before: toDeadlineFields(before),
        after,
      })
    } else if (
      statusChanged &&
      (deadline.submissionStatus === "missing" ||
        deadline.submissionStatus === "excused")
    ) {
      proposals.push({
        ...base,
        kind: "deadline_updated",
        before: toDeadlineFields(before),
        after,
        reason: `Submission status is now ${deadline.submissionStatus}`,
      })
    } else if (statusChanged || !sameNumber(before.score, deadline.score)) {
      // Anything left over — an unusual transition, or a score that moved
      // without the status moving. Still a fact worth applying.
      proposals.push({
        ...base,
        kind: "deadline_updated",
        before: toDeadlineFields(before),
        after,
        reason: `Submission status is now ${deadline.submissionStatus}`,
      })
    }
  }

  for (const deadline of prev) {
    if (nextByKey.has(deadline.key)) continue
    proposals.push({
      kind: "deadline_removed",
      entity: "deadlines",
      key: deadline.key,
      ...(deadline.courseKey !== undefined ? { courseKey: deadline.courseKey } : {}),
      before: toDeadlineFields(deadline),
      reason: "No longer returned by the source",
    })
  }

  return proposals
}

// ---------------------------------------------------------------------------
// courses
// ---------------------------------------------------------------------------

const sameGrading = (a: NormalizedCourse, b: NormalizedCourse) =>
  stableStringify(a.gradingScheme ?? null) === stableStringify(b.gradingScheme ?? null)

/**
 * A course that stops being returned is NOT deleted — the work the student did
 * in it still happened. It is marked `hidden`, which is also what keeps it from
 * bouncing back as a `course_added` on the next poll.
 */
export function diffCourses(
  prev: NormalizedCourse[],
  next: NormalizedCourse[]
): ChangeProposal[] {
  const prevByKey = byKey(prev)
  const nextByKey = byKey(next)
  const proposals: ChangeProposal[] = []

  for (const course of next) {
    const before = prevByKey.get(course.key)
    const after = toCourseFields(course)
    if (!before) {
      proposals.push({
        kind: "course_added",
        entity: "courses",
        key: course.key,
        courseKey: course.key,
        after,
      })
      continue
    }
    if (
      before.name !== course.name ||
      before.code !== course.code ||
      before.status !== course.status ||
      !sameGrading(before, course)
    ) {
      proposals.push({
        kind: "course_updated",
        entity: "courses",
        key: course.key,
        courseKey: course.key,
        before: toCourseFields(before),
        after,
      })
    }
  }

  for (const course of prev) {
    if (nextByKey.has(course.key)) continue
    if (course.status === "hidden") continue
    proposals.push({
      kind: "course_updated",
      entity: "courses",
      key: course.key,
      courseKey: course.key,
      before: toCourseFields(course),
      after: { ...toCourseFields(course), status: "hidden" as const },
      reason: "No longer returned by the source",
    })
  }

  return proposals
}

/**
 * Both halves of a snapshot diff, courses first so a newly added course exists
 * before the deadlines that point at it.
 */
export function diffState(
  prev: NormalizedState,
  next: NormalizedState
): ChangeProposal[] {
  return [
    ...diffCourses(prev.courses, next.courses),
    ...diffDeadlines(prev.deadlines, next.deadlines),
  ]
}

// ---------------------------------------------------------------------------
// content hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped. Two payloads
 * that differ only in key order must hash the same, or every poll would look
 * like a change and `snapshots` would stop being append-only-on-change.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
  return `{${entries.join(",")}}`
}

const HEX = "0123456789abcdef"

/**
 * SHA-256 of the stable JSON, hex. Async because it uses Web Crypto, which is
 * ambient in the Convex runtime — no `import crypto`, which would force the
 * file into a Node action. Callers hash in an action and hand the result to the
 * mutation, so no mutation depends on `crypto.subtle`.
 */
export async function hashPayload(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const view = new Uint8Array(digest)
  let out = ""
  for (const byte of view) out += HEX[byte >> 4] + HEX[byte & 15]
  return out
}

/**
 * The hash `snapshots.contentHash` stores — the payload with `fetchedAt`
 * NEUTRALIZED.
 *
 * `fetchedAt` is when we looked, not what the source said. Hashing it makes
 * every poll of an unchanged source hash differently, which would insert a full
 * snapshot row every 30 minutes and quietly break core.md's "stored only when
 * the hash changes" rule. It stays on the snapshot ROW (and inside the payload)
 * — it just does not participate in identity.
 */
export async function hashSnapshotPayload(payload: unknown): Promise<string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return await hashPayload(payload)
  }
  return await hashPayload({ ...(payload as Record<string, unknown>), fetchedAt: 0 })
}
