import type {
  DeadlineKind,
  NormalizedClassEvent,
  NormalizedDeadline,
  Provenance,
} from "../normalized"

/**
 * A minimal RFC 5545 reader — enough for Canvas's user feed and a plain
 * exported `.ics`, and nothing more (plans/core.md, "Adapters" #2: iCal
 * contributes title + date only).
 *
 * Hand-rolled on purpose: this workstream adds no dependencies, and the subset
 * we need (unfolding, VEVENT, DTSTART/DTEND with VALUE=DATE / UTC / TZID) is
 * small and fully covered by `convex/lib/ical/parse.test.ts`.
 *
 * Not implemented, deliberately: RRULE expansion, VTIMEZONE definitions (we use
 * the IANA zone named by TZID via `Intl`), VALARM, attachments.
 */

// ---------------------------------------------------------------------------
// lexing
// ---------------------------------------------------------------------------

export type IcalProperty = {
  name: string
  params: Record<string, string>
  value: string
}

export type IcalEvent = {
  uid?: string
  summary?: string
  description?: string
  location?: string
  url?: string
  dtstart?: IcalDateTime
  dtend?: IcalDateTime
  properties: IcalProperty[]
}

export type IcalDateTime = {
  /** ms since epoch. */
  ms: number
  /** `DTSTART;VALUE=DATE:20261102` — a whole day, not an instant. */
  isDate: boolean
  tzid?: string
}

/**
 * RFC 5545 §3.1: a long line is folded by inserting CRLF followed by a single
 * space or horizontal tab. Unfolding strips exactly that one whitespace octet.
 * Accepts LF-only files too — git checkouts and hand-authored fixtures.
 */
export function unfoldLines(text: string): string[] {
  const raw = text.split(/\r\n|\n|\r/)
  const lines: string[] = []
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else {
      lines.push(line)
    }
  }
  return lines
}

/** RFC 5545 §3.3.11 TEXT escaping. */
function unescapeText(value: string): string {
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch !== "\\") {
      out += ch
      continue
    }
    const next = value[++i]
    if (next === "n" || next === "N") out += "\n"
    else if (next === undefined) out += "\\"
    else out += next // \, \; \\ and anything else: the literal character
  }
  return out
}

/**
 * `NAME;PARAM=VAL;PARAM2="v;with;semis":the value`.
 * The value starts at the first colon that is not inside a quoted param.
 */
export function parsePropertyLine(line: string): IcalProperty | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ":" && !quoted) {
      colon = i
      break
    }
  }
  if (colon === -1) return null

  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)

  const segments: string[] = []
  let current = ""
  quoted = false
  for (const ch of head) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === ";" && !quoted) {
      segments.push(current)
      current = ""
    } else current += ch
  }
  segments.push(current)

  const name = (segments.shift() ?? "").trim().toUpperCase()
  if (name.length === 0) return null

  const params: Record<string, string> = {}
  for (const segment of segments) {
    const eq = segment.indexOf("=")
    if (eq === -1) continue
    params[segment.slice(0, eq).trim().toUpperCase()] = segment.slice(eq + 1).trim()
  }

  return { name, params, value }
}

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

/**
 * Offset of `tz` from UTC at instant `ms`, in ms. Uses `Intl` rather than a
 * bundled tz database; the Convex runtime and the test edge runtime both ship
 * full ICU. Returns 0 for an unknown zone (the caller then treats the value as
 * floating/UTC, which is what RFC 5545 says to do when the zone is unresolvable).
 */
function zoneOffsetMs(ms: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0")
    const asUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second")
    )
    return asUtc - ms
  } catch {
    return 0
  }
}

/** Wall-clock fields in `tz` → the UTC instant. Two passes settle DST edges. */
function zonedTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string
): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s)
  let ms = naive - zoneOffsetMs(naive, tz)
  const refined = naive - zoneOffsetMs(ms, tz)
  if (refined !== ms) ms = refined
  return ms
}

const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/

/**
 * Parses the three forms Canvas and typical exporters emit:
 *   `20260915T035900Z`                     → UTC instant
 *   `VALUE=DATE:20261102`                  → whole day (UTC midnight, isDate)
 *   `TZID=America/New_York:20260908T101500` → wall clock in that zone
 * A form with neither `Z` nor `TZID` is "floating"; RFC 5545 says it means
 * local time everywhere, and with no student timezone in scope here we read it
 * as UTC and let the caller decide (documented, not silently guessed).
 */
export function parseIcalDate(
  value: string,
  params: Record<string, string> = {}
): IcalDateTime | undefined {
  const raw = value.trim()
  const match = DATE_TIME_RE.exec(raw)
  if (!match) return undefined

  const [, ys, mos, ds, hs, mis, ss, z] = match
  const y = Number(ys)
  const mo = Number(mos)
  const d = Number(ds)

  const isDate = params.VALUE === "DATE" || hs === undefined
  if (isDate) return { ms: Date.UTC(y, mo - 1, d), isDate: true }

  const h = Number(hs)
  const mi = Number(mis)
  const s = Number(ss)
  const tzid = params.TZID

  if (z === "Z" || !tzid) {
    return { ms: Date.UTC(y, mo - 1, d, h, mi, s), isDate: false, ...(tzid ? { tzid } : {}) }
  }
  return { ms: zonedTimeToUtc(y, mo, d, h, mi, s, tzid), isDate: false, tzid }
}

// ---------------------------------------------------------------------------
// VEVENT
// ---------------------------------------------------------------------------

export function parseIcs(text: string): IcalEvent[] {
  const events: IcalEvent[] = []
  let current: IcalEvent | null = null

  for (const line of unfoldLines(text)) {
    if (line.length === 0) continue
    const property = parsePropertyLine(line)
    if (!property) continue

    if (property.name === "BEGIN" && property.value.toUpperCase() === "VEVENT") {
      current = { properties: [] }
      continue
    }
    if (property.name === "END" && property.value.toUpperCase() === "VEVENT") {
      if (current) events.push(current)
      current = null
      continue
    }
    if (!current) continue

    current.properties.push(property)
    switch (property.name) {
      case "UID":
        current.uid = property.value.trim()
        break
      case "SUMMARY":
        current.summary = unescapeText(property.value).trim()
        break
      case "DESCRIPTION":
        current.description = unescapeText(property.value).trim()
        break
      case "LOCATION":
        current.location = unescapeText(property.value).trim()
        break
      case "URL":
        current.url = property.value.trim()
        break
      case "DTSTART":
        current.dtstart = parseIcalDate(property.value, property.params)
        break
      case "DTEND":
        current.dtend = parseIcalDate(property.value, property.params)
        break
    }
  }

  return events
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

/**
 * Canvas encodes the object id in the UID, which is what makes dedupe against
 * the Canvas adapter an exact join on id rather than fuzzy matching
 * (plans/core.md, "Adapters" #2).
 */
export const CANVAS_ASSIGNMENT_UID_RE = /^event-assignment-(\d+)$/
export const CANVAS_CALENDAR_EVENT_UID_RE = /^event-calendar-event-(\d+)$/

/** Canvas feeds append the course code: `Assignment 1: Sorting [CS201]`. */
export function splitSummary(summary: string): { title: string; courseCode?: string } {
  const match = /^(.*?)\s*\[([^\][]+)\]\s*$/.exec(summary)
  if (!match) return { title: summary.trim() }
  return { title: match[1].trim(), courseCode: match[2].trim() }
}

const EXAM_RE = /\b(exam|midterm|final)\b/i
const QUIZ_RE = /\bquiz\b/i

/** iCal gives us a title and a date; only an explicit word changes the kind. */
export function kindFromTitle(title: string): DeadlineKind {
  if (EXAM_RE.test(title)) return "exam"
  if (QUIZ_RE.test(title)) return "quiz"
  return "other"
}

export type NormalizedIcal = {
  deadlines: NormalizedDeadline[]
  /** Class meetings and other calendar events — NOT deadlines. */
  classEvents: NormalizedClassEvent[]
}

export function normalizeIcal(text: string, sourceUrl?: string): NormalizedIcal {
  const deadlines: NormalizedDeadline[] = []
  const classEvents: NormalizedClassEvent[] = []
  const ref = sourceUrl ?? "ical"

  for (const event of parseIcs(text)) {
    const uid = event.uid
    if (!uid || !event.dtstart) continue

    const { title, courseCode } = splitSummary(event.summary ?? uid)
    const provenance: Provenance = {
      source: "ical",
      sourceRef: `${ref}#${uid}`,
      confidence: 1,
    }

    const calendarEvent = CANVAS_CALENDAR_EVENT_UID_RE.exec(uid)
    if (calendarEvent) {
      classEvents.push({
        key: `ical:event:${uid}`,
        title,
        ...(courseCode ? { courseCode } : {}),
        startAt: event.dtstart.ms,
        ...(event.dtend ? { endAt: event.dtend.ms } : {}),
        allDay: event.dtstart.isDate,
        ...(event.location ? { location: event.location } : {}),
        externalIds: { icalUid: uid },
        provenance,
      })
      continue
    }

    const assignment = CANVAS_ASSIGNMENT_UID_RE.exec(uid)
    deadlines.push({
      key: `ical:${uid}`,
      ...(courseCode ? { courseCode } : {}),
      title,
      kind: kindFromTitle(title),
      dueAt: event.dtstart.ms,
      submissionStatus: "unknown",
      ...(event.description ? { description: event.description } : {}),
      ...(event.url ? { url: event.url } : {}),
      externalIds: {
        icalUid: uid,
        ...(assignment ? { canvasAssignmentId: assignment[1] } : {}),
      },
      provenance,
    })
  }

  return { deadlines, classEvents }
}
