import { describe, expect, test } from "vitest"

import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { tierFor } from "./lib/changes"
import { localDateToMs } from "./lib/time"
import { CLERK_ID, setupTest } from "./test.setup"

/**
 * `commitPlan` — the fourth Voice tool, and the only thing in Core that emits
 * origin `planner` (decided 2026-09-05).
 *
 * What these tests protect:
 * - **The verification is real.** Every pick is re-checked against Core's own
 *   feasible set: a block outside a free window, inside a class, or past the due
 *   minute is a `400`, and a refused commit writes nothing at all. That check is
 *   what earns the `auto` tier — without it, `planner` would be a way for the
 *   agent to write state unapproved.
 * - **A commit is authoritative for its date, and only for its own work.** The
 *   agent's earlier picks for that day come back unplanned; the student's own
 *   tasks are never touched.
 * - **It is idempotent.** The same commit twice writes one set of changes, so a
 *   retried turn cannot double the feed.
 */

const TZ = "America/New_York"
const DATE = "2026-09-14" // Monday
const at = (date: string, minutes: number) => localDateToMs(date, minutes, TZ)
const NOW = at(DATE, 6 * 60)

// Availability 9:00–21:00 minus the 10:00–11:15 class leaves two windows:
// 540–600 and 675–1260.
const MORNING = { startMin: 540, endMin: 600 }
const AFTERNOON = { startMin: 675, endMin: 795 }

type Seeded = { studentId: Id<"students">; courseId: Id<"courses"> }

async function seed(t: ReturnType<typeof setupTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const studentId = await ctx.db.insert("students", {
      clerkId: CLERK_ID,
      timezone: TZ,
      phone: "+15551234567",
      classBlocks: [
        { dayOfWeek: 1, startMin: 10 * 60, endMin: 11 * 60 + 15, label: "CS201" },
      ],
      availability: {
        weekly: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startMin: 9 * 60,
          endMin: 21 * 60,
        })),
        exceptions: [],
      },
      status: "active",
    })
    const courseId = await ctx.db.insert("courses", {
      studentId,
      name: "Compsci 201",
      code: "CS201",
      sourceRefs: { canvasCourseId: "1001" },
      status: "active",
      provenance: { source: "canvas", sourceRef: "courses/1001", confidence: 1 },
    })
    return { studentId, courseId }
  })
}

const addDeadline = (
  t: ReturnType<typeof setupTest>,
  seeded: Seeded,
  overrides: Record<string, unknown> = {}
) =>
  t.run(async (ctx) =>
    ctx.db.insert("deadlines", {
      studentId: seeded.studentId,
      courseId: seeded.courseId,
      title: "Pset 3",
      kind: "homework",
      dueAt: at("2026-09-17", 23 * 60 + 59),
      pointsPossible: 25,
      submissionStatus: "unsubmitted",
      externalIds: { canvasAssignmentId: "5001" },
      provenance: { source: "canvas", sourceRef: "assignments/5001", confidence: 1 },
      status: "active",
      ...overrides,
    })
  )

const commit = (
  t: ReturnType<typeof setupTest>,
  studentId: Id<"students">,
  picks: Record<string, unknown>[],
  date = DATE
) =>
  t.mutation(internal.voice.commitPlan, {
    studentId,
    date,
    now: NOW,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    picks: picks as any,
  })

const counts = (t: ReturnType<typeof setupTest>, studentId: Id<"students">) =>
  t.run(async (ctx) => {
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_student_status", (q) => q.eq("studentId", studentId))
      .take(100)
    const changes = await ctx.db
      .query("changes")
      .withIndex("by_student_createdAt", (q) => q.eq("studentId", studentId))
      .take(100)
    return { tasks, changes }
  })

// ---------------------------------------------------------------------------
// The tier
// ---------------------------------------------------------------------------

describe("the planner origin", () => {
  test("tierFor('planner') is auto — a commit does not wait for approval", () => {
    expect(tierFor("planner")).toBe("auto")
    expect(tierFor("chat")).toBe("needs_approval")
  })

  test("a conflict still holds it back", () => {
    expect(tierFor("planner", true)).toBe("needs_approval")
  })
})

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("commitPlan", () => {
  test("creates the task the plan named, planned for that date", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)

    const result = await commit(t, seeded.studentId, [
      { deadlineId, ...AFTERNOON },
    ])

    expect(result.committed).toHaveLength(1)
    expect(result.unplanned).toBe(0)
    expect(result.committed[0]).toMatchObject({
      deadlineId,
      title: "Pset 3",
      plannedFor: DATE,
      plannedStartMin: AFTERNOON.startMin,
      plannedEndMin: AFTERNOON.endMin,
    })

    // Visible to Face with no Face change: the Today panel reads exactly this.
    const tasks = await t
      .withIdentity({ subject: CLERK_ID })
      .query(api.tasks.list, {})
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: "Pset 3",
      deadlineId,
      courseId: seeded.courseId,
      type: "do",
      status: "todo",
      createdBy: "agent",
      plannedFor: DATE,
      plannedStartMin: AFTERNOON.startMin,
      plannedEndMin: AFTERNOON.endMin,
    })

    const { changes } = await counts(t, seeded.studentId)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      kind: "task_created",
      origin: "planner",
      tier: "auto",
      status: "applied",
      reason: `planned in the thread for ${DATE}`,
    })
  })

  test("an existing task is updated, not duplicated", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    const taskId = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        studentId: seeded.studentId,
        courseId: seeded.courseId,
        deadlineId,
        title: "Pset 3",
        type: "do",
        status: "todo",
        createdBy: "agent",
      })
    )

    // Named by taskId, and again by deadlineId: both resolve to the same option.
    await commit(t, seeded.studentId, [{ taskId, ...MORNING }])
    await commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }])

    const { tasks, changes } = await counts(t, seeded.studentId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      _id: taskId,
      plannedFor: DATE,
      plannedStartMin: AFTERNOON.startMin,
      plannedEndMin: AFTERNOON.endMin,
    })
    expect(changes.map((c) => c.kind)).toEqual(["task_updated", "task_updated"])
    // The second commit moved an already-planned block: that is a replan.
    expect(changes[1].reason).toBe(`replanned in the thread for ${DATE}`)
  })

  test("re-committing the same picks writes nothing the second time", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)

    await commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }])
    const first = await counts(t, seeded.studentId)

    const again = await commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }])
    const second = await counts(t, seeded.studentId)

    expect(again.committed).toHaveLength(1)
    expect(again.unplanned).toBe(0)
    expect(second.changes).toHaveLength(first.changes.length)
    expect(second.tasks).toHaveLength(first.tasks.length)
  })

  test("the option carries what was committed, so a replan can see it", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    await commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }])

    const plan = await t.query(internal.voice.getFeasibleActions, {
      studentId: seeded.studentId,
      date: DATE,
      now: NOW,
    })
    const option = plan.options.find((o) => o.deadlineId === deadlineId)
    expect(option?.planned).toEqual(AFTERNOON)
  })
})

// ---------------------------------------------------------------------------
// Verification — the property that earns the auto tier
// ---------------------------------------------------------------------------

describe("verification", () => {
  test("a block outside every free window is refused, and nothing is written", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)

    await expect(
      // 21:30–22:30 — past the end of the day's availability.
      commit(t, seeded.studentId, [{ deadlineId, startMin: 1290, endMin: 1350 }])
    ).rejects.toThrow(/400: pick "Pset 3" .* is not inside a free window/)

    const { tasks, changes } = await counts(t, seeded.studentId)
    expect(tasks).toHaveLength(0)
    expect(changes).toHaveLength(0)
  })

  test("a block overlapping a class is refused", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)

    await expect(
      // 10:00–11:15 is CS201.
      commit(t, seeded.studentId, [{ deadlineId, startMin: 600, endMin: 675 }])
    ).rejects.toThrow(/is not inside a free window/)

    const { changes } = await counts(t, seeded.studentId)
    expect(changes).toHaveLength(0)
  })

  test("a block running past the due minute is refused", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    // Due today at noon: nothing may be scheduled after 720.
    const deadlineId = await addDeadline(t, seeded, { dueAt: at(DATE, 12 * 60) })

    await expect(
      commit(t, seeded.studentId, [{ deadlineId, startMin: 675, endMin: 800 }])
    ).rejects.toThrow(/is not inside a free window/)

    // The same work, ending by noon, is fine.
    const ok = await commit(t, seeded.studentId, [
      { deadlineId, startMin: 675, endMin: 720 },
    ])
    expect(ok.committed).toHaveLength(1)
  })

  test("work that is not in the feasible set is refused", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded, {
      submissionStatus: "submitted",
    })

    await expect(
      commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }])
    ).rejects.toThrow(/matches nothing in the feasible set/)
  })

  test("one bad pick refuses the whole commit", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const first = await addDeadline(t, seeded)
    const second = await addDeadline(t, seeded, {
      title: "Pset 4",
      externalIds: { canvasAssignmentId: "5002" },
    })

    await expect(
      commit(t, seeded.studentId, [
        { deadlineId: first, ...AFTERNOON },
        { deadlineId: second, startMin: 1290, endMin: 1350 },
      ])
    ).rejects.toThrow(/400: pick "Pset 4"/)

    const { tasks, changes } = await counts(t, seeded.studentId)
    expect(tasks).toHaveLength(0)
    expect(changes).toHaveLength(0)
  })

  test("more than three picks is refused", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const picks = []
    for (let i = 0; i < 4; i++) {
      picks.push({
        deadlineId: await addDeadline(t, seeded, {
          title: `Pset ${i}`,
          externalIds: { canvasAssignmentId: `600${i}` },
        }),
        ...AFTERNOON,
      })
    }
    await expect(commit(t, seeded.studentId, picks)).rejects.toThrow(
      /400: commitPlan takes 1-3 picks/
    )
    await expect(commit(t, seeded.studentId, [])).rejects.toThrow(
      /400: commitPlan takes 1-3 picks/
    )
  })

  test("the same work twice in one commit is refused", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    await expect(
      commit(t, seeded.studentId, [
        { deadlineId, ...MORNING },
        { deadlineId, ...AFTERNOON },
      ])
    ).rejects.toThrow(/names the same work twice/)
  })
})

// ---------------------------------------------------------------------------
// Authoritative for the date
// ---------------------------------------------------------------------------

describe("a commit replaces the day", () => {
  test("an agent task dropped from the plan is unplanned, not skipped", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const first = await addDeadline(t, seeded)
    const second = await addDeadline(t, seeded, {
      title: "Pset 4",
      externalIds: { canvasAssignmentId: "5002" },
    })

    const one = await commit(t, seeded.studentId, [{ deadlineId: first, ...MORNING }])
    const droppedTaskId = one.committed[0].taskId

    const two = await commit(t, seeded.studentId, [
      { deadlineId: second, ...AFTERNOON },
    ])
    expect(two.unplanned).toBe(1)

    const dropped = await t.run((ctx) => ctx.db.get("tasks", droppedTaskId))
    expect(dropped?.plannedFor).toBeUndefined()
    expect(dropped?.plannedStartMin).toBeUndefined()
    expect(dropped?.plannedEndMin).toBeUndefined()
    // The student never said no — it is off the day, not refused.
    expect(dropped?.status).toBe("todo")

    const { changes } = await counts(t, seeded.studentId)
    expect(changes.at(-1)).toMatchObject({
      kind: "task_updated",
      origin: "planner",
      reason: `unplanned for ${DATE} — replaced by the plan committed in the thread`,
    })
  })

  test("a task the student made themselves is never touched", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    const mine = await t.run(async (ctx) =>
      ctx.db.insert("tasks", {
        studentId: seeded.studentId,
        courseId: seeded.courseId,
        title: "read for seminar",
        type: "do",
        status: "todo",
        plannedFor: DATE,
        plannedStartMin: 1000,
        createdBy: "student",
      })
    )

    const result = await commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }])
    expect(result.unplanned).toBe(0)

    const still = await t.run((ctx) => ctx.db.get("tasks", mine))
    expect(still).toMatchObject({ plannedFor: DATE, plannedStartMin: 1000 })
  })

  test("a plan for another day leaves this day alone", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    const today = await commit(t, seeded.studentId, [{ deadlineId, ...MORNING }])

    await commit(t, seeded.studentId, [{ deadlineId, ...AFTERNOON }], "2026-09-15")

    const task = await t.run((ctx) => ctx.db.get("tasks", today.committed[0].taskId))
    expect(task).toMatchObject({ plannedFor: "2026-09-15" })
  })
})

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe("tenancy", () => {
  test("a planRunId belonging to someone else is refused", async () => {
    const t = setupTest()
    const seeded = await seed(t)
    const deadlineId = await addDeadline(t, seeded)
    const otherStudentId = await t.run(async (ctx) =>
      ctx.db.insert("students", {
        clerkId: "user_test_stranger",
        timezone: TZ,
        classBlocks: [],
        availability: { weekly: [], exceptions: [] },
        status: "active",
      })
    )
    const planRunId = await t.run(async (ctx) =>
      ctx.db.insert("planRuns", {
        studentId: otherStudentId,
        date: DATE,
        computedAt: NOW,
        feasible: { date: DATE, windows: [], options: [] },
        pendingAnnotations: [],
        signalsDigest: {
          availability: [],
          pacing: [],
          preference: [],
          difficulty: [],
          life_event: [],
          other: [],
        },
        operationId: `nightly:${otherStudentId}:${DATE}`,
        triggerStatus: "pending",
      })
    )

    await expect(
      t.mutation(internal.voice.commitPlan, {
        studentId: seeded.studentId,
        date: DATE,
        now: NOW,
        planRunId,
        picks: [{ deadlineId, ...AFTERNOON }],
      })
    ).rejects.toThrow(/400: planRunId is not a run for this student/)
  })
})
