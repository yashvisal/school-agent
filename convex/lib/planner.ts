import type { Infer } from "convex/values"

import type { Doc } from "../_generated/dataModel"
import {
  PRIOR_CONFIDENCE,
  SIGNAL_CONFIDENCE,
  parsePacingHint,
  priorFor,
} from "./effortPriors"
import {
  addDays,
  dayOfWeekOf,
  daysBetween,
  formatClock,
  formatDateLabel,
  formatDuration,
  formatLocalDateTime,
  localDate,
  localMinutes,
} from "./time"
import type { deadlineKindV, effortConfidenceV } from "./validators"

/**
 * Planner v0 — the deterministic half of the seam (vision §10, core.md "Planner v0").
 *
 * Pure: no ctx, no clock, no LLM. It takes applied facts in and returns the set
 * of *feasible* actions for one day, each annotated with plain-English facts.
 * The agent chooses among them and does the talking; it never generates the set.
 *
 * Two things this file deliberately does not do:
 *
 * 1. **No importance formula.** There is no score, no ranking, no priority. The
 *    annotations *are* what the LLM weighs (core.md, vision §9).
 * 2. **No planning on pending values.** A deadline touched by a pending change is
 *    emitted on its *applied* facts and carries a `pending` annotation, so the
 *    agent can mention it and ask for a one-word confirmation (core.md rule 3/4).
 *    It is never silently dropped and never silently planned on the new value.
 *
 * Hard guarantees, enforced here and tested in `planner.test.ts`:
 * - No proposed window overlaps a class block.
 * - No proposed window ends after the deadline's due time.
 * - Deadlines that are submitted/graded/excused or `status: "removed"` never appear.
 */

export const DEFAULT_HORIZON_DAYS = 14

/** A window shorter than this is not worth proposing as a work block. */
export const MIN_BLOCK_MIN = 30

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Window = {
  /** Minutes from local midnight. */
  startMin: number
  endMin: number
  durationMin: number
}

export type Fit = {
  /** Index into the returned `windows` array. */
  windowIndex: number
  startMin: number
  endMin: number
}

export type PendingAnnotation = {
  changeId: string
  kind: string
  summary: string
  /** "YYYY-MM-DD" the pending value would land on, when it names a date. */
  affectsDate?: string
}

export type SignalsDigest = {
  availability: string[]
  pacing: string[]
  preference: string[]
  difficulty: string[]
  life_event: string[]
  other: string[]
}

export type Option = {
  taskId?: string
  deadlineId?: string
  courseId?: string
  courseName?: string
  title: string
  kind: Infer<typeof deadlineKindV>
  dueAt?: number
  /** Whole days from the planned date to the due date; 0 = due today. */
  dueInDays?: number
  pointsPossible?: number
  category?: string
  /** Fraction or percentage exactly as the syllabus stated it. */
  categoryWeight?: number
  estEffortMin: number
  estEffortConfidence: Infer<typeof effortConfidenceV>
  effortSource: "prior" | "signal"
  fits: Fit[]
  /** Free windows between the planned date and the due date, inclusive. */
  remainingWindowsBeforeDue: number
  /** Plain-English facts. The agent weighs these; nothing here is a score. */
  facts: string[]
  pending?: string[]
  signals?: string[]
}

export type FeasibleActions = {
  date: string
  windows: Window[]
  options: Option[]
  pending: PendingAnnotation[]
  signalsDigest: SignalsDigest
}

export type FeasibleActionsInput = {
  /** Target day, "YYYY-MM-DD", in the student's timezone. */
  date: string
  timezone: string
  now: number
  student: Pick<Doc<"students">, "classBlocks" | "availability">
  courses: Doc<"courses">[]
  deadlines: Doc<"deadlines">[]
  tasks: Doc<"tasks">[]
  pendingChanges: Doc<"changes">[]
  signals: Doc<"studentSignals">[]
  horizonDays?: number
}

type Interval = { startMin: number; endMin: number }

/** Submission states that mean "there is nothing left to do". */
const CLOSED_SUBMISSION: ReadonlySet<Doc<"deadlines">["submissionStatus"]> = new Set([
  "submitted",
  "graded",
  "excused",
])

const OPEN_TASK: ReadonlySet<Doc<"tasks">["status"]> = new Set(["todo", "in_progress"])

const SIGNAL_DIGEST_LIMIT = 20

// ---------------------------------------------------------------------------
// Interval algebra
// ---------------------------------------------------------------------------

function normalize(intervals: Interval[]): Interval[] {
  const clipped = intervals
    .map((i) => ({
      startMin: Math.max(0, Math.min(1440, Math.round(i.startMin))),
      endMin: Math.max(0, Math.min(1440, Math.round(i.endMin))),
    }))
    .filter((i) => i.endMin > i.startMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

  const merged: Interval[] = []
  for (const next of clipped) {
    const last = merged[merged.length - 1]
    if (last && next.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, next.endMin)
    } else {
      merged.push({ ...next })
    }
  }
  return merged
}

function subtract(from: Interval[], holes: Interval[]): Interval[] {
  let result = normalize(from)
  for (const hole of normalize(holes)) {
    const next: Interval[] = []
    for (const span of result) {
      if (hole.endMin <= span.startMin || hole.startMin >= span.endMin) {
        next.push(span)
        continue
      }
      if (hole.startMin > span.startMin) {
        next.push({ startMin: span.startMin, endMin: hole.startMin })
      }
      if (hole.endMin < span.endMin) {
        next.push({ startMin: hole.endMin, endMin: span.endMin })
      }
    }
    result = next
  }
  return result
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The day's free intervals: availability for that weekday (an `exceptions` entry
 * for the exact date replaces the weekly template wholesale), minus every class
 * block on that weekday, minus anything already in the past.
 */
export function windowsForDate(
  input: Pick<FeasibleActionsInput, "timezone" | "now" | "student">,
  date: string
): Window[] {
  const { student, timezone, now } = input
  const dow = dayOfWeekOf(date, timezone)

  const exception = student.availability.exceptions.find((e) => e.date === date)
  const available: Interval[] = exception
    ? exception.blocks.map((b) => ({ startMin: b.startMin, endMin: b.endMin }))
    : student.availability.weekly
        .filter((b) => b.dayOfWeek === dow)
        .map((b) => ({ startMin: b.startMin, endMin: b.endMin }))

  const classes: Interval[] = student.classBlocks
    .filter((b) => b.dayOfWeek === dow)
    .map((b) => ({ startMin: b.startMin, endMin: b.endMin }))

  // A day already begun offers only the rest of itself; a day already gone
  // offers nothing at all.
  const today = localDate(now, timezone)
  let past = 0
  if (date < today) past = 1440
  else if (date === today) past = localMinutes(now, timezone)

  const free = subtract(available, [...classes, { startMin: 0, endMin: past }])
  return free.map((i) => ({
    startMin: i.startMin,
    endMin: i.endMin,
    durationMin: i.endMin - i.startMin,
  }))
}

// ---------------------------------------------------------------------------
// Pending-change summaries
// ---------------------------------------------------------------------------

const asBag = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

function summarizePending(change: Doc<"changes">, timezone: string): PendingAnnotation {
  const after = asBag(change.after)
  const dueAt = typeof after.dueAt === "number" ? after.dueAt : undefined
  const title = typeof after.title === "string" ? after.title : undefined

  let summary: string
  switch (change.kind) {
    case "deadline_moved":
      summary = dueAt
        ? `due date may move to ${formatLocalDateTime(dueAt, timezone)}`
        : "due date may move"
      break
    case "deadline_added":
      summary = `a deadline may be added${title ? ` ("${title}")` : ""}${
        dueAt ? `, due ${formatLocalDateTime(dueAt, timezone)}` : ""
      }`
      break
    case "deadline_removed":
      summary = "this deadline may be removed"
      break
    case "submitted":
      summary = "this may already be submitted"
      break
    case "availability_updated":
      summary = "your availability may change"
      break
    default:
      summary = `unconfirmed ${change.kind.replace(/_/g, " ")}`
  }
  if (change.conflict) summary += " (sources disagree)"

  return {
    changeId: change._id,
    kind: change.kind,
    summary,
    affectsDate: dueAt === undefined ? undefined : localDate(dueAt, timezone),
  }
}

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

type EffortEstimate = {
  estEffortMin: number
  estEffortConfidence: Infer<typeof effortConfidenceV>
  effortSource: "prior" | "signal"
  /** The signal text the estimate came from, when it came from one. */
  signalText?: string
}

function estimateEffort(
  kind: Infer<typeof deadlineKindV>,
  task: Doc<"tasks"> | undefined,
  pacingSignals: Doc<"studentSignals">[]
): EffortEstimate {
  const base = task?.estEffortMin ?? priorFor(kind)

  // Most recent readable pacing signal for this course wins.
  for (const signal of pacingSignals) {
    const hint = parsePacingHint(signal.text)
    if (!hint) continue
    const minutes =
      hint.kind === "multiplier"
        ? Math.round(base * hint.multiplier)
        : Math.round(hint.minutes)
    return {
      estEffortMin: minutes,
      estEffortConfidence: SIGNAL_CONFIDENCE,
      effortSource: "signal",
      signalText: signal.text,
    }
  }

  return {
    estEffortMin: base,
    estEffortConfidence: task?.estEffortMin
      ? (task.estEffortConfidence ?? PRIOR_CONFIDENCE)
      : PRIOR_CONFIDENCE,
    effortSource: "prior",
  }
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

export function feasibleActions(input: FeasibleActionsInput): FeasibleActions {
  // `now` is read through `windowsForDate(input, ...)` rather than destructured here.
  const { date, timezone, courses, deadlines, tasks, pendingChanges, signals } = input
  const horizonDays = normalizeHorizon(input.horizonDays)
  const horizonEndDate = addDays(date, horizonDays)

  const windows = windowsForDate(input, date)
  const courseById = new Map(courses.map((c) => [c._id as string, c]))

  // --- signals -----------------------------------------------------------
  const recentSignals = [...signals].sort((a, b) => b.observedAt - a.observedAt)
  const signalsDigest = digest(recentSignals)

  // --- pending -----------------------------------------------------------
  const pendingForEntity = new Map<string, PendingAnnotation[]>()
  const pending: PendingAnnotation[] = []
  for (const change of pendingChanges) {
    if (change.status !== "pending") continue
    const annotation = summarizePending(change, timezone)
    // Rule 4: only what could affect the plan in this horizon is surfaced.
    if (annotation.affectsDate && annotation.affectsDate > horizonEndDate) continue
    pending.push(annotation)
    const entityId = change.entity.id
    if (entityId) {
      const list = pendingForEntity.get(entityId) ?? []
      list.push(annotation)
      pendingForEntity.set(entityId, list)
    }
  }

  // --- candidates --------------------------------------------------------
  const openTasks = tasks.filter((t) => OPEN_TASK.has(t.status))
  const taskByDeadline = new Map<string, Doc<"tasks">>()
  for (const task of openTasks) {
    if (task.deadlineId && !taskByDeadline.has(task.deadlineId)) {
      taskByDeadline.set(task.deadlineId, task)
    }
  }

  const options: Option[] = []

  for (const deadline of deadlines) {
    if (deadline.status === "removed") continue
    if (CLOSED_SUBMISSION.has(deadline.submissionStatus)) continue

    let dueDate: string | undefined
    if (deadline.dueAt !== undefined) {
      dueDate = localDate(deadline.dueAt, timezone)
      if (dueDate < date) continue // already past
      if (dueDate > horizonEndDate) continue // beyond the horizon
    }

    const task = taskByDeadline.get(deadline._id)
    const course = deadline.courseId ? courseById.get(deadline.courseId) : undefined
    const related = relatedSignals(recentSignals, {
      courseId: deadline.courseId,
      deadlineId: deadline._id,
      taskId: task?._id,
    })
    const effort = estimateEffort(
      deadline.kind,
      task,
      related.filter((s) => s.kind === "pacing")
    )

    options.push(
      buildOption({
        input,
        windows,
        horizonDays,
        task,
        deadline,
        course,
        dueDate,
        effort,
        pendingAnnotations: [
          ...(pendingForEntity.get(deadline._id) ?? []),
          ...(task ? (pendingForEntity.get(task._id) ?? []) : []),
        ],
        related,
      })
    )
  }

  // Free-standing tasks — no deadline behind them, so no due-time truncation.
  for (const task of openTasks) {
    if (task.deadlineId) continue
    const course = task.courseId ? courseById.get(task.courseId) : undefined
    const related = relatedSignals(recentSignals, {
      courseId: task.courseId,
      taskId: task._id,
    })
    const effort = estimateEffort(
      "other",
      task,
      related.filter((s) => s.kind === "pacing")
    )
    options.push(
      buildOption({
        input,
        windows,
        horizonDays,
        task,
        deadline: undefined,
        course,
        dueDate: undefined,
        effort,
        pendingAnnotations: pendingForEntity.get(task._id) ?? [],
        related,
      })
    )
  }

  return { date, windows, options, pending, signalsDigest }
}

function normalizeHorizon(horizonDays: number | undefined): number {
  if (horizonDays === undefined) return DEFAULT_HORIZON_DAYS
  if (!Number.isFinite(horizonDays) || horizonDays < 1) return DEFAULT_HORIZON_DAYS
  return Math.min(Math.floor(horizonDays), 120)
}

function digest(sorted: Doc<"studentSignals">[]): SignalsDigest {
  const out: SignalsDigest = {
    availability: [],
    pacing: [],
    preference: [],
    difficulty: [],
    life_event: [],
    other: [],
  }
  for (const signal of sorted.slice(0, SIGNAL_DIGEST_LIMIT)) {
    out[signal.kind].push(signal.text)
  }
  return out
}

function relatedSignals(
  sorted: Doc<"studentSignals">[],
  refs: { courseId?: string; deadlineId?: string; taskId?: string }
): Doc<"studentSignals">[] {
  return sorted.filter((s) => {
    if (refs.deadlineId && s.refs.deadlineId === refs.deadlineId) return true
    if (refs.taskId && s.refs.taskId === refs.taskId) return true
    if (refs.courseId && s.refs.courseId === refs.courseId) return true
    return false
  })
}

// ---------------------------------------------------------------------------
// Option construction
// ---------------------------------------------------------------------------

type BuildArgs = {
  input: FeasibleActionsInput
  windows: Window[]
  horizonDays: number
  task: Doc<"tasks"> | undefined
  deadline: Doc<"deadlines"> | undefined
  course: Doc<"courses"> | undefined
  dueDate: string | undefined
  effort: EffortEstimate
  pendingAnnotations: PendingAnnotation[]
  related: Doc<"studentSignals">[]
}

function buildOption(args: BuildArgs): Option {
  const { input, windows, task, deadline, course, dueDate, effort } = args
  const { date, timezone } = input

  // Hard guarantee #2: on the due day, nothing may run past the due minute.
  const cutoffMin =
    deadline?.dueAt !== undefined && dueDate === date
      ? localMinutes(deadline.dueAt, timezone)
      : 1440

  const fits: Fit[] = []
  windows.forEach((window, windowIndex) => {
    const startMin = window.startMin
    const endMin = Math.min(window.endMin, cutoffMin)
    const usable = endMin - startMin
    if (usable < Math.min(effort.estEffortMin, MIN_BLOCK_MIN)) return
    fits.push({
      windowIndex,
      startMin,
      endMin: Math.min(endMin, startMin + effort.estEffortMin),
    })
  })

  const remaining = windowsBeforeDue(args)
  const kind = deadline?.kind ?? "other"
  const category = deadline?.category
  const categoryWeight = category
    ? course?.gradingScheme?.categories.find((c) => c.name === category)?.weight
    : undefined
  const dueInDays = dueDate ? daysBetween(date, dueDate) : undefined

  const facts = buildFacts({
    ...args,
    dueInDays,
    categoryWeight,
    fits,
    remaining,
  })

  const pending = args.pendingAnnotations.map((p) => `pending: ${p.summary}`)
  const signalTexts = args.related.map((s) => s.text)

  return {
    taskId: task?._id,
    deadlineId: deadline?._id,
    courseId: (deadline?.courseId ?? task?.courseId) as string | undefined,
    courseName: course?.name,
    title: task?.title ?? deadline?.title ?? "Untitled",
    kind,
    dueAt: deadline?.dueAt,
    dueInDays,
    pointsPossible: deadline?.pointsPossible,
    category,
    categoryWeight,
    estEffortMin: effort.estEffortMin,
    estEffortConfidence: effort.estEffortConfidence,
    effortSource: effort.effortSource,
    fits,
    remainingWindowsBeforeDue: remaining.count,
    facts,
    pending: pending.length > 0 ? pending : undefined,
    signals: signalTexts.length > 0 ? signalTexts : undefined,
  }
}

type RemainingWindows = {
  count: number
  /** The latest usable window between the planned date and the due date. */
  last?: { date: string; startMin: number; endMin: number }
}

/**
 * Counts every free window from the planned date through the due date, so the
 * agent can say "that's the last two-hour window before it's due" truthfully.
 * Undated work is counted over the horizon instead.
 */
function windowsBeforeDue(args: BuildArgs): RemainingWindows {
  const { input, windows, horizonDays, deadline, dueDate } = args
  const { date, timezone } = input
  const lastDate = dueDate ?? addDays(date, horizonDays)
  const span = Math.max(0, Math.min(daysBetween(date, lastDate), horizonDays))

  let count = 0
  let last: RemainingWindows["last"] | undefined

  for (let offset = 0; offset <= span; offset++) {
    const day = addDays(date, offset)
    const dayWindows = offset === 0 ? windows : windowsForDate(input, day)
    const cutoffMin =
      deadline?.dueAt !== undefined && day === dueDate
        ? localMinutes(deadline.dueAt, timezone)
        : 1440
    for (const window of dayWindows) {
      const endMin = Math.min(window.endMin, cutoffMin)
      if (endMin - window.startMin < MIN_BLOCK_MIN) continue
      count++
      last = { date: day, startMin: window.startMin, endMin }
    }
  }
  return { count, last }
}

function buildFacts(
  args: BuildArgs & {
    dueInDays: number | undefined
    categoryWeight: number | undefined
    fits: Fit[]
    remaining: RemainingWindows
  }
): string[] {
  const { deadline, course, effort, dueInDays, categoryWeight, fits, remaining } = args
  const { timezone } = args.input
  const facts: string[] = []

  if (course?.name) facts.push(course.code ? `${course.name} (${course.code})` : course.name)

  if (deadline?.dueAt !== undefined && dueInDays !== undefined) {
    const when =
      dueInDays === 0 ? "today" : dueInDays === 1 ? "tomorrow" : `in ${dueInDays} days`
    facts.push(`due ${formatLocalDateTime(deadline.dueAt, timezone)} (${when})`)
  } else if (deadline) {
    facts.push("no due date on record")
  }

  if (deadline?.pointsPossible !== undefined) {
    const category = deadline.category
      ? ` in ${deadline.category}${
          categoryWeight !== undefined ? ` (${formatWeight(categoryWeight)} of grade)` : ""
        }`
      : ""
    facts.push(`worth ${deadline.pointsPossible} pts${category}`)
  } else if (deadline?.category) {
    facts.push(
      `in ${deadline.category}${
        categoryWeight !== undefined ? ` (${formatWeight(categoryWeight)} of grade)` : ""
      }`
    )
  }

  const effortLabel =
    effort.effortSource === "signal"
      ? `effort ~${formatDuration(effort.estEffortMin)} (${effort.estEffortConfidence}-confidence, from what you told me${
          effort.signalText ? `: "${effort.signalText}"` : ""
        })`
      : `effort ~${formatDuration(effort.estEffortMin)} (${effort.estEffortConfidence}-confidence prior)`
  facts.push(effortLabel)

  if (fits.length === 0) {
    facts.push("does not fit in any free window on this day")
  } else {
    facts.push(
      `fits ${fits.length} free window${fits.length === 1 ? "" : "s"} today: ${fits
        .map((f) => `${formatClock(f.startMin)}–${formatClock(f.endMin)}`)
        .join(", ")}`
    )
  }

  if (deadline?.dueAt !== undefined) {
    facts.push(
      `${remaining.count} free window${remaining.count === 1 ? "" : "s"} before it is due`
    )
    if (remaining.last) {
      facts.push(
        `last free window before due is ${formatDateLabel(remaining.last.date)} ${formatClock(
          remaining.last.startMin
        )}–${formatClock(remaining.last.endMin)}`
      )
    }
  }

  return facts
}

/** Weights are stored as the syllabus stated them — 0.3 or 30 both mean 30%. */
function formatWeight(weight: number): string {
  const percent = weight <= 1 ? weight * 100 : weight
  return `${Math.round(percent * 10) / 10}%`
}
