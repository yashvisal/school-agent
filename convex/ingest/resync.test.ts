import { describe, expect, test } from "vitest"

import { api } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import { CLERK_ID, OTHER_CLERK_ID, setupTest } from "../test.setup"

/**
 * `sources.resync` — the Face "Re-sync now" button.
 *
 * What matters here is not the poll (each adapter has its own tests) but the
 * boundary: whose source it is, whether it is enabled, and that the tap
 * actually schedules the same work the cron would have done.
 */

type Seed = { studentId: Id<"students">; otherStudentId: Id<"students"> }

const seed = async (t: ReturnType<typeof setupTest>): Promise<Seed> =>
  await t.run(async (ctx) => {
    const base = {
      timezone: "America/New_York",
      classBlocks: [],
      availability: { weekly: [], exceptions: [] },
      status: "active" as const,
    }
    const studentId = await ctx.db.insert("students", { clerkId: CLERK_ID, ...base })
    const otherStudentId = await ctx.db.insert("students", {
      clerkId: OTHER_CLERK_ID,
      ...base,
    })
    return { studentId, otherStudentId }
  })

const addSource = (
  t: ReturnType<typeof setupTest>,
  studentId: Id<"students">,
  kind: "canvas" | "ical" | "site" | "syllabus" | "schedule" | "calendar",
  config: Record<string, unknown> = {},
  enabled = true
) =>
  t.run(async (ctx) =>
    ctx.db.insert("sources", {
      studentId,
      kind,
      config,
      enabled,
      health: { status: "ok", at: Date.now() },
    })
  )

/** Every job the mutation queued, by function path. */
const scheduled = (t: ReturnType<typeof setupTest>) =>
  t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").take(20)
    return jobs.map((job) => job.name)
  })

describe("sources.resync ownership", () => {
  test("a stranger's source is refused, and nothing is scheduled", async () => {
    const t = setupTest()
    const { otherStudentId } = await seed(t)
    const sourceId = await addSource(t, otherStudentId, "canvas", {
      baseUrl: "https://canvas.example.edu",
      token: "t",
    })

    await expect(
      t.withIdentity({ subject: CLERK_ID }).mutation(api.ingest.sources.resync, {
        sourceId,
      })
    ).rejects.toThrow(/403/)
    expect(await scheduled(t)).toHaveLength(0)
  })

  test("signed out is refused", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "ical", { url: "https://x.edu/u.ics" })

    await expect(
      t.mutation(api.ingest.sources.resync, { sourceId })
    ).rejects.toThrow(/401/)
  })

  test("an unknown source id is a 404", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "ical", { url: "https://x.edu/u.ics" })
    await t.run(async (ctx) => ctx.db.delete("sources", sourceId))

    await expect(
      t.withIdentity({ subject: CLERK_ID }).mutation(api.ingest.sources.resync, {
        sourceId,
      })
    ).rejects.toThrow(/404/)
  })
})

describe("sources.resync dispatch", () => {
  test("a poll source schedules its adapter's poll", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "canvas", {
      baseUrl: "https://canvas.example.edu",
      token: "t",
    })

    const result = await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.ingest.sources.resync, { sourceId })

    expect(result).toEqual({ scheduled: true })
    expect(await scheduled(t)).toEqual(["ingest/canvas:poll"])
  })

  test("an ical source schedules the ical poll", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "ical", { url: "https://x.edu/u.ics" })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.ingest.sources.resync, { sourceId })

    expect(await scheduled(t)).toEqual(["ingest/ical:poll"])
  })

  test("an upload source re-extracts from its stored document", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["# syllabus"], { type: "text/markdown" }))
    )
    const sourceId = await addSource(t, studentId, "syllabus", {
      identity: "syllabus:unassigned",
      storageId,
    })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.ingest.sources.resync, { sourceId })

    expect(await scheduled(t)).toEqual(["ingest/syllabus:run"])
  })

  test("an upload with no stored document is a 400, not a silent no-op", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "schedule", { identity: "schedule" })

    await expect(
      t.withIdentity({ subject: CLERK_ID }).mutation(api.ingest.sources.resync, {
        sourceId,
      })
    ).rejects.toThrow(/400/)
    expect(await scheduled(t)).toHaveLength(0)
  })

  test("a kind with no adapter yet is refused rather than silently ignored", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "calendar", { url: "https://x/c.ics" })

    await expect(
      t.withIdentity({ subject: CLERK_ID }).mutation(api.ingest.sources.resync, {
        sourceId,
      })
    ).rejects.toThrow(/400/)
  })

  test("a disabled source is refused", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(
      t,
      studentId,
      "ical",
      { url: "https://x.edu/u.ics" },
      false
    )

    await expect(
      t.withIdentity({ subject: CLERK_ID }).mutation(api.ingest.sources.resync, {
        sourceId,
      })
    ).rejects.toThrow(/400/)
    expect(await scheduled(t)).toHaveLength(0)
  })
})

describe("sources.resync health", () => {
  test("health flips to unknown so the card can show progress", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "site", { url: "https://cs.edu/201" })

    await t
      .withIdentity({ subject: CLERK_ID })
      .mutation(api.ingest.sources.resync, { sourceId })

    const source = await t.run(async (ctx) => ctx.db.get("sources", sourceId))
    expect(source?.health.status).toBe("unknown")
    expect(source?.health.message).toBe("re-sync requested")
  })
})
