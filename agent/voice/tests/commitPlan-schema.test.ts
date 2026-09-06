import { describe, expect, test } from "vitest"

import { commitPlanInputSchema } from "../tools/commitPlan"

/**
 * The tool's own boundary. Core enforces all of this again and answers a `400`
 * naming the pick, but a model that gets the rejection here gets a message
 * written for it ("use taskId, or deadlineId, or title AND courseId") instead of
 * a Core error it has to interpret — and one fewer round trip.
 */

const DATE = "2026-09-14"
const block = { startMin: 675, endMin: 795 }
const parse = (picks: unknown[]) =>
  commitPlanInputSchema.safeParse({ date: DATE, picks })

const message = (picks: unknown[]) =>
  parse(picks).error?.issues.map((issue) => issue.message).join(" | ") ?? ""

describe("identity", () => {
  test("accepts exactly one complete identity, in each of its three forms", () => {
    expect(parse([{ taskId: "t1", ...block }]).success).toBe(true)
    expect(parse([{ deadlineId: "d1", ...block }]).success).toBe(true)
    expect(parse([{ title: "Pset 3", courseId: "c1", ...block }]).success).toBe(true)
  })

  test("rejects a pick that names no work", () => {
    expect(message([{ ...block }])).toMatch(/exactly ONE identity/)
  })

  test("rejects a title without its courseId, and the other way round", () => {
    expect(message([{ title: "Pset 3", ...block }])).toMatch(/title AND courseId/)
    expect(message([{ courseId: "c1", ...block }])).toMatch(/title AND courseId/)
  })

  test("rejects a pick carrying more than one identity", () => {
    // Resolving these by precedence would silently plan the task and ignore the
    // deadline — the agent's contradiction, hidden rather than raised.
    expect(message([{ taskId: "t1", deadlineId: "d1", ...block }])).toMatch(
      /exactly ONE identity/
    )
    expect(
      message([{ deadlineId: "d1", title: "Pset 3", courseId: "c1", ...block }])
    ).toMatch(/exactly ONE identity/)
  })
})

describe("blocks", () => {
  test("rejects an empty or backwards block", () => {
    expect(message([{ taskId: "t1", startMin: 675, endMin: 675 }])).toMatch(
      /endMin must be after startMin/
    )
    expect(message([{ taskId: "t1", startMin: 795, endMin: 675 }])).toMatch(
      /endMin must be after startMin/
    )
  })

  test("rejects two picks over the same minutes, and allows back-to-back", () => {
    expect(
      message([
        { taskId: "t1", startMin: 675, endMin: 795 },
        { taskId: "t2", startMin: 720, endMin: 840 },
      ])
    ).toMatch(/must not overlap/)

    expect(
      parse([
        { taskId: "t1", startMin: 675, endMin: 795 },
        { taskId: "t2", startMin: 795, endMin: 855 },
      ]).success
    ).toBe(true)
  })
})

describe("shape", () => {
  test("takes 1-3 picks and a YYYY-MM-DD date", () => {
    expect(parse([]).success).toBe(false)
    expect(
      parse([
        { taskId: "t1", startMin: 540, endMin: 600 },
        { taskId: "t2", startMin: 600, endMin: 660 },
        { taskId: "t3", startMin: 660, endMin: 720 },
        { taskId: "t4", startMin: 720, endMin: 780 },
      ]).success
    ).toBe(false)
    expect(
      commitPlanInputSchema.safeParse({
        date: "tomorrow",
        picks: [{ taskId: "t1", ...block }],
      }).success
    ).toBe(false)
  })
})
