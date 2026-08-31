import type { Infer } from "convex/values"

import type {
  GradingScheme,
  NormalizedDeadline,
  Provenance,
} from "../normalized"
import { addDays, localDateToMs } from "../time"
import type { timeBlockV } from "../validators"
import type {
  ExtractedBlock,
  ExtractedDeadline,
  ScheduleExtraction,
  SyllabusExtraction,
} from "./schemas"

/**
 * Extraction output → the adapter-neutral shapes the rest of Core already
 * speaks. Pure: no database, no clock, no network — everything it needs
 * (timezone, semester window) is passed in, which is what makes the extraction
 * eval fixtures testable without a deployment.
 *
 * The division of labour with the model is deliberate (vision §9): the model
 * reports what the document SAYS (`"2016-10-14"`, or nothing at all); this
 * module decides what that MEANS (an instant, in the student's timezone, at
 * 23:59 when no time was stated). A date the model could not state
 * unambiguously never becomes an instant here — it becomes a dated-less
 * deadline whose `sourceText` still carries "Week 3: ch. 5-6".
 */

export type TimeBlock = Infer<typeof timeBlockV>

export type SemesterWindow = { start?: string; end?: string }

/** The default a deadline gets when the document states a date but no time. */
export const DEFAULT_DUE_MINUTES = 23 * 60 + 59

/**
 * How far outside the term a stated date may fall before we refuse it.
 *
 * A model that hallucinates a year turns "Oct 14" into an instant a year off,
 * which reads to the planner as a perfectly ordinary deadline. The term window
 * is the only cheap check that catches it. The slack covers the real cases —
 * an orientation reading before classes start, a final exam after the last
 * lecture — without covering a whole wrong year.
 */
export const SEMESTER_SLACK_DAYS = 21

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * "Midterm: Tuesday, April 29" — a month and a day, no year. That is what a
 * real syllabus says, so the model reports it as-is (`dueMonthDay`) and the
 * year is decided HERE, from the student's own term dates.
 *
 * This is resolution, not inference: exactly one year can put "04-29" inside a
 * term that runs 2025-01-21 → 2025-05-14, and if two could (a term spanning a
 * new year, e.g. a December–January intersession) the earliest candidate inside
 * the window wins because a term is read forward. When NO candidate lands
 * inside the window, we refuse rather than pick — an undated deadline the
 * student can see is recoverable; a deadline silently filed a year off is not.
 */
export function resolveYear(
  monthDay: string,
  semester?: SemesterWindow
): { date?: string; drop?: string } {
  if (!MONTH_DAY_RE.test(monthDay)) {
    return { drop: `month/day "${monthDay}" is not MM-DD` }
  }
  const anchorStart = semester?.start
  const anchorEnd = semester?.end
  if (!anchorStart && !anchorEnd) {
    return {
      drop: `"${monthDay}" has no year and the student has no term dates to resolve it against`,
    }
  }
  const years = new Set<number>()
  for (const anchor of [anchorStart, anchorEnd]) {
    if (!anchor) continue
    const year = Number(anchor.slice(0, 4))
    if (Number.isFinite(year)) {
      years.add(year - 1)
      years.add(year)
      years.add(year + 1)
    }
  }
  const candidates = [...years]
    .sort((a, b) => a - b)
    .map((year) => `${year}-${monthDay}`)
    .filter((date) => withinSemester(date, semester))
  if (candidates.length === 0) {
    return {
      drop: `"${monthDay}" does not fall inside the term (${anchorStart ?? "?"} – ${anchorEnd ?? "?"}) in any year`,
    }
  }
  return { date: candidates[0] }
}

/** Why an extracted item did not become a proposal. Surfaced, never silent. */
export type DroppedItem = { title: string; reason: string }

export type NormalizedExtraction = {
  course: { name: string; code?: string; gradingScheme?: GradingScheme }
  deadlines: NormalizedDeadline[]
  dropped: DroppedItem[]
}

export type NormalizeSyllabusInput = {
  extraction: SyllabusExtraction
  /** IANA zone. Dates in a syllabus are wall-clock dates where the student is. */
  timezone: string
  source: "syllabus" | "site"
  semester?: SemesterWindow
}

export const clampConfidence = (value: number): number | undefined =>
  Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined

/** `"Problem Set 3"` → `problem set 3`; matches `lib/merge.ts`'s convention. */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

/**
 * Percentages, always.
 *
 * `courses.gradingScheme.weight` is a bare number, and Canvas assignment-group
 * weights are percentages (`30` means 30%). A syllabus writes both forms
 * ("30%", "0.30"), and the prompt deliberately asks the model NOT to convert —
 * converting is inference. So the decision is made here, on the whole set:
 * weights that all sit in 0..1 and sum to about one are fractions and are
 * scaled; anything else is already a percentage. Judged on the SET, because a
 * lone `1` is 1%, while `[0.4, 0.6]` is plainly a pair of fractions.
 */
export function normalizeWeights(
  categories: { name: string; weight?: number; dropLowest?: number }[]
): { name: string; weight?: number; dropLowest?: number }[] {
  const weights = categories
    .map((category) => category.weight)
    .filter((weight): weight is number => typeof weight === "number" && Number.isFinite(weight))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const looksFractional =
    weights.length > 1 && weights.every((weight) => weight > 0 && weight <= 1) && total <= 1.5

  return categories.map((category) => {
    const weight =
      typeof category.weight === "number" && Number.isFinite(category.weight)
        ? looksFractional
          ? Math.round(category.weight * 1000) / 10
          : Math.round(category.weight * 10) / 10
        : undefined
    return {
      name: category.name,
      ...(weight !== undefined ? { weight } : {}),
      ...(typeof category.dropLowest === "number" && category.dropLowest > 0
        ? { dropLowest: Math.floor(category.dropLowest) }
        : {}),
    }
  })
}

/**
 * The instant a stated date+time means in `timezone`, or a reason it was
 * refused. `undefined` date is not a refusal — it is the honest "the document
 * did not say", and the deadline is kept without one.
 */
function resolveDueAt(
  item: ExtractedDeadline,
  timezone: string,
  semester?: SemesterWindow
): { date?: string; dueAt?: number; drop?: string } {
  let date: string | undefined
  if (item.dueDate !== undefined) {
    if (!DATE_RE.test(item.dueDate)) {
      return { drop: `date "${item.dueDate}" is not a YYYY-MM-DD calendar date` }
    }
    if (!withinSemester(item.dueDate, semester)) {
      return { drop: outOfWindow(item.dueDate, semester) }
    }
    date = item.dueDate
  } else if (item.dueMonthDay !== undefined) {
    const resolved = resolveYear(item.dueMonthDay, semester)
    if (resolved.drop) return { drop: resolved.drop }
    date = resolved.date
  }
  // Neither field: the document stated no calendar date. Not a refusal — the
  // deadline is kept, dateless, with its verbatim quote intact.
  if (date === undefined) return {}

  // A malformed time is not a reason to lose the date; the day still stands and
  // the default (end of day) applies.
  const time = item.dueTime !== undefined ? TIME_RE.exec(item.dueTime) : null
  const minutes = time ? Number(time[1]) * 60 + Number(time[2]) : DEFAULT_DUE_MINUTES
  return { date, dueAt: localDateToMs(date, minutes, timezone) }
}

const outOfWindow = (date: string, semester?: SemesterWindow) =>
  `date ${date} falls outside the term (${semester?.start ?? "?"} – ${semester?.end ?? "?"}) ` +
  `by more than ${SEMESTER_SLACK_DAYS} days`

function withinSemester(date: string, semester?: SemesterWindow): boolean {
  if (!semester) return true
  if (semester.start && date < addDays(semester.start, -SEMESTER_SLACK_DAYS)) return false
  if (semester.end && date > addDays(semester.end, SEMESTER_SLACK_DAYS)) return false
  return true
}

export function normalizeSyllabusExtraction(
  input: NormalizeSyllabusInput
): NormalizedExtraction {
  const { extraction, timezone, source, semester } = input
  const dropped: DroppedItem[] = []
  const deadlines: NormalizedDeadline[] = []
  const seen = new Set<string>()

  for (const item of extraction.deadlines) {
    const title = item.title.trim()
    if (title.length === 0) {
      dropped.push({ title: item.title, reason: "empty title" })
      continue
    }
    // The verbatim quote is the whole accountability story (vision §9). An item
    // with nothing to quote is an invention and never reaches the change feed.
    if (item.sourceText.trim().length === 0) {
      dropped.push({ title, reason: "no verbatim sourceText — unquotable, so unverifiable" })
      continue
    }

    const { date, dueAt, drop } = resolveDueAt(item, timezone, semester)
    if (drop) {
      dropped.push({ title, reason: drop })
      continue
    }

    // Stable across re-extractions of the same document, and unique within one:
    // the same title on two dates is two items, and a genuine repeat gets a
    // suffix rather than silently colliding.
    const base = `${source}:${slug(title)}:${date ?? "undated"}`
    let key = base
    for (let n = 2; seen.has(key); n++) key = `${base}#${n}`
    seen.add(key)

    const provenance: Provenance = {
      source,
      sourceRef: (item.pageRef?.trim() || item.sourceText.trim()).slice(0, 300),
      ...(clampConfidence(item.confidence) !== undefined
        ? { confidence: clampConfidence(item.confidence) }
        : {}),
    }

    deadlines.push({
      key,
      title,
      kind: item.kind,
      ...(dueAt !== undefined ? { dueAt } : {}),
      ...(typeof item.pointsPossible === "number" && Number.isFinite(item.pointsPossible)
        ? { pointsPossible: item.pointsPossible }
        : {}),
      ...(item.category?.trim() ? { category: item.category.trim() } : {}),
      // Nothing about a syllabus says whether the student handed anything in.
      submissionStatus: "unknown",
      description: item.sourceText.trim().slice(0, 1000),
      externalIds: {},
      provenance,
    })
  }

  const categories = extraction.gradingScheme
    ? normalizeWeights(extraction.gradingScheme.categories)
    : undefined
  const gradingScheme: GradingScheme | undefined = categories
    ? {
        categories,
        ...(extraction.gradingScheme?.notes?.trim()
          ? { notes: extraction.gradingScheme.notes.trim() }
          : {}),
      }
    : undefined

  return {
    course: {
      name: extraction.course.name.trim(),
      ...(extraction.course.code?.trim() ? { code: extraction.course.code.trim() } : {}),
      ...(gradingScheme ? { gradingScheme } : {}),
    },
    deadlines,
    dropped,
  }
}

// ---------------------------------------------------------------------------
// schedule
// ---------------------------------------------------------------------------

export type NormalizedSchedule = {
  blocks: TimeBlock[]
  dropped: DroppedItem[]
  /** The lowest confidence any surviving block carried; the change reports it. */
  minConfidence?: number
}

const toMinutes = (hhmm: string): number | undefined => {
  const match = TIME_RE.exec(hhmm.trim())
  if (!match) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Weekly grid → `students.classBlocks` (minutes from local midnight, 0 = Sunday).
 *
 * Every rejection here is a block the planner would otherwise treat as a HARD
 * constraint: a zero-length block, a block that ends before it starts, a day
 * index outside the week. A malformed hard constraint either blocks nothing (so
 * the planner schedules over a class) or blocks everything, and both are worse
 * than the student re-uploading — so they are dropped and reported, never
 * repaired by guesswork.
 */
export function normalizeScheduleExtraction(
  extraction: ScheduleExtraction
): NormalizedSchedule {
  const blocks: TimeBlock[] = []
  const dropped: DroppedItem[] = []
  let minConfidence: number | undefined

  const push = (block: ExtractedBlock) => {
    const label = block.label.trim()
    if (block.sourceText.trim().length === 0) {
      dropped.push({ title: label, reason: "no verbatim sourceText" })
      return
    }
    if (!Number.isInteger(block.dayOfWeek) || block.dayOfWeek < 0 || block.dayOfWeek > 6) {
      dropped.push({ title: label, reason: `dayOfWeek ${block.dayOfWeek} is not 0-6` })
      return
    }
    const startMin = toMinutes(block.startTime)
    const endMin = toMinutes(block.endTime)
    if (startMin === undefined || endMin === undefined) {
      dropped.push({
        title: label,
        reason: `times "${block.startTime}"–"${block.endTime}" are not 24-hour HH:MM`,
      })
      return
    }
    if (endMin <= startMin) {
      dropped.push({ title: label, reason: "block ends at or before it starts" })
      return
    }
    const confidence = clampConfidence(block.confidence)
    if (confidence !== undefined) {
      minConfidence = minConfidence === undefined ? confidence : Math.min(minConfidence, confidence)
    }
    blocks.push({
      dayOfWeek: block.dayOfWeek,
      startMin,
      endMin,
      ...(label ? { label } : {}),
    })
  }

  for (const block of extraction.blocks) push(block)

  blocks.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMin - b.startMin)
  return {
    blocks,
    dropped,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

/**
 * The one-line summary the student sees on the pending change ("5 classes,
 * Mon–Fri — confirm the weekly grid"). Facts only: counts and the day span.
 */
export function describeSchedule(blocks: TimeBlock[]): string {
  if (blocks.length === 0) return "No class blocks could be read from this upload."
  const days = [...new Set(blocks.map((block) => block.dayOfWeek))].sort((a, b) => a - b)
  const span =
    days.length === 1
      ? DAY_NAMES[days[0]]
      : `${DAY_NAMES[days[0]]}–${DAY_NAMES[days[days.length - 1]]}`
  const labels = new Set(
    blocks.map((block) => (block.label ?? "").trim()).filter((label) => label.length > 0)
  )
  const what =
    labels.size > 0
      ? `${labels.size} ${labels.size === 1 ? "class" : "classes"}`
      : `${blocks.length} ${blocks.length === 1 ? "block" : "blocks"}`
  return `${what}, ${blocks.length} weekly ${blocks.length === 1 ? "block" : "blocks"} across ${span} — confirm the weekly grid.`
}
