/**
 * Timezone helpers — pure, no libraries.
 *
 * The Core conventions (see `lib/validators.ts`): timestamps are ms since epoch,
 * calendar dates are `"YYYY-MM-DD"` in the *student's* timezone, and times of day
 * are minutes from local midnight. Everything below converts between the three
 * using `Intl` only, which the Convex V8 runtime ships in full.
 *
 * DST is handled explicitly: `localDateToMs` solves for the offset twice, so a
 * wall-clock time on a spring-forward / fall-back day resolves to the instant a
 * student would actually mean.
 */

export type LocalParts = {
  /** "YYYY-MM-DD" in `tz`. */
  date: string
  year: number
  /** 1-12. */
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** Minutes from local midnight. */
  minutes: number
  /** 0 = Sunday. */
  dayOfWeek: number
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone)
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatterCache.set(timeZone, cached)
  }
  return cached
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Wall-clock reading of `ms` in `tz`, decomposed. */
export function localParts(ms: number, tz: string): LocalParts {
  const bag: Record<string, string> = {}
  for (const part of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== "literal") bag[part.type] = part.value
  }
  const year = Number(bag.year)
  const month = Number(bag.month)
  const day = Number(bag.day)
  const hour = Number(bag.hour) % 24
  const minute = Number(bag.minute)
  const second = Number(bag.second)
  const dayOfWeek = WEEKDAYS.indexOf(bag.weekday as (typeof WEEKDAYS)[number])
  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    minutes: hour * 60 + minute,
    dayOfWeek: dayOfWeek < 0 ? dayOfWeekOf(`${year}-${pad2(month)}-${pad2(day)}`) : dayOfWeek,
  }
}

/** "YYYY-MM-DD" for `ms` in `tz`. */
export function localDate(ms: number, tz: string): string {
  return localParts(ms, tz).date
}

/** Minutes from local midnight for `ms` in `tz`. */
export function localMinutes(ms: number, tz: string): number {
  return localParts(ms, tz).minutes
}

function parseDateStr(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!match) throw new Error(`invalid date "${dateStr}" (expected YYYY-MM-DD)`)
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * 0 = Sunday. A calendar date's weekday does not depend on the timezone, so the
 * `tz` argument is accepted for call-site symmetry and deliberately unused.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function dayOfWeekOf(dateStr: string, _tz?: string): number {
  const { year, month, day } = parseDateStr(dateStr)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * `tz`'s UTC offset in ms at the instant `ms` (positive east of Greenwich).
 * Derived by re-reading the wall clock, so it is correct for every zone rule
 * (including half-hour and 45-minute offsets) without a tzdata table.
 */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms
}

/**
 * The instant at which the wall clock in `tz` reads `dateStr` + `minutes`.
 *
 * Two passes: the first guesses the offset from the naive UTC instant, the
 * second re-solves it at the corrected instant. That converges for every real
 * zone, including DST transitions (a nonexistent spring-forward wall time
 * resolves forward past the gap; an ambiguous fall-back time resolves to the
 * first of the two instants).
 */
export function localDateToMs(dateStr: string, minutes: number, tz: string): number {
  const { year, month, day } = parseDateStr(dateStr)
  if (!Number.isFinite(minutes)) throw new Error("minutes must be finite")
  const naive = Date.UTC(year, month - 1, day) + minutes * 60_000
  const first = naive - tzOffsetMs(naive, tz)
  const second = naive - tzOffsetMs(first, tz)

  // Spring-forward gap: the requested wall time never happens, so reading the
  // instant back gives a different clock. Push forward by the shortfall, which
  // lands just past the gap (2:30am on a spring-forward day means 3:30am).
  const readBack = localParts(second, tz)
  const actual = daysBetween(dateStr, readBack.date) * 1440 + readBack.minutes
  return actual === minutes ? second : second + (minutes - actual) * 60_000
}

/** Start-of-day instant for `dateStr` in `tz`. */
export const startOfLocalDay = (dateStr: string, tz: string) =>
  localDateToMs(dateStr, 0, tz)

/** Calendar arithmetic on "YYYY-MM-DD"; timezone-independent by construction. */
export function addDays(dateStr: string, days: number): string {
  const { year, month, day } = parseDateStr(dateStr)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(
    shifted.getUTCDate()
  )}`
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = parseDateStr(from)
  const b = parseDateStr(to)
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)
  return Math.round(ms / 86_400_000)
}

/** "Thu Sep 17" for a "YYYY-MM-DD". */
export function formatDateLabel(dateStr: string): string {
  const { year, month, day } = parseDateStr(dateStr)
  const d = new Date(Date.UTC(year, month - 1, day))
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  return `${WEEKDAYS[d.getUTCDay()]} ${months[month - 1]} ${day}`
}

/**
 * "11:59pm" / "7pm" / "9:30am" from minutes-from-midnight.
 *
 * `1440` is the *end* of the day, not the start of it: the planner uses it as
 * the default cutoff and a window running to midnight ends there. Rendering it
 * as "12am" would read as the start of the day ("9am–12am"), so it is spelled
 * out (CR 3892156227). `0` is still "12am".
 */
export function formatClock(minutes: number): string {
  const rounded = Math.round(minutes)
  if (rounded === 1440) return "midnight"
  const total = ((rounded % 1440) + 1440) % 1440
  const h24 = Math.floor(total / 60)
  const m = total % 60
  const suffix = h24 < 12 ? "am" : "pm"
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return m === 0 ? `${h12}${suffix}` : `${h12}:${pad2(m)}${suffix}`
}

/** "Thu Sep 17 11:59pm" for an instant, read in `tz`. */
export function formatLocalDateTime(ms: number, tz: string): string {
  const p = localParts(ms, tz)
  return `${formatDateLabel(p.date)} ${formatClock(p.minutes)}`
}

/** "~2h", "~90m", "~2h30m". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h${m}m`
}
