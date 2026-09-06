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

describe("sources.resync cooldown", () => {
  /**
   * Backdates the last request so the cooldown can be crossed without waiting.
   * The "re-sync requested" health is written together with the request stamp,
   * so it is backdated together — otherwise the in-flight guard would read a
   * fresh marker on a request that is supposedly minutes old.
   */
  const requestedAgo = (
    t: ReturnType<typeof setupTest>,
    sourceId: Id<"sources">,
    ms: number
  ) =>
    t.run(async (ctx) => {
      const at = Date.now() - ms
      const source = await ctx.db.get("sources", sourceId)
      const health =
        source?.health.message === "re-sync requested"
          ? { ...source.health, at }
          : source?.health
      await ctx.db.patch("sources", sourceId, {
        lastResyncRequestedAt: at,
        ...(health ? { health } : {}),
      })
    })

  test("a second tap inside the window is a 429 and schedules nothing more", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "ical", { url: "https://x.edu/u.ics" })
    const as = t.withIdentity({ subject: CLERK_ID })

    await as.mutation(api.ingest.sources.resync, { sourceId })
    expect(await scheduled(t)).toHaveLength(1)

    await expect(
      as.mutation(api.ingest.sources.resync, { sourceId })
    ).rejects.toThrow(/429: re-sync was requested \d+s ago; try again in \d+s/)
    expect(await scheduled(t)).toHaveLength(1)
  })

  test("a poll source is free again after a minute; an upload is not", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["# syllabus"], { type: "text/markdown" }))
    )
    const feed = await addSource(t, studentId, "ical", { url: "https://x.edu/u.ics" })
    const upload = await addSource(t, studentId, "syllabus", {
      identity: "syllabus:unassigned",
      storageId,
    })
    const as = t.withIdentity({ subject: CLERK_ID })

    await as.mutation(api.ingest.sources.resync, { sourceId: feed })
    await as.mutation(api.ingest.sources.resync, { sourceId: upload })

    // 90s later: the feed's 60s window has passed, the upload's 5min has not —
    // an upload re-sync is a model call every time, so it is held longer.
    await requestedAgo(t, feed, 90_000)
    await requestedAgo(t, upload, 90_000)

    await as.mutation(api.ingest.sources.resync, { sourceId: feed })
    await expect(
      as.mutation(api.ingest.sources.resync, { sourceId: upload })
    ).rejects.toThrow(/429/)

    // Six minutes on, and the extraction has finished — the adapter replaced
    // the health this mutation wrote — so the upload is free again.
    await requestedAgo(t, upload, 6 * 60_000)
    await t.run(async (ctx) =>
      ctx.db.patch("sources", upload, { health: { status: "ok", at: Date.now() } })
    )
    expect(await as.mutation(api.ingest.sources.resync, { sourceId: upload })).toEqual({
      scheduled: true,
    })
  })

  test("the cooldown is per source, not per student", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const a = await addSource(t, studentId, "ical", { url: "https://x.edu/a.ics" })
    const b = await addSource(t, studentId, "ical", { url: "https://x.edu/b.ics" })
    const as = t.withIdentity({ subject: CLERK_ID })

    await as.mutation(api.ingest.sources.resync, { sourceId: a })
    expect(await as.mutation(api.ingest.sources.resync, { sourceId: b })).toEqual({
      scheduled: true,
    })
  })

  test("a refused request does not burn the cooldown", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    // No stored document: the mutation throws AFTER stamping, so the whole
    // transaction — stamp included — must roll back.
    const sourceId = await addSource(t, studentId, "schedule", { identity: "schedule" })
    const as = t.withIdentity({ subject: CLERK_ID })

    await expect(
      as.mutation(api.ingest.sources.resync, { sourceId })
    ).rejects.toThrow(/400/)

    const source = await t.run(async (ctx) => ctx.db.get("sources", sourceId))
    expect(source?.lastResyncRequestedAt).toBeUndefined()
    // Health was not left saying "re-sync requested" for a request that failed.
    expect(source?.health.status).toBe("ok")
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

describe("sources.resync in flight", () => {
  /** An upload source whose stored document is real enough to re-extract. */
  const uploadSource = async (t: ReturnType<typeof setupTest>, studentId: Id<"students">) => {
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["# syllabus"], { type: "text/markdown" }))
    )
    return await addSource(t, studentId, "syllabus", { identity: "syllabus:unassigned", storageId })
  }

  test("an upload extraction still running past the cooldown is not joined by a second one", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await uploadSource(t, studentId)
    const as = t.withIdentity({ subject: CLERK_ID })

    // Requested well past the five-minute cooldown, but the adapter never
    // replaced the health this mutation wrote — the extraction is still going.
    const requestedAt = Date.now() - 6 * 60_000
    await t.run(async (ctx) =>
      ctx.db.patch("sources", sourceId, {
        lastResyncRequestedAt: requestedAt,
        health: { status: "unknown", message: "re-sync requested", at: requestedAt },
      })
    )

    await expect(as.mutation(api.ingest.sources.resync, { sourceId })).rejects.toThrow(
      /409: re-sync is still running/
    )
    expect(await scheduled(t)).toHaveLength(0)
  })

  test("an abandoned in-flight marker does not wedge the button", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await uploadSource(t, studentId)
    const as = t.withIdentity({ subject: CLERK_ID })

    const requestedAt = Date.now() - 16 * 60_000
    await t.run(async (ctx) =>
      ctx.db.patch("sources", sourceId, {
        lastResyncRequestedAt: requestedAt,
        health: { status: "unknown", message: "re-sync requested", at: requestedAt },
      })
    )

    await expect(as.mutation(api.ingest.sources.resync, { sourceId })).resolves.toEqual({
      scheduled: true,
    })
    expect(await scheduled(t)).toHaveLength(1)
  })

  test("a feed poll still marked running is only ever gated by its own cooldown", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const sourceId = await addSource(t, studentId, "ical", { url: "https://x.edu/u.ics" })
    const as = t.withIdentity({ subject: CLERK_ID })

    const requestedAt = Date.now() - 90_000
    await t.run(async (ctx) =>
      ctx.db.patch("sources", sourceId, {
        lastResyncRequestedAt: requestedAt,
        health: { status: "unknown", message: "re-sync requested", at: requestedAt },
      })
    )

    await expect(as.mutation(api.ingest.sources.resync, { sourceId })).resolves.toEqual({
      scheduled: true,
    })
  })
})

describe("sources.resync stored document", () => {
  test("an upload whose blob is gone is refused, and the cooldown is not burned", async () => {
    const t = setupTest()
    const { studentId } = await seed(t)
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["# syllabus"], { type: "text/markdown" }))
    )
    const sourceId = await addSource(t, studentId, "syllabus", {
      identity: "syllabus:unassigned",
      storageId,
    })
    await t.run(async (ctx) => ctx.storage.delete(storageId))
    const as = t.withIdentity({ subject: CLERK_ID })

    await expect(as.mutation(api.ingest.sources.resync, { sourceId })).rejects.toThrow(
      "400: this upload's stored document is missing from storage"
    )
    expect(await scheduled(t)).toHaveLength(0)
    const source = await t.run(async (ctx) => ctx.db.get("sources", sourceId))
    expect(source?.lastResyncRequestedAt).toBeUndefined()
  })
})
