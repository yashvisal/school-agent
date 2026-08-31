import { describe, expect, test } from "vitest"

import { hungarianMax, pair, titleSimilarity } from "./score"

/**
 * The scorer is what decides whether a correct extraction passes. These are
 * the adversarial pairings CodeRabbit found in review; each once failed a
 * correct answer.
 */

const items = (...titles: string[]) =>
  titles.map((title) => ({ title, dueAt: undefined, kind: "other" as const }))

describe("pair — optimal title assignment", () => {
  test("maximum cardinality: an exact pair must not strand an eligible one", () => {
    // Greedy took Final Exam↔Final Exam and left Exam unmatched (F1 0.50).
    const { pairs, missing, extra } = pair(
      items("Exam", "Final Exam"),
      items("Final Exam", "Final")
    )
    // "Exam"↔"Final" is NOT eligible (similarity 0), so the only way to match
    // both is Exam↔"Final Exam" and "Final Exam"↔"Final" — giving up the exact
    // pair greedy would have grabbed first.
    expect(titleSimilarity("Exam", "Final")).toBeLessThan(0.5)
    expect(titleSimilarity("Final Exam", "Final")).toBeGreaterThanOrEqual(0.5)
    expect(pairs).toHaveLength(2)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    const map = new Map(pairs.map(([e, a]) => [e.title, a.title]))
    expect(map.get("Exam")).toBe("Final Exam")
    expect(map.get("Final Exam")).toBe("Final")
  })

  test("among maximum matchings, the higher total similarity wins", () => {
    // E1→A1 0.9, E1→A2 0.6, E2→A1 0.8, E2→A2 0.7: both perfect matchings have
    // cardinality 2, but only E1→A1 + E2→A2 (1.6) beats E1→A2 + E2→A1 (1.4).
    const scores: Record<string, number> = {
      "E1|A1": 0.9,
      "E1|A2": 0.6,
      "E2|A1": 0.8,
      "E2|A2": 0.7,
    }
    const assignment = hungarianMax(2, (r, c) => 1000 + scores[`E${r + 1}|A${c + 1}`])
    expect(assignment).toEqual([0, 1])
  })

  test("cardinality dominates similarity", () => {
    // Row 0 strongly prefers col 0, but taking it strands row 1 (its only
    // eligible column is col 0). Two weak pairs beat one strong pair.
    const w = (r: number, c: number) => {
      if (r === 0 && c === 0) return 1000 + 0.99
      if (r === 0 && c === 1) return 1000 + 0.5
      if (r === 1 && c === 0) return 1000 + 0.5
      return 0
    }
    expect(hungarianMax(2, w)).toEqual([1, 0])
  })

  test("unmatched items on both sides are reported", () => {
    const { pairs, missing, extra } = pair(
      items("Problem Set 1", "Midterm"),
      items("Problem Set 1", "Reading response")
    )
    expect(pairs).toHaveLength(1)
    expect(missing.map((m) => m.title)).toEqual(["Midterm"])
    expect(extra.map((e) => e.title)).toEqual(["Reading response"])
  })
})
