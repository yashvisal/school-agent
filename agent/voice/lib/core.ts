/**
 * The Core client — Voice's entire reach into Convex (convex/VOICE_TOOLS.md).
 *
 * Every function here is a thin `POST` to one of Core's `/voice/*` HTTP routes
 * on the Convex deployment's `.convex.site` host, authenticated with
 * `CORE_AGENT_SECRET`. The shapes are Core's, verbatim: this file adds no
 * interpretation, no caching of facts, and no fallbacks — if Core is down, the
 * tools fail loudly rather than inventing a plan (vision §10).
 *
 * Replaces the Spike A fixture stub; the fixture lives on only in
 * `fixtures/student-demo.json` for reference.
 */

export class CoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly route: string,
  ) {
    super(`Core ${route} -> ${status}: ${message}`)
    this.name = "CoreError"
  }
}

function coreBaseUrl(): string {
  const url = process.env.CORE_URL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  if (!url) {
    throw new Error(
      "CORE_URL (or NEXT_PUBLIC_CONVEX_SITE_URL) is not set — Voice cannot reach Core.",
    )
  }
  return url.replace(/\/+$/, "")
}

function coreSecret(): string {
  const secret = process.env.CORE_AGENT_SECRET
  if (!secret) {
    throw new Error("CORE_AGENT_SECRET is not set — every /voice/* route requires it.")
  }
  return secret
}

const CORE_TIMEOUT_MS = 15_000

async function corePost<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(`${coreBaseUrl()}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${coreSecret()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // A non-JSON body is a transport-level failure; surfaced below.
  }
  const bag =
    parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  if (!response.ok || bag.ok !== true) {
    const message =
      typeof bag.error === "string" ? bag.error : text.slice(0, 300) || "no body"
    throw new CoreError(response.status, message, route)
  }
  return bag as T
}

// ---------------------------------------------------------------------------
// Shapes — mirrors of VOICE_TOOLS.md. Core's validators are the truth; these
// exist so the tools and hooks type-check, not to re-validate.
// ---------------------------------------------------------------------------

export type ResolvedStudent = {
  studentId: string
  timezone: string
  status: "active" | "paused"
}

export type PlanWindow = { startMin: number; endMin: number; durationMin: number }

export type PlanFit = { windowIndex: number; startMin: number; endMin: number }

export type PlanOption = {
  taskId?: string
  deadlineId?: string
  courseId?: string
  courseName?: string
  title: string
  kind: "homework" | "project" | "exam" | "quiz" | "reading" | "other"
  dueAt?: number
  dueInDays?: number
  pointsPossible?: number
  category?: string
  categoryWeight?: number
  estEffortMin: number
  estEffortConfidence: "low" | "medium" | "high"
  effortSource: "prior" | "signal"
  fits: PlanFit[]
  remainingWindowsBeforeDue: number
  facts: string[]
  pending?: string[]
  signals?: string[]
  overdue?: boolean
}

export type PendingAnnotation = {
  changeId: string
  kind: string
  summary: string
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

export type Plan = {
  planRunId?: string
  computedAt: number
  cached: boolean
  timezone: string
  date: string
  windows: PlanWindow[]
  options: PlanOption[]
  pending: PendingAnnotation[]
  signalsDigest: SignalsDigest
}

export type ChangeEvidence = { quotedReply: string; inboundMessageId?: string }

export type ChangeEntity = {
  table: "deadlines" | "courses" | "tasks" | "students"
  id?: string
}

export type VoiceChange = {
  kind: string
  entity: ChangeEntity
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  courseId?: string
  reason?: string
  conflict?: boolean
  confirmedInline?: boolean
  evidence?: ChangeEvidence
}

export type VoiceSignal = {
  kind: "pacing" | "availability" | "preference" | "difficulty" | "life_event" | "other"
  text: string
  refs?: { courseId?: string; deadlineId?: string; taskId?: string }
  observedAt?: number
  sessionId?: string
  confidence?: number
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

export async function resolveStudentByPhone(phone: string): Promise<ResolvedStudent> {
  return await corePost<ResolvedStudent & { ok: true }>("/voice/resolveStudent", { phone })
}

export async function getFeasibleActions(
  studentId: string,
  date: string,
  now?: number,
): Promise<Plan> {
  const result = await corePost<{ ok: true; plan: Plan }>("/voice/getFeasibleActions", {
    studentId,
    date,
    ...(now !== undefined ? { now } : {}),
  })
  return result.plan
}

export async function proposeChange(
  studentId: string,
  change: VoiceChange,
): Promise<{ changeId: string; status: string; tier: string }> {
  return await corePost("/voice/proposeChange", { studentId, change })
}

export async function recordSignal(
  studentId: string,
  signal: VoiceSignal,
): Promise<{ signalId: string }> {
  return await corePost("/voice/recordSignal", { studentId, signal })
}

export async function logUsage(row: {
  studentId?: string
  surface?: "voice" | "workspace" | "ingestion" | "planner"
  model: string
  promptTokens: number
  completionTokens: number
  costUsd?: number
  sessionId?: string
  at?: number
  /** Stable per model step; Core returns the existing row on a replay. */
  idempotencyKey?: string
}): Promise<{ usageId: string }> {
  return await corePost("/voice/logUsage", row)
}

/**
 * Dedupe + inbound log, called by the Photon channel BEFORE dispatching a turn.
 * `duplicate: true` means Photon redelivered something Core already saw — the
 * channel must drop it (return `null` from `onMessage`).
 */
export async function recordInbound(args: {
  phone: string
  messageId: string
  webhookId?: string
  text?: string
}): Promise<{ duplicate: boolean; studentId?: string; warmed: boolean }> {
  return await corePost("/voice/recordInbound", args)
}

// ---------------------------------------------------------------------------
// Local-time helpers (no Core round trip; dates only, never facts)
// ---------------------------------------------------------------------------

/**
 * Today (or `offsetDays` from today) as `YYYY-MM-DD` in `timeZone`. Offsets are
 * applied as CALENDAR days on the local date, not elapsed milliseconds — a
 * fall-back DST day is 25h long, and +86.4M ms across it would return the same
 * local date twice.
 */
export function localDate(timeZone: string, offsetDays = 0): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const today = fmt.format(new Date())
  if (offsetDays === 0) return today
  const d = new Date(`${today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}
