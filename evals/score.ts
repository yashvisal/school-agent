import type {
  NormalizedExtraction,
  SemesterWindow,
} from "../convex/lib/extraction/normalize"
import { normalizeSyllabusExtraction } from "../convex/lib/extraction/normalize"
import type { SyllabusExtraction } from "../convex/lib/extraction/schemas"

/**
 * Scoring for the extraction evals (core.md "Definition of done": every real
 * syllabus, course site and schedule upload has a hand-verified expected-output
 * fixture, and the extraction pipelines run against them).
 *
 * The scores are chosen to fail on the ways extraction actually goes wrong,
 * which are not symmetric:
 *
 * - **Hallucinated dates are a hard failure, not a lost point.** An invented
 *   date is worse than a missing one: the student sees a confident deadline
 *   that does not exist, and the planner schedules real hours against it. So
 *   any item that carries a date where the fixture says the document gave none
 *   fails the eval outright, whatever the F1 is.
 * - **Grading weights are exact.** They are numbers copied out of a table;
 *   there is no "close enough" for 30% vs 35%, and the grading scheme is the one
 *   thing the syllabus outranks Canvas on (core.md "Merge precedence").
 * - **Deadline titles are fuzzy-matched.** "L2 (bomblab)" vs "Bomb Lab (L2)" is
 *   the same deadline; requiring string equality would measure the model's
 *   phrasing rather than its reading.
 */

export type FixtureMeta = {
  timezone: string
  semester: SemesterWindow
  /** What this fixture is meant to catch; printed on failure. */
  note?: string
}

const DEADLINE_F1_FLOOR = 0.8
const TITLE_MATCH_FLOOR = 0.5

/** Lowercased alphanumeric tokens; punctuation and case never decide a match. */
const tokens = (title: string): string[] =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token.length > 0)

/** Dice coefficient over token sets: 1 = same words, 0 = nothing in common. */
export function titleSimilarity(a: string, b: string): number {
  const left = new Set(tokens(a))
  const right = new Set(tokens(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return (2 * shared) / (left.size + right.size)
}

export type DeadlineScore = {
  expected: number
  extracted: number
  matched: number
  precision: number
  recall: number
  f1: number
  missing: string[]
  extra: string[]
}

export type DateScore = {
  /** Expected items that carry a date. */
  checked: number
  correct: number
  wrong: string[]
  /** Items given a date the document never stated. Any entry fails the eval. */
  hallucinated: string[]
  /** Expected dates the model dropped. Counted, but not a hard failure. */
  lost: string[]
}

export type GradingScore = {
  expected: number
  matched: number
  exact: boolean
  mismatches: string[]
}

export type FixtureScore = {
  fixture: string
  deadlines: DeadlineScore
  dates: DateScore
  grading: GradingScore
  passed: boolean
  failures: string[]
}

type Item = { title: string; dueAt?: number }

/**
 * Greedy best-first pairing. Greedy rather than optimal because the alternative
 * (Hungarian) buys nothing here: titles in one document are far apart, so the
 * best pair is nearly always unambiguous, and a greedy mismatch would show up as
 * BOTH a miss and an extra rather than hiding.
 */
function pair(
  expected: Item[],
  actual: Item[]
): { pairs: [Item, Item][]; missing: Item[]; extra: Item[] } {
  const scored: { score: number; e: number; a: number }[] = []
  expected.forEach((e, ei) =>
    actual.forEach((a, ai) => {
      const score = titleSimilarity(e.title, a.title)
      if (score >= TITLE_MATCH_FLOOR) scored.push({ score, e: ei, a: ai })
    })
  )
  scored.sort((x, y) => y.score - x.score)

  const usedE = new Set<number>()
  const usedA = new Set<number>()
  const pairs: [Item, Item][] = []
  for (const { e, a } of scored) {
    if (usedE.has(e) || usedA.has(a)) continue
    usedE.add(e)
    usedA.add(a)
    pairs.push([expected[e], actual[a]])
  }
  return {
    pairs,
    missing: expected.filter((_, i) => !usedE.has(i)),
    extra: actual.filter((_, i) => !usedA.has(i)),
  }
}

const iso = (ms?: number) => (ms === undefined ? "no date" : new Date(ms).toISOString())

export function scoreExtraction(
  fixture: string,
  expected: NormalizedExtraction,
  actual: NormalizedExtraction
): FixtureScore {
  const { pairs, missing, extra } = pair(expected.deadlines, actual.deadlines)

  const precision =
    actual.deadlines.length === 0
      ? expected.deadlines.length === 0
        ? 1
        : 0
      : pairs.length / actual.deadlines.length
  const recall =
    expected.deadlines.length === 0 ? 1 : pairs.length / expected.deadlines.length
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  const dates: DateScore = { checked: 0, correct: 0, wrong: [], hallucinated: [], lost: [] }
  for (const [want, got] of pairs) {
    if (want.dueAt === undefined) {
      if (got.dueAt !== undefined) {
        dates.hallucinated.push(`"${got.title}" got ${iso(got.dueAt)}; the document states none`)
      }
      continue
    }
    dates.checked++
    if (got.dueAt === undefined) {
      dates.lost.push(`"${want.title}" lost its date (${iso(want.dueAt)})`)
    } else if (got.dueAt === want.dueAt) {
      dates.correct++
    } else {
      dates.wrong.push(`"${want.title}" expected ${iso(want.dueAt)}, got ${iso(got.dueAt)}`)
    }
  }
  // An item the model invented outright, given a date, is a hallucination too —
  // it is the shape of "the model filled in a plausible-looking semester".
  for (const item of extra) {
    if (item.dueAt !== undefined) {
      dates.hallucinated.push(
        `"${item.title}" (${iso(item.dueAt)}) is not in the document at all`
      )
    }
  }

  const grading = scoreGrading(expected, actual)

  const failures: string[] = []
  if (f1 < DEADLINE_F1_FLOOR) {
    failures.push(
      `deadline F1 ${f1.toFixed(2)} is below ${DEADLINE_F1_FLOOR} ` +
        `(precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)})`
    )
  }
  if (dates.hallucinated.length > 0) {
    failures.push(`invented ${dates.hallucinated.length} date(s): ${dates.hallucinated.join("; ")}`)
  }
  if (dates.wrong.length > 0) failures.push(`wrong date(s): ${dates.wrong.join("; ")}`)
  // A stated date the extraction dropped is as disqualifying as a wrong one —
  // titles alone can clear the F1 floor while every date is gone (CR 3898632591).
  if (dates.lost.length > 0) failures.push(`lost stated date(s): ${dates.lost.join("; ")}`)
  if (!grading.exact) failures.push(`grading scheme: ${grading.mismatches.join("; ")}`)

  return { fixture, deadlines: { expected: expected.deadlines.length, extracted: actual.deadlines.length, matched: pairs.length, precision, recall, f1, missing: missing.map((m) => m.title), extra: extra.map((e) => e.title) }, dates, grading, passed: failures.length === 0, failures }
}

function scoreGrading(
  expected: NormalizedExtraction,
  actual: NormalizedExtraction
): GradingScore {
  const want = expected.course.gradingScheme?.categories ?? []
  const got = actual.course.gradingScheme?.categories ?? []
  const mismatches: string[] = []
  let matched = 0

  // One-to-one: an extracted "Quizzes and Exams" must not satisfy both an
  // expected "Quizzes" and an expected "Exams" (CR 3898632598).
  const used = new Set<number>()
  for (const category of want) {
    const hitIndex = got
      .map((candidate, index) => ({ index, score: titleSimilarity(category.name, candidate.name) }))
      .filter((entry) => entry.score >= TITLE_MATCH_FLOOR && !used.has(entry.index))
      .sort((a, b) => b.score - a.score)[0]?.index
    const hit = hitIndex === undefined ? undefined : got[hitIndex]
    if (hitIndex !== undefined) used.add(hitIndex)
    if (!hit) {
      mismatches.push(`missing category "${category.name}"`)
      continue
    }
    if (hit.weight !== category.weight) {
      mismatches.push(
        `"${category.name}" expected weight ${category.weight ?? "none"}, got ${hit.weight ?? "none"}`
      )
      continue
    }
    matched++
  }
  if (got.length > want.length) {
    mismatches.push(`${got.length - want.length} extra categor(ies): ${got.map((c) => c.name).join(", ")}`)
  }

  return { expected: want.length, matched, exact: mismatches.length === 0, mismatches }
}

/** Both sides go through the SAME normalizer, so the eval scores what ships. */
export const normalizeFor = (
  extraction: SyllabusExtraction,
  meta: FixtureMeta,
  source: "syllabus" | "site"
): NormalizedExtraction =>
  normalizeSyllabusExtraction({
    extraction,
    timezone: meta.timezone,
    source,
    semester: meta.semester,
  })

export function formatScore(score: FixtureScore): string {
  const d = score.deadlines
  return [
    `${score.passed ? "PASS" : "FAIL"}  ${score.fixture}`,
    `  deadlines  precision ${d.precision.toFixed(2)}  recall ${d.recall.toFixed(2)}  ` +
      `F1 ${d.f1.toFixed(2)}  (${d.matched}/${d.expected} expected, ${d.extracted} extracted)`,
    `  dates      ${score.dates.correct}/${score.dates.checked} exact, ` +
      `${score.dates.hallucinated.length} invented, ${score.dates.lost.length} lost`,
    `  grading    ${score.grading.matched}/${score.grading.expected} categories exact`,
    d.missing.length > 0 ? `  missing    ${d.missing.join(" | ")}` : "",
    d.extra.length > 0 ? `  extra      ${d.extra.join(" | ")}` : "",
    ...score.failures.map((failure) => `  ✗ ${failure}`),
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}
