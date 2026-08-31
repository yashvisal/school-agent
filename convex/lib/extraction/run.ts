import { internal } from "../../_generated/api"
import type { Id } from "../../_generated/dataModel"
import type { ActionCtx } from "../../_generated/server"
import type { ExtractStructuredInput } from "./llm"
import { EXTRACTION_MODEL, extractStructured, usageOf } from "./llm"

/**
 * One LLM extraction, with its `usage` row guaranteed.
 *
 * CLAUDE.md: "Log usage on every LLM call." Every, including the calls that
 * FAIL — a call that burned 4,000 input tokens and then produced an object the
 * schema rejected cost exactly as much as one that succeeded, and a cost ledger
 * that only records successes understates spend precisely when something is
 * going wrong. `ExtractionError` carries the tokens out of the failure path
 * (see `llm.ts`) so the row can be written before the error is re-thrown.
 *
 * The write is a separate transaction from the call by necessity — LLM calls
 * happen in actions, and actions have no `ctx.db`.
 */
export async function extractAndLog<T>(
  ctx: ActionCtx,
  studentId: Id<"students">,
  input: ExtractStructuredInput<T>,
  /** Injectable so the usage-logging contract is testable without a gateway. */
  extract: typeof extractStructured = extractStructured
): Promise<T> {
  try {
    const result = await extract(input)
    await ctx.runMutation(internal.usage.log, {
      studentId,
      surface: "ingestion",
      model: result.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      at: Date.now(),
    })
    return result.object
  } catch (error) {
    const usage = usageOf(error)
    await ctx.runMutation(internal.usage.log, {
      studentId,
      surface: "ingestion",
      model: input.model ?? EXTRACTION_MODEL,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      at: Date.now(),
    })
    throw error
  }
}
