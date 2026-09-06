import type { Scheduler } from "convex/server"

import { internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"

/**
 * Which adapter runs a source — declared once, used by the cron sweep
 * (`ingest/pollAll.ts`) and by the student's manual re-sync
 * (`ingest/sources.resync`).
 *
 * Two callers picking their own adapter per kind is how a source ends up
 * polled one way on a schedule and another way on demand; the selection lives
 * here so there is only one answer.
 */

/** Sources with something to re-fetch. Uploads are events, not feeds. */
export const POLLABLE_KINDS = ["canvas", "ical", "site"] as const
export type PollableKind = (typeof POLLABLE_KINDS)[number]

/** Uploads: nothing to fetch, but the stored document can be re-extracted. */
export const UPLOAD_KINDS = ["syllabus", "schedule"] as const
export type UploadKind = (typeof UPLOAD_KINDS)[number]

export const isPollableKind = (kind: string): kind is PollableKind =>
  (POLLABLE_KINDS as readonly string[]).includes(kind)

export const isUploadKind = (kind: string): kind is UploadKind =>
  (UPLOAD_KINDS as readonly string[]).includes(kind)

/**
 * Schedules the poll for one source, now. Takes the bare `scheduler` because
 * both a mutation (re-sync) and an action (the sweep) call it, and that is the
 * only thing it needs from either context.
 */
export async function schedulePoll(
  scheduler: Scheduler,
  kind: PollableKind,
  sourceId: Id<"sources">
): Promise<void> {
  switch (kind) {
    case "canvas":
      await scheduler.runAfter(0, internal.ingest.canvas.poll, { sourceId })
      return
    case "ical":
      await scheduler.runAfter(0, internal.ingest.ical.poll, { sourceId })
      return
    case "site":
      await scheduler.runAfter(0, internal.ingest.site.run, { sourceId })
      return
  }
}

/**
 * Re-runs the extraction for an uploaded document, from whatever the source
 * config already points at (`storageId`, and the `courseId`/`filename` the
 * adapters read back off the same config).
 *
 * `force` is not optional here: an unchanged document hashes to the snapshot
 * already stored, and the ingest mutations short-circuit on that. Without it a
 * re-sync of an upload is a guaranteed no-op — the one thing the button must
 * never be. Re-proposing is safe: the document pipeline dedupes extracted
 * deadlines against the rows they already produced.
 */
export async function scheduleReextract(
  scheduler: Scheduler,
  kind: UploadKind,
  sourceId: Id<"sources">,
  storageId: Id<"_storage">
): Promise<void> {
  if (kind === "syllabus") {
    await scheduler.runAfter(0, internal.ingest.syllabus.run, {
      sourceId,
      storageId,
      force: true,
    })
    return
  }
  await scheduler.runAfter(0, internal.ingest.schedule.run, {
    sourceId,
    storageId,
    force: true,
  })
}
