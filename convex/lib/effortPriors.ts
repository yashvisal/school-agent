import type { Infer } from "convex/values"

import type { deadlineKindV, effortConfidenceV } from "./validators"

/**
 * Effort priors — plans/core.md, "Planner v0 / Effort estimates (decided)".
 *
 * v0 uses crude priors by deadline kind, labeled low-confidence everywhere they
 * surface. They exist to *size a window*, not to claim knowledge; the agent is
 * told the confidence so it can hedge in language. `studentSignals` of kind
 * `pacing` override them per course when present.
 *
 * tune on real syllabi
 */
export const EFFORT_PRIORS_MIN: Record<Infer<typeof deadlineKindV>, number> = {
  reading: 45,
  homework: 120,
  quiz: 60,
  project: 240,
  exam: 180,
  other: 60,
}

/** Confidence to report for a bare prior with no signal behind it. */
export const PRIOR_CONFIDENCE: Infer<typeof effortConfidenceV> = "low"

/** Confidence once a pacing signal for that course has adjusted the prior. */
export const SIGNAL_CONFIDENCE: Infer<typeof effortConfidenceV> = "medium"

/** Never scale a prior into absurdity on one offhand remark. */
const MIN_MULTIPLIER = 0.25
const MAX_MULTIPLIER = 6
const MIN_MINUTES = 5
const MAX_MINUTES = 60 * 24

export function priorFor(kind: Infer<typeof deadlineKindV>): number {
  return EFFORT_PRIORS_MIN[kind] ?? EFFORT_PRIORS_MIN.other
}

// ---------------------------------------------------------------------------
// Pacing-signal parsing
// ---------------------------------------------------------------------------

/**
 * What a pacing signal's free text says about effort.
 *
 * - `multiplier`: the student estimated X and it took Y ("said 2h took 4h" → 2).
 * - `minutes`: an absolute duration ("took 4h", "~3 hours", "90 min").
 *
 * Deliberately small and literal. This is a *hint extractor*, not an NLU layer —
 * anything it cannot read confidently returns `null` and the prior stands.
 */
export type PacingHint =
  | { kind: "multiplier"; multiplier: number }
  | { kind: "duration"; minutes: number }

type DurationMatch = { index: number; minutes: number }

const DURATION_RE =
  /(\d+(?:\.\d+)?)\s*(hrs?|hours?|h|mins?|minutes?|m)\b/gi

function toMinutes(value: number, unit: string): number {
  return unit.toLowerCase().startsWith("h") ? value * 60 : value
}

function durationsIn(text: string): DurationMatch[] {
  const out: DurationMatch[] = []
  DURATION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = DURATION_RE.exec(text)) !== null) {
    const minutes = toMinutes(Number(match[1]), match[2])
    if (Number.isFinite(minutes) && minutes > 0) {
      out.push({ index: match.index, minutes })
    }
  }
  return out
}

const ESTIMATE_RE = /\b(said|thought|estimated|planned|expected|guessed)\b/i
const ACTUAL_RE = /\b(took|spent|ended up|actually)\b/i

const firstAfter = (matches: DurationMatch[], index: number) =>
  matches.find((m) => m.index > index)

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * Reads an effort hint out of a pacing signal's text. Patterns, in priority
 * order (core.md's example is the first one — "said 2h, took 4h on CS pset 3"):
 *
 *   estimate-then-actual → multiplier   "said 2h took 4h"        → ×2
 *   actual only          → duration     "took 4h", "spent 90 min"
 *   bare duration        → duration     "~3 hours", "90 min"
 */
export function parsePacingHint(text: string): PacingHint | null {
  if (!text) return null
  const matches = durationsIn(text)
  if (matches.length === 0) return null

  const estimate = ESTIMATE_RE.exec(text)
  const actual = ACTUAL_RE.exec(text)

  if (estimate && actual && actual.index > estimate.index && matches.length >= 2) {
    const said = firstAfter(matches, estimate.index)
    const took = firstAfter(matches, actual.index)
    if (said && took && said.minutes > 0 && took.index > said.index) {
      const multiplier = clamp(took.minutes / said.minutes, MIN_MULTIPLIER, MAX_MULTIPLIER)
      return { kind: "multiplier", multiplier }
    }
  }

  if (actual) {
    const took = firstAfter(matches, actual.index) ?? matches[matches.length - 1]
    return { kind: "duration", minutes: clamp(took.minutes, MIN_MINUTES, MAX_MINUTES) }
  }

  return { kind: "duration", minutes: clamp(matches[0].minutes, MIN_MINUTES, MAX_MINUTES) }
}
