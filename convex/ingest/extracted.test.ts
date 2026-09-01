import { describe, expect, test } from "vitest"

import cmuExpected from "../../fixtures/extraction/sites/cmu-15-213-schedule-fall-2026/expected.json"
import scheduleExpected from "../../fixtures/extraction/schedules/weekly-grid-text/expected.json"
import stanfordExpected from "../../fixtures/extraction/syllabi/stanford-cs103-spring-2025/expected.json"
import { api, internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import { localDateToMs } from "../lib/time"
import { setupTest } from "../test.setup"

/**
 * The syllabus / site / schedule pipeline, end to end, with the LLM step
 * replaced by the checked-in `expected.json` fixtures.
 *
 * That substitution is the point: the model's output is measured by `pnpm eval`
 * (live, costs money, needs a key), and everything downstream of it — dedupe,
 * conflict handling, the two-tier rule, tenancy — is measured here, in CI, for
 * free and deterministically. The fixtures are the seam, so the two layers
 * agree by construction about what the model is supposed to produce.
 */

const LA = "America/Los_Angeles"
const NY = "America/New_York"

type Seed = {
  studentId: Id<"students">
  courseId: Id<"courses">
  sourceId: Id<"sources">
  clerkId: string
}

const seed = async (
  t: ReturnType<typeof setupTest>,
  options: {
    kind: "syllabus" | "site" | "schedule"
    timezone?: string
    semester?: { start: string; end: string }
    courseName?: string
    courseCode?: string
    withCourse?: boolean
  }
): Promise<Seed> =>
  await t.run(async (ctx) => {
    const clerkId = `user_${options.kind}_${Math.random().toString(36).slice(2)}`
    const studentId = await ctx.db.insert("students", {
      clerkId,
      timezone: options.timezone ?? NY,
      classBlocks: [],
      availability: { weekly: [], exceptions: [] },
      status: "active",
      ...(options.semester
        ? { semesterStart: options.semester.start, semesterEnd: options.semester.end }
        : {}),
    })
    const courseId =
      options.withCourse === false
        ? (undefined as unknown as Id<"courses">)
        : await ctx.db.insert("courses", {
            studentId,
            name: options.courseName ?? "Mathematical Foundations of Computing",
            ...(options.courseCode ? { code: options.courseCode } : {}),
            sourceRefs: {},
            status: "active",
            provenance: { source: "manual", sourceRef: "test", confidence: 1 },
          })
    const sourceId = await ctx.db.insert("sources", {
      studentId,
      kind: options.kind,
      config: {},
      enabled: true,
      health: { status: "unknown", at: Date.now() },
    })
    return { studentId, courseId, sourceId, clerkId }
  })

const ingestSyllabus = (
  t: ReturnType<typeof setupTest>,
  s: Seed,
  extra: Record<string, unknown> = {}
) =>
  t.mutation(internal.ingest.extracted.ingestDocument, {
    sourceId: s.sourceId,
    origin: "syllabus",
    payload: { kind: "syllabus", fetchedAt: 1_700_000_000_000, markdown: "# CS103" },
    contentHash: "hash-cs103",
    extraction: stanfordExpected,
    courseId: s.courseId,
    ...extra,
  })

const changesOf = (t: ReturnType<typeof setupTest>, studentId: Id<"students">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("changes")
      .withIndex("by_student_createdAt", (q) => q.eq("studentId", studentId))
      .take(200)
  )

describe("syllabus pipeline", () => {
  test("every proposal lands needs_approval / pending — nothing an LLM read applies", async () => {
    const t = setupTest()
    const s = await seed(t, { kind: "syllabus", timezone: LA, semester: { start: "2025-03-31", end: "2025-06-11" } })
    const result = await ingestSyllabus(t, s)

    expect(result.created).toBe(true)
    // 4 deadlines + 1 grading-scheme course_updated.
    expect(result.proposed).toBe(5)
    expect(result.pending).toBe(5)
    expect(result.applied).toBe(0)

    const changes = await changesOf(t, s.studentId)
    expect(changes).toHaveLength(5)
    for (const change of changes) {
      expect(change.tier).toBe("needs_approval")
      expect(change.status).toBe("pending")
      expect(change.origin).toBe("syllabus")
      expect(change.snapshotIds).toHaveLength(1)
    }

    // Pending means pending: not one row reached the student's state.
    const deadlines = await t.run(async (ctx) => ctx.db.query("deadlines").take(10))
    expect(deadlines).toEqual([])
  })

  test("the grading scheme is proposed onto the EXISTING course, and only the scheme", async () => {
    const t = setupTest()
    const s = await seed(t, {
      kind: "syllabus",
      timezone: LA,
      semester: { start: "2025-03-31", end: "2025-06-11" },
      courseName: "Discrete Math",
    })
    await ingestSyllabus(t, s)

    const change = (await changesOf(t, s.studentId)).find((c) => c.kind === "course_updated")
    expect(change).toBeDefined()
    expect(change!.entity).toEqual({ table: "courses", id: s.courseId })
    // Merge precedence: syllabus outranks Canvas for the grading scheme and
    // NOTHING else. A name or a provenance stamp here would relabel the course.
    expect(Object.keys(change!.after as object)).toEqual(["gradingScheme"])

    // The course name is untouched while the change is pending, and would still
    // be untouched after approval.
    const course = await t.run(async (ctx) => ctx.db.get("courses", s.courseId))
    expect(course?.name).toBe("Discrete Math")
  })

  test("provenance carries the snapshot and the model's own confidence", async () => {
    const t = setupTest()
    const s = await seed(t, { kind: "syllabus", timezone: LA, semester: { start: "2025-03-31", end: "2025-06-11" } })
    const result = await ingestSyllabus(t, s)

    const added = (await changesOf(t, s.studentId)).find((c) => c.kind === "deadline_added")
    const provenance = (added!.after as { provenance: Record<string, unknown> }).provenance
    expect(provenance.source).toBe("syllabus")
    expect(provenance.snapshotId).toBe(result.snapshotId)
    expect(provenance.confidence).toBe(1)
  })

  test("an unchanged re-upload is a no-op, and `force` re-runs it", async () => {
    const t = setupTest()
    const s = await seed(t, { kind: "syllabus", timezone: LA, semester: { start: "2025-03-31", end: "2025-06-11" } })
    await ingestSyllabus(t, s)

    const again = await ingestSyllabus(t, s)
    expect(again.created).toBe(false)
    expect(again.proposed).toBe(0)
    expect(await changesOf(t, s.studentId)).toHaveLength(5)

    const forced = await ingestSyllabus(t, s, { force: true })
    expect(forced.proposed).toBeGreaterThan(0)
  })
})

describe("dedupe and conflict against existing deadlines", () => {
  const withExisting = async (title: string, dueAt?: number) => {
    const t = setupTest()
    const s = await seed(t, { kind: "syllabus", timezone: LA, semester: { start: "2025-03-31", end: "2025-06-11" } })
    await t.run(async (ctx) => {
      await ctx.db.insert("deadlines", {
        studentId: s.studentId,
        courseId: s.courseId,
        title,
        kind: "exam",
        ...(dueAt !== undefined ? { dueAt } : {}),
        submissionStatus: "unsubmitted",
        externalIds: { canvasAssignmentId: "5103" },
        provenance: { source: "canvas", sourceRef: "5103", confidence: 1 },
        status: "active",
      })
    })
    return { t, s }
  }

  test("same title, same day → nothing proposed (Canvas already owns it)", async () => {
    // The syllabus restating a date Canvas already has is not news: syllabus
    // never outranks Canvas on dates, so silence is the correct output.
    const { t, s } = await withExisting("Midterm 1", localDateToMs("2025-04-29", 15 * 60, LA))
    const result = await ingestSyllabus(t, s)
    expect(result.deduped).toBe(1)
    expect(result.conflicts).toBe(0)
    const titles = (await changesOf(t, s.studentId))
      .filter((c) => c.kind === "deadline_added")
      .map((c) => (c.after as { title: string }).title)
    expect(titles).not.toContain("Midterm 1")
  })

  test("same title, different day → a `conflict` deadline_moved, held for approval", async () => {
    const { t, s } = await withExisting("Midterm 1", localDateToMs("2025-05-06", 18 * 60, LA))
    const result = await ingestSyllabus(t, s)
    expect(result.conflicts).toBe(1)

    const moved = (await changesOf(t, s.studentId)).find((c) => c.kind === "deadline_moved")
    expect(moved).toBeDefined()
    expect(moved!.conflict).toBe(true)
    expect(moved!.status).toBe("pending")
    expect(moved!.reason).toMatch(/Confirm which is right/)
    // The stored row is untouched until the student decides.
    const row = await t.run(async (ctx) =>
      (await ctx.db.query("deadlines").take(1))[0]
    )
    expect(row.dueAt).toBe(localDateToMs("2025-05-06", 18 * 60, LA))
  })

  test("the row has no date and the syllabus does → also a conflict, never a silent fill", async () => {
    const { t, s } = await withExisting("Midterm 1")
    const result = await ingestSyllabus(t, s)
    expect(result.conflicts).toBe(1)
    const moved = (await changesOf(t, s.studentId)).find((c) => c.kind === "deadline_moved")
    expect(moved!.reason).toMatch(/does not have/)
  })

  test("a same-titled deadline in ANOTHER course never suppresses this one", async () => {
    // "Midterm 1" exists in half a student's courses; matching across them would
    // silently drop real work.
    const t = setupTest()
    const s = await seed(t, { kind: "syllabus", timezone: LA, semester: { start: "2025-03-31", end: "2025-06-11" } })
    await t.run(async (ctx) => {
      const other = await ctx.db.insert("courses", {
        studentId: s.studentId,
        name: "Other course",
        sourceRefs: {},
        status: "active",
        provenance: { source: "manual", sourceRef: "test", confidence: 1 },
      })
      await ctx.db.insert("deadlines", {
        studentId: s.studentId,
        courseId: other,
        title: "Midterm 1",
        kind: "exam",
        dueAt: localDateToMs("2025-04-29", 18 * 60, LA),
        submissionStatus: "unsubmitted",
        externalIds: {},
        provenance: { source: "canvas", sourceRef: "x", confidence: 1 },
        status: "active",
      })
    })
    const result = await ingestSyllabus(t, s)
    expect(result.deduped).toBe(0)
    expect(result.proposed).toBe(5)
  })
})

describe("course resolution", () => {
  test("no course matches → the course is proposed and the deadlines are DEFERRED, not dropped", async () => {
    const t = setupTest()
    const s = await seed(t, {
      kind: "syllabus",
      timezone: LA,
      semester: { start: "2025-03-31", end: "2025-06-11" },
      withCourse: false,
    })
    const result = await t.mutation(internal.ingest.extracted.ingestDocument, {
      sourceId: s.sourceId,
      origin: "syllabus",
      payload: { kind: "syllabus", fetchedAt: 1, markdown: "# CS103" },
      contentHash: "hash-nocourse",
      extraction: stanfordExpected,
    })

    expect(result.courseId).toBeUndefined()
    expect(result.deferred).toBe(4)
    const changes = await changesOf(t, s.studentId)
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe("course_added")
    expect(changes[0].status).toBe("pending")
    expect(changes[0].reason).toMatch(/re-upload/)
  })

  test("the course code resolves the document with no explicit courseId", async () => {
    const t = setupTest()
    const s = await seed(t, {
      kind: "syllabus",
      timezone: LA,
      semester: { start: "2025-03-31", end: "2025-06-11" },
      courseName: "Something else entirely",
      courseCode: "cs 103",
    })
    const result = await t.mutation(internal.ingest.extracted.ingestDocument, {
      sourceId: s.sourceId,
      origin: "syllabus",
      payload: { kind: "syllabus", fetchedAt: 1, markdown: "# CS103" },
      contentHash: "hash-bycode",
      extraction: stanfordExpected,
    })
    expect(result.courseId).toBe(s.courseId)
    expect(result.deferred).toBe(0)
  })

  test("a course belonging to ANOTHER student is refused, not silently used", async () => {
    const t = setupTest()
    const mine = await seed(t, { kind: "syllabus", timezone: LA, semester: { start: "2025-03-31", end: "2025-06-11" } })
    const theirs = await seed(t, { kind: "syllabus" })
    await expect(
      t.mutation(internal.ingest.extracted.ingestDocument, {
        sourceId: mine.sourceId,
        origin: "syllabus",
        payload: { kind: "syllabus", fetchedAt: 1, markdown: "x" },
        contentHash: "hash-tenancy",
        extraction: stanfordExpected,
        courseId: theirs.courseId,
      })
    ).rejects.toThrow(/403/)
  })
})

describe("site pipeline", () => {
  test("the CMU schedule fixture proposes all eleven deliverables, pending", async () => {
    const t = setupTest()
    const s = await seed(t, {
      kind: "site",
      timezone: NY,
      semester: { start: "2026-08-24", end: "2026-12-11" },
      courseName: "Introduction to Computer Systems",
    })
    const result = await t.mutation(internal.ingest.extracted.ingestDocument, {
      sourceId: s.sourceId,
      origin: "site",
      payload: {
        kind: "site",
        url: "https://www.cs.cmu.edu/~213/schedule.html",
        fetchedAt: 1,
        markdown: "# schedule",
      },
      contentHash: "hash-cmu",
      extraction: cmuExpected,
      courseId: s.courseId,
    })

    // No grading scheme on the schedule page, so 11 deadlines and nothing else.
    expect(result.proposed).toBe(11)
    expect(result.pending).toBe(11)
    expect(result.dropped).toEqual([])

    const changes = await changesOf(t, s.studentId)
    expect(changes.every((c) => c.origin === "site" && c.tier === "needs_approval")).toBe(true)
    const l0 = changes.find((c) => (c.after as { title?: string }).title?.startsWith("L0"))
    expect((l0!.after as { dueAt: number }).dueAt).toBe(
      localDateToMs("2026-09-01", 23 * 60 + 59, NY)
    )
    // Every proposed deadline is filed under the resolved course.
    expect(changes.every((c) => c.courseId === s.courseId)).toBe(true)
  })
})

describe("schedule pipeline", () => {
  const ingest = async (extraction: unknown, hash = "hash-grid") => {
    const t = setupTest()
    const s = await seed(t, { kind: "schedule", timezone: NY })
    const result = await t.mutation(internal.ingest.extracted.ingestSchedule, {
      sourceId: s.sourceId,
      payload: { kind: "schedule", fetchedAt: 1, markdown: "# grid" },
      contentHash: hash,
      extraction,
    })
    return { t, s, result }
  }

  test("one upload becomes ONE pending availability_updated carrying the whole grid", async () => {
    const { t, s, result } = await ingest(scheduleExpected)
    expect(result.blocks).toBe(9)

    const changes = await changesOf(t, s.studentId)
    expect(changes).toHaveLength(1)
    const change = changes[0]
    expect(change.kind).toBe("availability_updated")
    expect(change.origin).toBe("schedule")
    expect(change.tier).toBe("needs_approval")
    expect(change.status).toBe("pending")
    expect(change.entity).toEqual({ table: "students", id: s.studentId })
    expect((change.after as { classBlocks: unknown[] }).classBlocks).toHaveLength(9)
    expect(change.reason).toMatch(/confirm the weekly grid/)

    // Pending: the planner's hard constraints are unchanged until approval.
    const student = await t.run(async (ctx) => ctx.db.get("students", s.studentId))
    expect(student?.classBlocks).toEqual([])
  })

  test("approving it writes the grid onto the student — the planner's hard blocks", async () => {
    const { t, s, result } = await ingest(scheduleExpected)
    await t
      .withIdentity({ subject: s.clerkId })
      .mutation(api.changes.approve, { changeId: result.changeId!, via: "web" })

    const student = await t.run(async (ctx) => ctx.db.get("students", s.studentId))
    expect(student?.classBlocks).toHaveLength(9)
    expect(student?.classBlocks[0]).toMatchObject({ dayOfWeek: 1, startMin: 600, endMin: 650 })
  })

  test("an upload that yields NO blocks proposes nothing — an empty grid would wipe the real one", async () => {
    const { t, s, result } = await ingest({ blocks: [] }, "hash-empty")
    expect(result.blocks).toBe(0)
    expect(result.changeId).toBeUndefined()
    expect(await changesOf(t, s.studentId)).toEqual([])
  })

  test("unreadable blocks are reported in the change, not silently swallowed", async () => {
    const { t, s } = await ingest(
      {
        blocks: [
          { dayOfWeek: 1, startTime: "09:00", endTime: "10:00", label: "Good", confidence: 0.5, sourceText: "a" },
          { dayOfWeek: 2, startTime: "09:00", endTime: "09:00", label: "Bad", confidence: 1, sourceText: "b" },
        ],
      },
      "hash-partial"
    )
    const change = (await changesOf(t, s.studentId))[0]
    expect(change.reason).toMatch(/1 block\(s\) were unreadable/)
    expect(change.reason).toMatch(/Lowest block confidence was 0\.50/)
  })
})

describe("usage logging", () => {
  test("`usage.log` writes an ingestion row with the token counts", async () => {
    const t = setupTest()
    const s = await seed(t, { kind: "syllabus" })
    await t.mutation(internal.usage.log, {
      studentId: s.studentId,
      surface: "ingestion",
      model: "anthropic/claude-haiku-4-5",
      promptTokens: 2918,
      completionTokens: 513,
      at: 1_700_000_000_000,
    })
    const rows = await t.run(async (ctx) => ctx.db.query("usage").take(10))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      surface: "ingestion",
      model: "anthropic/claude-haiku-4-5",
      promptTokens: 2918,
      completionTokens: 513,
    })
  })

  test("a provider that reports nothing still produces a row, with zeros", async () => {
    // A missing row looks like the call never happened; a zeroed row is
    // auditable ("this call happened, the provider said nothing").
    const t = setupTest()
    await t.mutation(internal.usage.log, {
      surface: "ingestion",
      model: "anthropic/claude-haiku-4-5",
      promptTokens: Number.NaN,
      completionTokens: -5,
    })
    const rows = await t.run(async (ctx) => ctx.db.query("usage").take(10))
    expect(rows[0]).toMatchObject({ promptTokens: 0, completionTokens: 0 })
  })
})
