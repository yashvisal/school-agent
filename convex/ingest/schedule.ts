"use node"

import type { Infer } from "convex/values"
import { v } from "convex/values"

import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import { internalAction } from "../_generated/server"
import { hashSnapshotPayload } from "../lib/diff"
import { anydocToMarkdown } from "../lib/extraction/anydoc"
import type { ImageInput } from "../lib/extraction/llm"
import { EXTRACTION_MODEL, VISION_MODEL } from "../lib/extraction/llm"
import { documentPrompt, scheduleSystemPrompt } from "../lib/extraction/prompts"
import { extractAndLog } from "../lib/extraction/run"
import type { ScheduleExtraction } from "../lib/extraction/schemas"
import { scheduleExtractionSchema } from "../lib/extraction/schemas"
import type { ScheduleIngestResult } from "./extracted"

/**
 * The class-schedule adapter (core.md "Adapters" #5): an uploaded image or file
 * → LLM extraction into weekly hard blocks → `needs_approval`, verified by the
 * student in a simple weekly view → the planner's class boundaries.
 *
 * Two input shapes, one schema:
 *   - **an image** (the common case — a photo or screenshot of a timetable
 *     grid): sent to `VISION_MODEL`, because reading a grid is a layout problem
 *     and a text extractor throws the layout away, which is exactly the
 *     information that says which class is on Tuesday.
 *   - **a document or markdown**: converted first, extracted with the cheaper
 *     `EXTRACTION_MODEL`.
 *
 * Whatever comes out is ONE `availability_updated` change (see
 * `ingest/extracted.ts` for why the grid is only meaningful whole).
 */

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"])

/** Anthropic's per-image ceiling; a bigger upload is refused, not silently truncated. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const runResultV = v.object({
  ok: v.boolean(),
  snapshotId: v.optional(v.id("snapshots")),
  created: v.boolean(),
  changeId: v.optional(v.id("changes")),
  blocks: v.number(),
  dropped: v.number(),
  error: v.optional(v.string()),
})

const FAILED = { ok: false as const, created: false, blocks: 0, dropped: 0 }

type RunResult = Infer<typeof runResultV>

export const run = internalAction({
  args: {
    sourceId: v.id("sources"),
    storageId: v.optional(v.id("_storage")),
    markdown: v.optional(v.string()),
    filename: v.optional(v.string()),
    force: v.optional(v.boolean()),
  },
  returns: runResultV,
  // Explicit return type: the dedupe branch queries `internal.*`, whose type
  // includes this very action, so inference would be circular (TS7022).
  handler: async (ctx, args): Promise<RunResult> => {
    const source = await ctx.runQuery(internal.ingest.extracted.context, {
      sourceId: args.sourceId,
    })
    if (!source) throw new Error("404: source not found")
    if (source.kind !== "schedule") {
      throw new Error(`ingest.schedule.run: source ${args.sourceId} is ${source.kind}`)
    }
    const bag =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : {}

    try {
      const storageId =
        args.storageId ??
        (typeof bag.storageId === "string" ? (bag.storageId as Id<"_storage">) : undefined)
      const filename =
        args.filename ?? (typeof bag.filename === "string" ? bag.filename : undefined)
      const markdownArg =
        args.markdown ?? (typeof bag.markdown === "string" ? bag.markdown : undefined)

      const input = await loadScheduleInput(ctx, { storageId, markdown: markdownArg, filename })

      const payload = {
        kind: "schedule" as const,
        fetchedAt: Date.now(),
        ...(input.markdown !== undefined ? { markdown: input.markdown } : {}),
        // The image itself stays in storage; the snapshot records WHICH file and
        // its digest, so the snapshot row never carries megabytes of pixels.
        ...(input.imageDigest !== undefined
          ? { imageDigest: input.imageDigest, storageId, mediaType: input.mediaType }
          : {}),
      }
      // Identity is the CONTENT: a byte-identical re-upload gets a new
      // storageId, which must not defeat dedupe (CR 3898632507).
      const contentHash = await hashSnapshotPayload({ ...payload, storageId: undefined })

      // Dedupe BEFORE the model call — a hash-equal retry must cost zero
      // tokens, not "extract, then notice the snapshot already exists".
      if (!args.force) {
        // Explicit annotation: `internal.*` self-reference otherwise makes the
        // action's type circular (TS7022).
        const prev: Doc<"snapshots"> | null = await ctx.runQuery(
          internal.ingest.snapshots.latest,
          { sourceId: args.sourceId }
        )
        if (prev?.contentHash === contentHash) {
          await ctx.runMutation(internal.ingest.sources.markPolled, {
            sourceId: args.sourceId,
          })
          return {
            ok: true,
            snapshotId: prev._id,
            created: false,
            blocks: 0,
            dropped: 0,
          }
        }
      }

      const extraction = await extractAndLog<ScheduleExtraction>(ctx, source.studentId, {
        schema: scheduleExtractionSchema,
        system: scheduleSystemPrompt(),
        prompt:
          input.markdown !== undefined
            ? documentPrompt(input.markdown, filename)
            : "Read this weekly class schedule and extract every meeting block it shows.",
        ...(input.image ? { images: [input.image] } : {}),
        model: input.image ? VISION_MODEL : EXTRACTION_MODEL,
      })

      const result: ScheduleIngestResult = await ctx.runMutation(
        internal.ingest.extracted.ingestSchedule,
        {
          sourceId: args.sourceId,
          payload,
          contentHash,
          extraction,
          ...(args.force ? { force: true } : {}),
        }
      )

      // Zero blocks from a real upload means the parse found nothing usable.
      // That is a state the student has to see — the planner is about to run
      // with no class boundaries at all.
      const readNothing = result.created && result.blocks === 0
      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: readNothing ? "error" : "ok",
        ...(readNothing
          ? {
              message:
                "No class blocks could be read from this upload. Try a clearer image, " +
                "or enter your weekly schedule by hand.",
            }
          : {}),
      })

      return {
        ok: true,
        snapshotId: result.snapshotId,
        created: result.created,
        ...(result.changeId ? { changeId: result.changeId } : {}),
        blocks: result.blocks,
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

type ScheduleInput = {
  markdown?: string
  image?: ImageInput
  imageDigest?: string
  mediaType?: string
}

async function loadScheduleInput(
  ctx: { storage: { get(id: Id<"_storage">): Promise<Blob | null> } },
  input: { storageId?: Id<"_storage">; markdown?: string; filename?: string }
): Promise<ScheduleInput> {
  if (input.markdown && input.markdown.trim().length > 0) {
    return { markdown: input.markdown }
  }
  if (!input.storageId) {
    throw new Error("ingest.schedule: needs either a storageId or markdown")
  }
  const blob = await ctx.storage.get(input.storageId)
  if (!blob) throw new Error("404: uploaded file not found in storage")
  const bytes = new Uint8Array(await blob.arrayBuffer())

  const mediaType = (blob.type || "").toLowerCase()
  if (IMAGE_TYPES.has(mediaType)) {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        // One decimal: a 5.4MB upload must not read "5MB; the limit is 5MB"
        // (CR 3898824576).
        `That image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is ` +
          `${MAX_IMAGE_BYTES / 1024 / 1024}MB. A screenshot is usually far smaller than a photo.`
      )
    }
    return {
      image: { data: bytes, mediaType: mediaType === "image/jpg" ? "image/jpeg" : mediaType },
      imageDigest: await digest(bytes),
      mediaType,
    }
  }

  const markdown = await anydocToMarkdown(bytes, input.filename)
  if (markdown.trim().length === 0) {
    throw new Error("The uploaded schedule converted to an empty document.")
  }
  return { markdown }
}

const HEX = "0123456789abcdef"

/**
 * SHA-256 of the image bytes, so an identical re-upload hashes to the same
 * snapshot and costs no vision tokens. Web Crypto is ambient — no `import
 * crypto`, which is a Node builtin and would be one more reason this file can
 * never be shared with the default runtime.
 */
async function digest(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer)
  let out = ""
  for (const byte of new Uint8Array(buffer)) out += HEX[byte >> 4] + HEX[byte & 15]
  return out
}
