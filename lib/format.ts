/** Small display helpers. Nothing here is a fact — it's all derived at render. */

const DAY = 86_400_000

function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

/** Whole days from today to `iso`. Today = 0, tomorrow = 1, yesterday = -1. */
export function daysAway(iso: string): number {
  return Math.round(
    (startOfDay(new Date(iso)).getTime() - startOfDay(new Date()).getTime()) /
      DAY
  )
}

/** "Today", "Tomorrow", "Thu 12", "12 Mar" — the shortest unambiguous form. */
export function dayLabel(iso: string): string {
  const n = daysAway(iso)
  if (n === 0) return "Today"
  if (n === 1) return "Tomorrow"
  if (n === -1) return "Yesterday"
  const d = new Date(iso)
  if (n > 1 && n < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" })
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** "2:30pm" */
export function timeLabel(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(" ", "")
}

/** "Tomorrow, 11:59pm" */
export function dueLabel(iso: string): string {
  return `${dayLabel(iso)}, ${timeLabel(iso)}`
}

/** "in 3 days" / "6 days ago" / "today" */
export function relativeDays(iso: string): string {
  const n = daysAway(iso)
  if (n === 0) return "today"
  if (n === 1) return "tomorrow"
  if (n === -1) return "yesterday"
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

/** "4m ago", "6h ago", "3d ago" — for feed rows and source health. */
export function agoLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** "Mon 14 Sep" */
export function fullDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

export function minutesLabel(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}
