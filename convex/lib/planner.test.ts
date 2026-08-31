import { describe, expect, test } from "vitest"

import type { Doc, Id } from "../_generated/dataModel"
import { EFFORT_PRIORS_MIN, parsePacingHint } from "./effortPriors"
import type { FeasibleActionsInput, Option } from "./planner"
import {
  MIN_BLOCK_MIN,
  OVERDUE_LOOKBACK_DAYS,
  feasibleActions,
  windowsForDate,
} from "./planner"
import { addDays, localDateToMs } from "./time"

/**
 * The planner's hard guarantees (core.md, "Planner v0"; vision §10).
 *
 * These are the tests that make an LLM mistake non-catastrophic: if the feasible
 * set is right, the worst the agent can do is pick a mediocre option. If the set
 * is wrong — a window over a class, a slot after the due time, a submitted item
 * resurrected, a pending value planned on as fact — the student misses a
 * deadline and never trusts the thing again.
 */

const TZ = "America/New_York"

// Monday 2026-09-14 through the following week.
const MON = "2026-09-14"
const TUE = "2026-09-15"
const WED = "2026-09-16"
const THU = "2026-09-17"

const at = (date: string, minutes: number) => localDateToMs(date, minutes, TZ)

/** 3am Monday: before the day starts, so "today" offers its whole window set. */
const NOW = at(MON, 3 * 60)

const id = <T extends string>(table: T, n: number) =>
  `${table}_${n}` as unknown as Id<T & "students">

const studentId = "students_1" as Id<"students">
const courseId = "courses_1" as Id<"courses">

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Weekly = { dayOfWeek: number; startMin: number; endMin: number; label?: string }

function student(overrides: {
  weekly?: Weekly[]
  exceptions?: { date: string; blocks: Weekly[] }[]
  classBlocks?: Weekly[]
}): FeasibleActionsInput["student"] {
  return {
    classBlocks: overrides.classBlocks ?? [],
    availability: {
      weekly: overrides.weekly ?? [],
      exceptions: overrides.exceptions ?? [],
    },
  }
}

/** 9am–9pm every weekday. */
const WEEKDAY_9_TO_21: Weekly[] = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  startMin: 9 * 60,
  endMin: 21 * 60,
}))

function course(overrides: Partial<Doc<"courses">> = {}): Doc<"courses"> {
  return {
    _id: courseId,
    _creationTime: 0,
    studentId,
    name: "Compsci 201",
    code: "CS201",
    sourceRefs: { canvasCourseId: "1001" },
    gradingScheme: {
      categories: [{ name: "Problem Sets", weight: 0.3 }],
    },
    status: "active",
    provenance: { source: "canvas", sourceRef: "courses/1001", confidence: 1 },
    ...overrides,
  } as Doc<"courses">
}

let deadlineSeq = 0
function deadline(overrides: Partial<Doc<"deadlines">> = {}): Doc<"deadlines"> {
  deadlineSeq++
  return {
    _id: id("deadlines", deadlineSeq) as unknown as Id<"deadlines">,
    _creationTime: 0,
    studentId,
    courseId,
    title: "Pset 3",
    kind: "homework",
    dueAt: at(THU, 23 * 60 + 59),
    pointsPossible: 25,
    category: "Problem Sets",
    submissionStatus: "unsubmitted",
    externalIds: { canvasAssignmentId: String(5000 + deadlineSeq) },
    provenance: { source: "canvas", sourceRef: "assignments/5001", confidence: 1 },
    status: "active",
    ...overrides,
  } as Doc<"deadlines">
}

let taskSeq = 0
function task(overrides: Partial<Doc<"tasks">> = {}): Doc<"tasks"> {
  taskSeq++
  return {
    _id: id("tasks", taskSeq) as unknown as Id<"tasks">,
    _creationTime: 0,
    studentId,
    courseId,
    title: "Work on pset 3",
    type: "do",
    status: "todo",
    createdBy: "agent",
    ...overrides,
  } as Doc<"tasks">
}

let changeSeq = 0
function change(overrides: Partial<Doc<"changes">> = {}): Doc<"changes"> {
  changeSeq++
  return {
    _id: id("changes", changeSeq) as unknown as Id<"changes">,
    _creationTime: 0,
    studentId,
    kind: "deadline_moved",
    entity: { table: "deadlines" },
    origin: "chat",
    tier: "needs_approval",
    status: "pending",
    snapshotIds: [],
    createdAt: NOW,
    ...overrides,
  } as Doc<"changes">
}

let signalSeq = 0
function signal(overrides: Partial<Doc<"studentSignals">> = {}): Doc<"studentSignals"> {
  signalSeq++
  return {
    _id: id("studentSignals", signalSeq) as unknown as Id<"studentSignals">,
    _creationTime: 0,
    studentId,
    kind: "pacing",
    text: "said 2h, took 4h on the pset",
    refs: { courseId },
    origin: "chat",
    observedAt: NOW - signalSeq * 1000,
    provenance: { source: "chat", sourceRef: "session_1", confidence: 0.6 },
    ...overrides,
  } as Doc<"studentSignals">
}

function plan(overrides: Partial<FeasibleActionsInput> = {}) {
  return feasibleActions({
    date: MON,
    timezone: TZ,
    now: NOW,
    student: student({ weekly: WEEKDAY_9_TO_21 }),
    courses: [course()],
    deadlines: [],
    tasks: [],
    pendingChanges: [],
    signals: [],
    ...overrides,
  })
}

const only = (options: Option[]): Option => {
  expect(options).toHaveLength(1)
  return options[0]
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

describe("windows", () => {
  test("the day's availability comes from the weekly template for that weekday", () => {
    const { windows } = plan()
    expect(windows).toEqual([
      { startMin: 9 * 60, endMin: 21 * 60, durationMin: 12 * 60 },
    ])
  })

  test("a weekday with no template entry has no windows", () => {
    // 2026-09-13 is a Sunday; the template only covers Mon-Fri.
    expect(plan({ date: "2026-09-13", now: at("2026-09-13", 60) }).windows).toEqual([])
  })

  test("class blocks are subtracted, splitting the day", () => {
    const { windows } = plan({
      student: student({
        weekly: WEEKDAY_9_TO_21,
        classBlocks: [
          { dayOfWeek: 1, startMin: 10 * 60, endMin: 11 * 60 + 15, label: "CS201" },
          { dayOfWeek: 1, startMin: 13 * 60, endMin: 14 * 60 },
        ],
      }),
    })
    expect(windows).toEqual([
      { startMin: 9 * 60, endMin: 10 * 60, durationMin: 60 },
      { startMin: 11 * 60 + 15, endMin: 13 * 60, durationMin: 105 },
      { startMin: 14 * 60, endMin: 21 * 60, durationMin: 7 * 60 },
    ])
  })

  test("a class block on another weekday does not touch this day", () => {
    const { windows } = plan({
      student: student({
        weekly: WEEKDAY_9_TO_21,
        classBlocks: [{ dayOfWeek: 2, startMin: 10 * 60, endMin: 12 * 60 }],
      }),
    })
    expect(windows).toHaveLength(1)
  })

  test("an exceptions entry for the date replaces the weekly template", () => {
    const { windows } = plan({
      student: student({
        weekly: WEEKDAY_9_TO_21,
        exceptions: [
          {
            date: MON,
            blocks: [{ dayOfWeek: 1, startMin: 18 * 60, endMin: 20 * 60 }],
          },
        ],
      }),
    })
    expect(windows).toEqual([
      { startMin: 18 * 60, endMin: 20 * 60, durationMin: 120 },
    ])
  })

  test("an exception for a different date is ignored", () => {
    const { windows } = plan({
      student: student({
        weekly: WEEKDAY_9_TO_21,
        exceptions: [
          { date: TUE, blocks: [{ dayOfWeek: 2, startMin: 60, endMin: 120 }] },
        ],
      }),
    })
    expect(windows[0].startMin).toBe(9 * 60)
  })

  test("class blocks still apply on top of an exception", () => {
    const { windows } = plan({
      student: student({
        weekly: WEEKDAY_9_TO_21,
        classBlocks: [{ dayOfWeek: 1, startMin: 18 * 60, endMin: 19 * 60 }],
        exceptions: [
          { date: MON, blocks: [{ dayOfWeek: 1, startMin: 17 * 60, endMin: 21 * 60 }] },
        ],
      }),
    })
    expect(windows).toEqual([
      { startMin: 17 * 60, endMin: 18 * 60, durationMin: 60 },
      { startMin: 19 * 60, endMin: 21 * 60, durationMin: 120 },
    ])
  })

  test("time already past today is not offered", () => {
    const { windows } = plan({ now: at(MON, 14 * 60 + 30) })
    expect(windows).toEqual([
      { startMin: 14 * 60 + 30, endMin: 21 * 60, durationMin: 390 },
    ])
  })

  test("a day already gone offers nothing", () => {
    expect(plan({ date: "2026-09-11", now: NOW }).windows).toEqual([])
  })

  test("a future day is offered whole, regardless of the current time", () => {
    const { windows } = plan({ date: TUE, now: at(MON, 20 * 60) })
    expect(windows).toEqual([{ startMin: 9 * 60, endMin: 21 * 60, durationMin: 720 }])
  })

  test("overlapping availability blocks are merged, not double-counted", () => {
    const { windows } = plan({
      student: student({
        weekly: [
          { dayOfWeek: 1, startMin: 9 * 60, endMin: 12 * 60 },
          { dayOfWeek: 1, startMin: 11 * 60, endMin: 15 * 60 },
        ],
      }),
    })
    expect(windows).toEqual([{ startMin: 9 * 60, endMin: 15 * 60, durationMin: 360 }])
  })

  test("windowsForDate is exported and agrees with the planner", () => {
    const input = {
      timezone: TZ,
      now: NOW,
      student: student({ weekly: WEEKDAY_9_TO_21 }),
    }
    expect(windowsForDate(input, MON)).toEqual(plan().windows)
  })
})

// ---------------------------------------------------------------------------
// Hard guarantee: fits never overlap a class
// ---------------------------------------------------------------------------

describe("hard guarantee — fits never overlap a class block", () => {
  test("across a heavily blocked day, every fit sits in a gap", () => {
    const classBlocks = [
      { dayOfWeek: 1, startMin: 10 * 60, endMin: 11 * 60 + 15 },
      { dayOfWeek: 1, startMin: 13 * 60, endMin: 14 * 60 + 30 },
      { dayOfWeek: 1, startMin: 16 * 60, endMin: 17 * 60 },
    ]
    const result = plan({
      student: student({ weekly: WEEKDAY_9_TO_21, classBlocks }),
      deadlines: [deadline({ kind: "reading" }), deadline({ kind: "homework" })],
    })

    expect(result.options.length).toBeGreaterThan(0)
    for (const option of result.options) {
      expect(option.fits.length).toBeGreaterThan(0)
      for (const fit of option.fits) {
        for (const block of classBlocks) {
          const overlaps = fit.startMin < block.endMin && fit.endMin > block.startMin
          expect(overlaps).toBe(false)
        }
      }
    }
  })

  test("a fit always lies inside the window it names", () => {
    const result = plan({
      student: student({
        weekly: WEEKDAY_9_TO_21,
        classBlocks: [{ dayOfWeek: 1, startMin: 12 * 60, endMin: 13 * 60 }],
      }),
      deadlines: [deadline()],
    })
    for (const fit of only(result.options).fits) {
      const window = result.windows[fit.windowIndex]
      expect(window).toBeDefined()
      expect(fit.startMin).toBeGreaterThanOrEqual(window.startMin)
      expect(fit.endMin).toBeLessThanOrEqual(window.endMin)
    }
  })
})

// ---------------------------------------------------------------------------
// Hard guarantee: fits never end after the due time
// ---------------------------------------------------------------------------

describe("hard guarantee — fits never end after dueAt", () => {
  test("a deadline due at 2pm today truncates the day's windows", () => {
    const result = plan({
      deadlines: [deadline({ dueAt: at(MON, 14 * 60), kind: "reading" })],
    })
    const option = only(result.options)
    expect(option.fits.length).toBeGreaterThan(0)
    for (const fit of option.fits) {
      expect(fit.endMin).toBeLessThanOrEqual(14 * 60)
    }
  })

  test("a deadline due before the first window today has no fits", () => {
    const result = plan({
      deadlines: [deadline({ dueAt: at(MON, 9 * 60 + 10), kind: "homework" })],
    })
    const option = only(result.options)
    expect(option.fits).toEqual([])
    expect(option.facts).toContain("does not fit in any free window on this day")
  })

  test("a deadline due on a later day is not truncated", () => {
    const result = plan({ deadlines: [deadline({ dueAt: at(THU, 12 * 60) })] })
    const fits = only(result.options).fits
    expect(fits[0].startMin).toBe(9 * 60)
    expect(fits[0].endMin).toBe(9 * 60 + EFFORT_PRIORS_MIN.homework)
  })

  test("a deadline already past is emitted as overdue, with nothing to fit", () => {
    const result = plan({
      deadlines: [deadline({ dueAt: at("2026-09-11", 12 * 60) })],
    })
    // A missed deadline the agent must be able to mention — but the hard
    // guarantee holds: there is no window after the due time, so there is no fit.
    const option = only(result.options)
    expect(option.overdue).toBe(true)
    expect(option.fits).toEqual([])
    expect(option.remainingWindowsBeforeDue).toBe(0)
    expect(option.facts).toContain("past due Fri Sep 11 12pm (3 days ago), not submitted")
    expect(option.facts).not.toContain("does not fit in any free window on this day")
  })

  test("overdue work that was handed in is still dropped", () => {
    for (const submissionStatus of ["submitted", "graded", "excused"] as const) {
      const result = plan({
        deadlines: [deadline({ dueAt: at("2026-09-11", 12 * 60), submissionStatus })],
      })
      expect(result.options).toEqual([])
    }
  })

  test("a deadline past the overdue lookback is gone for good", () => {
    const result = plan({
      deadlines: [
        deadline({ dueAt: at(addDays(MON, -OVERDUE_LOOKBACK_DAYS - 1), 12 * 60) }),
      ],
    })
    expect(result.options).toEqual([])
  })

  test("a deadline due earlier today is emitted as overdue, but nothing fits", () => {
    const result = plan({
      date: MON,
      now: at(MON, 15 * 60),
      deadlines: [deadline({ dueAt: at(MON, 10 * 60) })],
    })
    // Due today, so still emitted — but nothing fits, and the agent is told.
    const option = only(result.options)
    expect(option.fits).toEqual([])
    expect(option.overdue).toBeUndefined() // due *today* is not yet a miss
  })
})

// ---------------------------------------------------------------------------
// Hard guarantee: closed work never reappears
// ---------------------------------------------------------------------------

describe("hard guarantee — closed work is never emitted", () => {
  for (const submissionStatus of ["submitted", "graded", "excused"] as const) {
    test(`${submissionStatus} deadlines are dropped`, () => {
      expect(plan({ deadlines: [deadline({ submissionStatus })] }).options).toEqual([])
    })
  }

  for (const submissionStatus of ["unsubmitted", "missing", "unknown"] as const) {
    test(`${submissionStatus} deadlines are kept`, () => {
      expect(plan({ deadlines: [deadline({ submissionStatus })] }).options).toHaveLength(1)
    })
  }

  test("a removed deadline is dropped", () => {
    expect(plan({ deadlines: [deadline({ status: "removed" })] }).options).toEqual([])
  })

  test("done and skipped tasks are dropped", () => {
    const result = plan({
      tasks: [task({ status: "done", deadlineId: undefined }), task({ status: "skipped" })],
    })
    expect(result.options).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------

describe("horizon", () => {
  test("a deadline past the default 14-day horizon is filtered out", () => {
    const result = plan({
      deadlines: [deadline({ dueAt: at("2026-10-15", 12 * 60) })],
    })
    expect(result.options).toEqual([])
  })

  test("a deadline inside the horizon is kept", () => {
    const result = plan({
      deadlines: [deadline({ dueAt: at("2026-09-25", 12 * 60) })],
    })
    expect(result.options).toHaveLength(1)
  })

  test("horizonDays narrows the set", () => {
    const deadlines = [deadline({ dueAt: at("2026-09-20", 12 * 60) })]
    expect(plan({ deadlines }).options).toHaveLength(1)
    expect(plan({ deadlines, horizonDays: 2 }).options).toEqual([])
  })

  test("an undated deadline is always a candidate", () => {
    const result = plan({ deadlines: [deadline({ dueAt: undefined })] })
    const option = only(result.options)
    expect(option.dueAt).toBeUndefined()
    expect(option.dueInDays).toBeUndefined()
    expect(option.facts).toContain("no due date on record")
  })
})

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

describe("effort priors", () => {
  const cases: Array<[Doc<"deadlines">["kind"], number]> = [
    ["reading", 45],
    ["homework", 120],
    ["quiz", 60],
    ["project", 240],
    ["exam", 180],
    ["other", 60],
  ]

  for (const [kind, minutes] of cases) {
    test(`${kind} → ${minutes}m, low confidence`, () => {
      const option = only(plan({ deadlines: [deadline({ kind })] }).options)
      expect(option.estEffortMin).toBe(minutes)
      expect(option.estEffortConfidence).toBe("low")
      expect(option.effortSource).toBe("prior")
    })
  }

  test("the prior is labeled as a prior in the facts", () => {
    const option = only(plan({ deadlines: [deadline({ kind: "homework" })] }).options)
    expect(option.facts).toContain("effort ~2h (low-confidence prior)")
  })

  test("an explicit task estimate takes precedence over the prior", () => {
    const target = deadline({ kind: "homework" })
    const option = only(
      plan({
        deadlines: [target],
        tasks: [
          task({
            deadlineId: target._id,
            estEffortMin: 300,
            estEffortConfidence: "high",
          }),
        ],
      }).options
    )
    expect(option.estEffortMin).toBe(300)
    expect(option.estEffortConfidence).toBe("high")
  })
})

describe("pacing signals override the prior", () => {
  test('"said 2h, took 4h" doubles the prior and raises confidence to medium', () => {
    const option = only(
      plan({
        deadlines: [deadline({ kind: "homework" })],
        signals: [signal({ text: "said 2h, took 4h on CS pset 3" })],
      }).options
    )
    expect(option.estEffortMin).toBe(240)
    expect(option.estEffortConfidence).toBe("medium")
    expect(option.effortSource).toBe("signal")
  })

  test("the annotation names the signal it came from", () => {
    const option = only(
      plan({
        deadlines: [deadline({ kind: "homework" })],
        signals: [signal({ text: "said 2h, took 4h on CS pset 3" })],
      }).options
    )
    expect(
      option.facts.some((f) => f.includes("said 2h, took 4h on CS pset 3"))
    ).toBe(true)
    expect(option.signals).toContain("said 2h, took 4h on CS pset 3")
  })

  test("an absolute duration replaces the prior outright", () => {
    const option = only(
      plan({
        deadlines: [deadline({ kind: "reading" })],
        signals: [signal({ text: "the readings take ~3 hours" })],
      }).options
    )
    expect(option.estEffortMin).toBe(180)
    expect(option.effortSource).toBe("signal")
  })

  test("a pacing signal for another course does not leak", () => {
    const otherCourse = "courses_2" as Id<"courses">
    const option = only(
      plan({
        deadlines: [deadline({ kind: "homework" })],
        signals: [
          signal({ text: "said 1h, took 5h", refs: { courseId: otherCourse } }),
        ],
      }).options
    )
    expect(option.estEffortMin).toBe(120)
    expect(option.effortSource).toBe("prior")
  })

  test("a non-pacing signal is surfaced but never moves the estimate", () => {
    const option = only(
      plan({
        deadlines: [deadline({ kind: "homework" })],
        signals: [
          signal({ kind: "difficulty", text: "this class takes 3h a night, brutal" }),
        ],
      }).options
    )
    expect(option.estEffortMin).toBe(120)
    expect(option.effortSource).toBe("prior")
    expect(option.signals).toContain("this class takes 3h a night, brutal")
  })

  test("a pacing signal with no readable duration leaves the prior alone", () => {
    const option = only(
      plan({
        deadlines: [deadline({ kind: "homework" })],
        signals: [signal({ text: "psets always run long" })],
      }).options
    )
    expect(option.estEffortMin).toBe(120)
    expect(option.effortSource).toBe("prior")
  })
})

describe("parsePacingHint", () => {
  test("estimate-then-actual yields a multiplier", () => {
    expect(parsePacingHint("said 2h, took 4h on CS pset 3")).toEqual({
      kind: "multiplier",
      multiplier: 2,
    })
    expect(parsePacingHint("thought it was 30 min but it took 90 minutes")).toEqual({
      kind: "multiplier",
      multiplier: 3,
    })
  })

  test("actual-only yields a duration", () => {
    expect(parsePacingHint("took 4h")).toEqual({ kind: "duration", minutes: 240 })
    expect(parsePacingHint("spent 90 min on the reading")).toEqual({
      kind: "duration",
      minutes: 90,
    })
  })

  test("a bare duration yields a duration", () => {
    expect(parsePacingHint("~3 hours per pset")).toEqual({
      kind: "duration",
      minutes: 180,
    })
    expect(parsePacingHint("90 min")).toEqual({ kind: "duration", minutes: 90 })
    expect(parsePacingHint("2.5 hrs")).toEqual({ kind: "duration", minutes: 150 })
  })

  test("text with no duration reads as nothing", () => {
    expect(parsePacingHint("that one was rough")).toBeNull()
    expect(parsePacingHint("")).toBeNull()
  })

  test("an absurd ratio is clamped rather than trusted", () => {
    const hint = parsePacingHint("said 1 min, took 20 hours")
    expect(hint).toEqual({ kind: "multiplier", multiplier: 6 })
  })
})

// ---------------------------------------------------------------------------
// Pending changes
// ---------------------------------------------------------------------------

describe("pending changes (core.md rules 3 and 4)", () => {
  test("a deadline touched by a pending change is still emitted, on applied facts", () => {
    const target = deadline({ dueAt: at(THU, 23 * 60 + 59) })
    const result = plan({
      deadlines: [target],
      pendingChanges: [
        change({
          kind: "deadline_moved",
          entity: { table: "deadlines", id: target._id },
          before: { dueAt: target.dueAt },
          after: { dueAt: at("2026-09-18", 23 * 60 + 59) },
        }),
      ],
    })
    const option = only(result.options)

    // Planned on the APPLIED value, not the pending one.
    expect(option.dueAt).toBe(target.dueAt)
    expect(option.dueInDays).toBe(3)
    expect(option.facts.some((f) => f.includes("Thu Sep 17"))).toBe(true)
    expect(option.facts.some((f) => f.includes("Fri Sep 18"))).toBe(false)

    // ...and annotated so the agent can mention it.
    expect(option.pending).toEqual([
      "pending: due date may move to Fri Sep 18 11:59pm",
    ])
  })

  test("a pending change never silently drops the option", () => {
    const target = deadline()
    const result = plan({
      deadlines: [target],
      pendingChanges: [
        change({
          kind: "deadline_removed",
          entity: { table: "deadlines", id: target._id },
        }),
      ],
    })
    const option = only(result.options)
    expect(option.pending).toEqual(["pending: this deadline may be removed"])
  })

  test("pending changes are summarized at the top level for one-word confirmation", () => {
    const target = deadline()
    const result = plan({
      deadlines: [target],
      pendingChanges: [
        change({
          kind: "deadline_moved",
          entity: { table: "deadlines", id: target._id },
          after: { dueAt: at("2026-09-18", 23 * 60 + 59) },
        }),
      ],
    })
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]).toMatchObject({
      kind: "deadline_moved",
      affectsDate: "2026-09-18",
    })
    expect(result.pending[0].summary).toContain("Fri Sep 18")
  })

  test("a source conflict is called out in the summary", () => {
    const result = plan({
      pendingChanges: [
        change({
          kind: "deadline_moved",
          conflict: true,
          after: { dueAt: at(WED, 12 * 60) },
        }),
      ],
    })
    expect(result.pending[0].summary).toContain("sources disagree")
  })

  test("a pending change beyond the horizon is not surfaced", () => {
    const result = plan({
      pendingChanges: [
        change({ kind: "deadline_moved", after: { dueAt: at("2026-11-01", 12 * 60) } }),
      ],
    })
    expect(result.pending).toEqual([])
  })

  test("a non-pending change in the input is ignored", () => {
    const result = plan({
      pendingChanges: [change({ status: "applied" }), change({ status: "rejected" })],
    })
    expect(result.pending).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// remainingWindowsBeforeDue
// ---------------------------------------------------------------------------

describe("remainingWindowsBeforeDue", () => {
  test("counts one window per free day from the planned date to the due date", () => {
    // Mon-Thu inclusive, one window per weekday.
    const option = only(
      plan({ deadlines: [deadline({ dueAt: at(THU, 23 * 60 + 59) })] }).options
    )
    expect(option.remainingWindowsBeforeDue).toBe(4)
    expect(option.facts).toContain("4 free windows before it is due")
  })

  test("names the last window before the due time", () => {
    const option = only(
      plan({ deadlines: [deadline({ dueAt: at(WED, 20 * 60) })] }).options
    )
    expect(option.remainingWindowsBeforeDue).toBe(3)
    expect(option.facts).toContain("last free window before due is Wed Sep 16 9am–8pm")
  })

  test("due today with one window left says so", () => {
    const option = only(
      plan({
        now: at(MON, 18 * 60),
        deadlines: [deadline({ dueAt: at(MON, 21 * 60) })],
      }).options
    )
    expect(option.remainingWindowsBeforeDue).toBe(1)
    expect(option.facts).toContain("last free window before due is Mon Sep 14 6pm–9pm")
  })

  test("class blocks split a day into several countable windows", () => {
    const option = only(
      plan({
        student: student({
          weekly: WEEKDAY_9_TO_21,
          classBlocks: [{ dayOfWeek: 2, startMin: 12 * 60, endMin: 13 * 60 }],
        }),
        deadlines: [deadline({ dueAt: at(TUE, 23 * 60) })],
      }).options
    )
    // Monday: 1 window. Tuesday: split into 2 by the class.
    expect(option.remainingWindowsBeforeDue).toBe(3)
  })

  test("a sliver shorter than the minimum block is not counted as a window", () => {
    const option = only(
      plan({
        student: student({
          weekly: [{ dayOfWeek: 1, startMin: 9 * 60, endMin: 9 * 60 + MIN_BLOCK_MIN - 5 }],
        }),
        deadlines: [deadline({ dueAt: at(MON, 23 * 60) })],
      }).options
    )
    expect(option.remainingWindowsBeforeDue).toBe(0)
  })

  test("undated work counts windows across the horizon instead", () => {
    const option = only(
      plan({ deadlines: [deadline({ dueAt: undefined })], horizonDays: 3 }).options
    )
    // Mon-Thu, all weekdays.
    expect(option.remainingWindowsBeforeDue).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Options, tasks, and facts
// ---------------------------------------------------------------------------

describe("options", () => {
  test("an existing task is used rather than a synthesized candidate", () => {
    const target = deadline()
    const existing = task({ deadlineId: target._id, title: "Finish pset 3 part b" })
    const option = only(plan({ deadlines: [target], tasks: [existing] }).options)
    expect(option.taskId).toBe(existing._id)
    expect(option.deadlineId).toBe(target._id)
    expect(option.title).toBe("Finish pset 3 part b")
  })

  test("a deadline with no task still produces one candidate option", () => {
    const option = only(plan({ deadlines: [deadline()] }).options)
    expect(option.taskId).toBeUndefined()
    expect(option.deadlineId).toBeDefined()
    expect(option.title).toBe("Pset 3")
    expect(option.estEffortMin).toBe(EFFORT_PRIORS_MIN.homework)
  })

  test("a free-standing task is its own option, with no due-date facts", () => {
    const option = only(
      plan({ tasks: [task({ deadlineId: undefined, title: "Email the TA" })] }).options
    )
    expect(option.deadlineId).toBeUndefined()
    expect(option.title).toBe("Email the TA")
    expect(option.dueAt).toBeUndefined()
    expect(option.kind).toBe("other")
  })

  test("a deadline's task is not also emitted as a free-standing option", () => {
    const target = deadline()
    const result = plan({
      deadlines: [target],
      tasks: [task({ deadlineId: target._id })],
    })
    expect(result.options).toHaveLength(1)
  })

  test("facts carry points, category, and the category's weight", () => {
    const option = only(plan({ deadlines: [deadline()] }).options)
    expect(option.pointsPossible).toBe(25)
    expect(option.categoryWeight).toBe(0.3)
    expect(option.facts).toContain("worth 25 pts in Problem Sets (30% of grade)")
  })

  test("a weight stated as a percentage is not double-converted", () => {
    const option = only(
      plan({
        courses: [
          course({
            gradingScheme: { categories: [{ name: "Problem Sets", weight: 30 }] },
          }),
        ],
        deadlines: [deadline()],
      }).options
    )
    expect(option.facts).toContain("worth 25 pts in Problem Sets (30% of grade)")
  })

  test("facts state the due date in the student's timezone with a relative day", () => {
    const option = only(plan({ deadlines: [deadline()] }).options)
    expect(option.facts).toContain("due Thu Sep 17 11:59pm (in 3 days)")
  })

  test("due today and tomorrow read as words, not day counts", () => {
    expect(
      only(plan({ deadlines: [deadline({ dueAt: at(MON, 23 * 60) })] }).options).facts
    ).toContain("due Mon Sep 14 11pm (today)")
    expect(
      only(plan({ deadlines: [deadline({ dueAt: at(TUE, 23 * 60) })] }).options).facts
    ).toContain("due Tue Sep 15 11pm (tomorrow)")
  })

  test("the course is named so the agent never has to guess", () => {
    const option = only(plan({ deadlines: [deadline()] }).options)
    expect(option.courseName).toBe("Compsci 201")
    expect(option.facts).toContain("Compsci 201 (CS201)")
  })

  test("no option carries a score, rank, or priority", () => {
    const option = only(plan({ deadlines: [deadline()] }).options)
    for (const key of ["score", "priority", "importance", "rank", "urgency"]) {
      expect(option).not.toHaveProperty(key)
    }
  })
})

// ---------------------------------------------------------------------------
// Signals digest
// ---------------------------------------------------------------------------

describe("signals digest", () => {
  test("groups signal text by kind, newest first, with no interpretation", () => {
    const result = plan({
      signals: [
        signal({ kind: "availability", text: "no mornings this week", observedAt: 300 }),
        signal({ kind: "pacing", text: "said 2h, took 4h", observedAt: 200 }),
        signal({ kind: "life_event", text: "flying home Friday", observedAt: 100 }),
      ],
    })
    expect(result.signalsDigest).toEqual({
      availability: ["no mornings this week"],
      pacing: ["said 2h, took 4h"],
      preference: [],
      difficulty: [],
      life_event: ["flying home Friday"],
      other: [],
    })
  })

  test("caps at the most recent 20 signals", () => {
    const signals = Array.from({ length: 30 }, (_, i) =>
      signal({ kind: "other", text: `note ${i}`, observedAt: i })
    )
    const digest = plan({ signals }).signalsDigest
    expect(digest.other).toHaveLength(20)
    expect(digest.other[0]).toBe("note 29")
  })
})

// ---------------------------------------------------------------------------
// Whole-day sanity
// ---------------------------------------------------------------------------

describe("a realistic day", () => {
  test("holds every hard guarantee at once", () => {
    const classBlocks = [
      { dayOfWeek: 1, startMin: 10 * 60, endMin: 11 * 60 + 15, label: "CS201" },
      { dayOfWeek: 1, startMin: 14 * 60, endMin: 15 * 60 + 15, label: "MATH212" },
    ]
    const dueToday = deadline({
      title: "Reading response",
      kind: "reading",
      dueAt: at(MON, 17 * 60),
    })
    const dueThursday = deadline({ title: "Pset 3", dueAt: at(THU, 23 * 60 + 59) })
    const submitted = deadline({ title: "Pset 2", submissionStatus: "submitted" })
    const removed = deadline({ title: "Cancelled quiz", status: "removed" })

    const result = plan({
      student: student({ weekly: WEEKDAY_9_TO_21, classBlocks }),
      deadlines: [dueToday, dueThursday, submitted, removed],
      tasks: [task({ deadlineId: dueThursday._id, title: "Pset 3" })],
      pendingChanges: [
        change({
          kind: "deadline_moved",
          entity: { table: "deadlines", id: dueThursday._id },
          after: { dueAt: at("2026-09-18", 23 * 60 + 59) },
        }),
      ],
      signals: [signal({ kind: "preference", text: "prefers evenings" })],
    })

    const titles = result.options.map((o) => o.title).sort()
    expect(titles).toEqual(["Pset 3", "Reading response"])

    for (const option of result.options) {
      for (const fit of option.fits) {
        for (const block of classBlocks) {
          expect(fit.startMin < block.endMin && fit.endMin > block.startMin).toBe(false)
        }
        if (option.dueAt !== undefined && option.dueInDays === 0) {
          expect(fit.endMin).toBeLessThanOrEqual(17 * 60)
        }
      }
    }

    const pset = result.options.find((o) => o.title === "Pset 3")!
    expect(pset.pending?.[0]).toContain("Fri Sep 18")
    expect(pset.dueAt).toBe(dueThursday.dueAt)
    expect(result.signalsDigest.preference).toEqual(["prefers evenings"])
  })
})
