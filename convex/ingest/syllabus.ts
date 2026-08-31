"use node"

import { v } from "convex/values"

import { internal } from "../_generated/api"
import type { Id } from "../_generated/dataModel"
import { internalAction } from "../_generated/server"
import type { ActionCtx } from "../_generated/server"
import { hashSnapshotPayload } from "../lib/diff"
import type { DocToMarkdown } from "../lib/extraction/anydoc"
import { anydocToMarkdown } from "../lib/extraction/anydoc"
import { documentPrompt, syllabusSystemPrompt } from "../lib/extraction/prompts"
import { extractAndLog } from "../lib/extraction/run"
import type { SyllabusExtraction } from "../lib/extraction/schemas"
import { syllabusExtractionSchema } from "../lib/extraction/schemas"
import type { DocumentIngestResult } from "./extracted"

/**
 * The syllabus adapter (core.md "Adapters" #3): AnyDoc → markdown → LLM
 * extraction into a zod schema → grading scheme, exam dates, dated readings and
 * psets → deadlines, every item carrying confidence and a page ref, all of it
 * `needs_approval` at onboarding.
 *
 * `"use node"` because AnyDoc is a native NAPI binding and the AI SDK expects
 * Node. Everything that touches the database lives in `ingest/extracted.ts`,
 * which a `"use node"` module cannot export.
 *
 * Order of operations matters and is deliberate:
 *   1. document → markdown
 *   2. **snapshot the markdown** (hash-deduped) — before the model is called, so
 *      an unchanged re-upload costs nothing and the change is always explainable
 *      from a stored artifact
 *   3. extract (usage logged either way)
 *   4. normalize → dedupe → propose, in the mutation
 *   5. source health
 */

const runResultV = v.object({
  ok: v.boolean(),
  snapshotId: v.optional(v.id("snapshots")),
  created: v.boolean(),
  proposed: v.number(),
  pending: v.number(),
  deduped: v.number(),
  conflicts: v.number(),
  deferred: v.number(),
  dropped: v.number(),
  error: v.optional(v.string()),
})

const FAILED = {
  ok: false as const,
  created: false,
  proposed: 0,
  pending: 0,
  deduped: 0,
  conflicts: 0,
  deferred: 0,
  dropped: 0,
}

export const run = internalAction({
  args: {
    sourceId: v.id("sources"),
    /** An uploaded document (PDF/Word/…) in Convex storage. */
    storageId: v.optional(v.id("_storage")),
    /** Pre-converted markdown — the fixture and re-ingest path. */
    markdown: v.optional(v.string()),
    /** Original filename, so AnyDoc can fall back to the extension. */
    filename: v.optional(v.string()),
    courseId: v.optional(v.id("courses")),
    force: v.optional(v.boolean()),
  },
  returns: runResultV,
  handler: async (ctx, args) => {
    const source = await ctx.runQuery(internal.ingest.extracted.context, {
      sourceId: args.sourceId,
    })
    if (!source) throw new Error("404: source not found")
    if (source.kind !== "syllabus") {
      throw new Error(`ingest.syllabus.run: source ${args.sourceId} is ${source.kind}`)
    }

    try {
      // Resolved once and stored below: a re-ingest driven from the source
      // config must keep the same filename provenance (CR 3898632513).
      const filename = args.filename ?? filenameOf(source.config)
      const markdown = await loadMarkdown(ctx, {
        storageId: args.storageId ?? storageIdOf(source.config),
        markdown: args.markdown ?? markdownOf(source.config),
        filename,
      })

      const payload = {
        kind: "syllabus" as const,
        fetchedAt: Date.now(),
        markdown,
        ...(filename ? { filename } : {}),
      }
      const contentHash = await hashSnapshotPayload(payload)

      const extraction = await extractAndLog<SyllabusExtraction>(ctx, source.studentId, {
        schema: syllabusExtractionSchema,
        system: syllabusSystemPrompt({
          ...(source.semesterStart ? { start: source.semesterStart } : {}),
          ...(source.semesterEnd ? { end: source.semesterEnd } : {}),
        }),
        prompt: documentPrompt(markdown, args.filename),
      })

      const courseId = args.courseId ?? courseIdOf(source.config)
      const result: DocumentIngestResult = await ctx.runMutation(
        internal.ingest.extracted.ingestDocument,
        {
          sourceId: args.sourceId,
          origin: "syllabus",
          payload,
          contentHash,
          extraction,
          ...(courseId ? { courseId } : {}),
          ...(args.force ? { force: true } : {}),
        }
      )

      // A deferred batch is NOT a success: the deadlines are real, extracted,
      // and going nowhere until the student approves the new course. Health is
      // the channel Face already surfaces, so it says so in as many words.
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: result.deferred > 0 ? "stale" : "ok",
        ...(result.deferred > 0
          ? {
              message:
                `${result.deferred} deadline(s) are waiting on a course. Approve the new ` +
                `course in your change feed, then re-upload this syllabus.`,
            }
          : {}),
      })

      return {
        ok: true,
        snapshotId: result.snapshotId,
        created: result.created,
        proposed: result.proposed,
        pending: result.pending,
        deduped: result.deduped,
        conflicts: result.conflicts,
        deferred: result.deferred,
        dropped: result.dropped.length,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: "error",
        message,
      })
      await ctx.runMutation(internal.ingest.sources.markPolled, { sourceId: args.sourceId })
      return { ...FAILED, error: message }
    }
  },
})

// ---------------------------------------------------------------------------
// document → markdown
// ---------------------------------------------------------------------------

type LoadInput = {
  storageId?: Id<"_storage">
  markdown?: string
  filename?: string
}

/**
 * Converting the upload is injectable (`convert`) purely so the pipeline can be
 * driven from markdown fixtures with no native binding present.
 */
export async function loadMarkdown(
  ctx: ActionCtx,
  input: LoadInput,
  convert: DocToMarkdown = anydocToMarkdown
): Promise<string> {
  if (input.markdown && input.markdown.trim().length > 0) return input.markdown
  if (!input.storageId) {
    throw new Error("ingest.syllabus: needs either a storageId or markdown")
  }
  const blob = await ctx.storage.get(input.storageId)
  if (!blob) throw new Error("404: uploaded file not found in storage")
  const markdown = await convert(new Uint8Array(await blob.arrayBuffer()), input.filename)
  if (markdown.trim().length === 0) {
    throw new Error("The uploaded document converted to an empty document.")
  }
  return markdown
}

const bagOf = (config: unknown): Record<string, unknown> =>
  config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {}

const storageIdOf = (config: unknown): Id<"_storage"> | undefined => {
  const value = bagOf(config).storageId
  return typeof value === "string" ? (value as Id<"_storage">) : undefined
}

const courseIdOf = (config: unknown): Id<"courses"> | undefined => {
  const value = bagOf(config).courseId
  return typeof value === "string" ? (value as Id<"courses">) : undefined
}

const markdownOf = (config: unknown): string | undefined => {
  const value = bagOf(config).markdown
  return typeof value === "string" ? value : undefined
}

const filenameOf = (config: unknown): string | undefined => {
  const value = bagOf(config).filename
  return typeof value === "string" ? value : undefined
}
