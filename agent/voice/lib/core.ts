/**
 * Spike A stand-in for Core.
 *
 * Everything here is a STUB over `../fixtures/student-demo.json` (synthetic).
 * When Core lands, each function below becomes a Convex query/mutation call and
 * this file shrinks to a client. The *shapes* are the contract; the logic is not.
 *
 * The one guarantee that must survive the swap (vision §10): the option set is
 * feasible. No window returned here overlaps a class block or extends past the
 * deadline it belongs to. The model freestyles inside the set; it never makes one.
 */
import { existsSync } from "node:fs"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import fixture from "../fixtures/student-demo.json" with { type: "json" }

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Where the spike's JSONL sinks live. Under `eve dev` this module runs from a
 * compiled snapshot inside `.eve/`, so `import.meta.url` is NOT the source tree;
 * resolve from the process cwd (repo root under `pnpm dev`, agent root under
 * `eve dev`/`eve eval`) and allow an explicit override.
 */
function spikeDir(): string {
  if (process.env.VOICE_SPIKE_DIR) return process.env.VOICE_SPIKE_DIR
  const cwd = process.cwd()
  for (const candidate of [join(cwd, "agent", "voice"), cwd]) {
    if (existsSync(join(candidate, "instructions.md"))) return join(candidate, ".spike")
  }
  return join(HERE, "..", ".spike")
}
const SPIKE_DIR = spikeDir()

export type Student = { studentId: string; firstName: string; timezone: string }

export type Window = { start: string; end: string; minutes: number }

export type FeasibleOption = {
  id: string
  taskTitle: string
  course: string
  deadline: {
    title: string
    kind: string
    dueAt: string
    dueInDays: number
    pointsPossible: number
    category: string
  }
  windows: Window[]
  effortEstimateMin: number
  effortConfidence: "low"
  facts: string[]
  pending?: string
  signals?: string[]
}

export type PendingChange = { id: string; summary: string; question: string }

export type FeasibleActions = {
  student: { firstName: string; timezone: string }
  date: string
  options: FeasibleOption[]
  pendingChanges: PendingChange[]
}

export const demoStudent: Student = fixture.student

/** Wall-clock parts of `date` as seen in `timeZone`. */
function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdays.indexOf(parts.weekday ?? "Sun"),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

/** Today (or `offsetDays` from today) as an ISO date in the student's timezone. */
export function localDate(timeZone: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return zonedParts(d, timeZone).isoDate
}

function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T12:00:00Z`).getUTCDay()
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/** `dueInDays` offsets resolve to real ISO datetimes at call time. */
export function resolveDueAt(dueInDays: number, dueTime: string, timeZone: string): string {
  return `${localDate(timeZone, dueInDays)}T${dueTime}:00`
}

type Block = { title: string; startMin: number; endMin: number }

function classBlocks(isoDate: string): Block[] {
  const template = fixture.weekdayTemplate as Record<
    string,
    { title: string; start: string; end: string }[]
  >
  const day = template[String(weekdayOf(isoDate))] ?? []
  return day.map((b) => ({
    title: b.title,
    startMin: toMinutes(b.start),
    endMin: toMinutes(b.end),
  }))
}

/**
 * Free windows on `isoDate`: the day bounds minus class blocks, minus anything
 * already past (when the date is today), truncated at `hardStopMin`.
 */
function freeWindows(isoDate: string, timeZone: string, hardStopMin: number): Window[] {
  const bounds = fixture.dayBounds
  let cursor = toMinutes(bounds.start)
  const dayEnd = Math.min(toMinutes(bounds.end), hardStopMin)

  const now = zonedParts(new Date(), timeZone)
  if (now.isoDate === isoDate) cursor = Math.max(cursor, now.minutes)

  const blocks = classBlocks(isoDate).sort((a, b) => a.startMin - b.startMin)
  const out: Window[] = []
  const push = (from: number, to: number) => {
    const minutes = to - from
    if (minutes >= 30) out.push({ start: fmtMinutes(from), end: fmtMinutes(to), minutes })
  }

  for (const block of blocks) {
    if (block.startMin > cursor) push(cursor, Math.min(block.startMin, dayEnd))
    cursor = Math.max(cursor, block.endMin)
    if (cursor >= dayEnd) break
  }
  if (cursor < dayEnd) push(cursor, dayEnd)

  return out.filter((w) => w.minutes >= 30)
}

/** The whole deterministic layer, stubbed. Feasible-by-construction. */
export function getFeasibleActionsFor(student: Student, date?: string): FeasibleActions {
  const tz = student.timezone
  const isoDate = date ?? localDate(tz, 1)

  const coursesById = new Map(fixture.courses.map((c) => [c.courseId, c]))
  const deadlinesById = new Map(fixture.deadlines.map((d) => [d.deadlineId, d]))
  const dayEndMin = toMinutes(fixture.dayBounds.end)

  const options: FeasibleOption[] = []
  for (const task of fixture.tasks) {
    const deadline = deadlinesById.get(task.deadlineId)
    if (!deadline) continue
    const course = coursesById.get(deadline.courseId)
    if (!course) continue

    const dueDate = localDate(tz, deadline.dueInDays)
    if (dueDate < isoDate) continue // already past on the requested day

    // Hard invariant: never return a window that ends after the deadline.
    const hardStop = dueDate === isoDate ? toMinutes(deadline.dueTime) : dayEndMin
    const windows = freeWindows(isoDate, tz, hardStop)
    if (windows.length === 0) continue

    const weight = course.gradingScheme.find((g) => g.category === deadline.category)?.weight
    const facts = [
      `${course.code} ${deadline.title} is worth ${deadline.pointsPossible} points`,
      weight !== undefined
        ? `${deadline.category} is ${Math.round(weight * 100)}% of the ${course.code} grade`
        : `${deadline.category} counts toward the ${course.code} grade`,
      `due ${dueDate} at ${deadline.dueTime} (${deadline.dueInDays} day(s) out)`,
      `${windows.length} free window(s) on ${isoDate}, longest ${Math.max(
        ...windows.map((w) => w.minutes),
      )} min`,
    ]

    const pending = fixture.pendingChanges.find((c) => c.refs.deadlineId === deadline.deadlineId)
    const courseKeyword = course.code.split(" ")[0].toLowerCase()
    const signals = fixture.studentSignals
      .filter((s) => s.text.toLowerCase().includes(courseKeyword))
      .map((s) => s.text)

    options.push({
      id: task.taskId,
      taskTitle: task.title,
      course: course.code,
      deadline: {
        title: deadline.title,
        kind: deadline.kind,
        dueAt: resolveDueAt(deadline.dueInDays, deadline.dueTime, tz),
        dueInDays: deadline.dueInDays,
        pointsPossible: deadline.pointsPossible,
        category: deadline.category,
      },
      windows,
      effortEstimateMin: task.effortEstimateMin,
      effortConfidence: "low",
      facts,
      ...(pending ? { pending: pending.summary } : {}),
      ...(signals.length > 0 ? { signals } : {}),
    })
  }

  options.sort((a, b) => a.deadline.dueInDays - b.deadline.dueInDays)

  return {
    student: { firstName: student.firstName, timezone: tz },
    date: isoDate,
    options,
    pendingChanges: fixture.pendingChanges.map((c) => ({
      id: c.changeId,
      summary: c.summary,
      question: c.question,
    })),
  }
}

/** Append-only JSONL sink standing in for Convex `changes` / `signals` / `usage`. */
export async function appendSpike(file: string, row: unknown): Promise<void> {
  await mkdir(SPIKE_DIR, { recursive: true })
  await appendFile(join(SPIKE_DIR, file), `${JSON.stringify(row)}\n`, "utf8")
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}
