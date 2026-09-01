import type { ModelMessage } from "ai"
import { generateObject, NoObjectGeneratedError } from "ai"
import type { z } from "zod"

/**
 * The one place Core calls a model (CLAUDE.md: "All model calls go through the
 * AI Gateway", "Log usage on every LLM call").
 *
 * Model strings, not provider SDK objects: `"anthropic/claude-haiku-4-5"` is a
 * Vercel AI Gateway model id, and the AI SDK's default provider resolves a bare
 * string through the gateway using `AI_GATEWAY_API_KEY` from the deployment
 * env. That is what makes "models chosen per task, swappable" (core.md "Stack")
 * a one-line change here rather than a dependency swap.
 *
 * This module deliberately does NOT write the `usage` row: it has no `ctx`. It
 * returns the token counts on both the success and the failure path (see
 * `ExtractionError.usage`) so the calling action can log them either way —
 * a call that burned tokens and then failed schema validation still cost money,
 * and the usage table is the only cost record that survives a runtime change
 * (core.md "State model": `usage`).
 */

/** Cheap and fast; the syllabus/site extraction workhorse. */
export const EXTRACTION_MODEL = "anthropic/claude-haiku-4-5"

/** Schedule uploads are usually a photo of a timetable grid — that needs eyes. */
export const VISION_MODEL = "anthropic/claude-sonnet-4-5"

export type ExtractionUsage = { promptTokens: number; completionTokens: number }

export type ExtractResult<T> = {
  object: T
  usage: ExtractionUsage
  model: string
}

export type ImageInput = {
  /** Raw image bytes; the SDK base64-encodes them for the provider. */
  data: Uint8Array
  /** e.g. `image/png`. */
  mediaType: string
}

export type ExtractStructuredInput<T> = {
  schema: z.ZodType<T>
  system: string
  /** The document text. Omitted only when the whole input is images. */
  prompt?: string
  /** Schedule uploads: the timetable image(s), sent alongside `prompt`. */
  images?: ImageInput[]
  model?: string
  maxRetries?: number
}

/** Carries the tokens a failed call still burned, so the caller can log them. */
export class ExtractionError extends Error {
  readonly model: string
  readonly usage: ExtractionUsage

  constructor(message: string, model: string, usage: ExtractionUsage) {
    super(message)
    this.name = "ExtractionError"
    this.model = model
    this.usage = usage
  }
}

const ZERO_USAGE: ExtractionUsage = { promptTokens: 0, completionTokens: 0 }

/**
 * `LanguageModelUsage` names the fields `inputTokens`/`outputTokens` and allows
 * `undefined` for providers that do not report them; the `usage` table's
 * `promptTokens`/`completionTokens` are required numbers. An unreported count
 * is recorded as 0 rather than dropped — a usage row that exists with a zero is
 * auditable ("this call happened, the provider said nothing"), while a missing
 * row looks like the call never happened.
 */
const toUsage = (usage?: {
  inputTokens?: number
  outputTokens?: number
}): ExtractionUsage => ({
  promptTokens: Number.isFinite(usage?.inputTokens) ? (usage?.inputTokens as number) : 0,
  completionTokens: Number.isFinite(usage?.outputTokens)
    ? (usage?.outputTokens as number)
    : 0,
})

export async function extractStructured<T>(
  input: ExtractStructuredInput<T>
): Promise<ExtractResult<T>> {
  const model = input.model ?? EXTRACTION_MODEL
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        ...(input.prompt ? [{ type: "text" as const, text: input.prompt }] : []),
        ...(input.images ?? []).map((image) => ({
          type: "image" as const,
          image: image.data,
          mediaType: image.mediaType,
        })),
      ],
    },
  ]
  if (messages[0].content.length === 0) {
    throw new Error("extractStructured: needs a prompt, images, or both")
  }

  try {
    const result = await generateObject({
      model,
      schema: input.schema,
      system: input.system,
      messages,
      maxRetries: input.maxRetries ?? 2,
      // Extraction is a transcription task, not a creative one.
      temperature: 0,
    })
    return { object: result.object as T, usage: toUsage(result.usage), model }
  } catch (error) {
    // The model answered but the answer did not satisfy the schema. Those tokens
    // were spent; carry them out so the action still writes the `usage` row.
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new ExtractionError(
        `extraction produced no valid object: ${error.message}`,
        model,
        toUsage(error.usage)
      )
    }
    throw new ExtractionError(
      error instanceof Error ? error.message : String(error),
      model,
      ZERO_USAGE
    )
  }
}

/** The usage to log for a thrown extraction, whatever the failure was. */
export const usageOf = (error: unknown): ExtractionUsage =>
  error instanceof ExtractionError ? error.usage : ZERO_USAGE
