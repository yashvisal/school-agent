import { describe, expect, test, vi } from "vitest"

import { internal } from "../../_generated/api"
import type { Id } from "../../_generated/dataModel"
import type { ActionCtx } from "../../_generated/server"
import { ExtractionError, type ExtractResult } from "./llm"
import { extractAndLog } from "./run"
import { syllabusExtractionSchema } from "./schemas"

/**
 * "Log usage on every LLM call" (CLAUDE.md) — including the calls that fail.
 *
 * A cost ledger that only records successes understates spend precisely when
 * something is going wrong: a model that burns 4,000 input tokens and then
 * returns an object the schema rejects cost exactly as much as one that worked.
 * These tests hold that contract with a stub ctx, because the real path runs in
 * a Node action against a live gateway and convex-test has neither.
 */

const STUDENT = "student_1" as Id<"students">

const stubCtx = () => {
  const runMutation = vi.fn(async () => "usage_1")
  return { ctx: { runMutation } as unknown as ActionCtx, runMutation }
}

const input = {
  schema: syllabusExtractionSchema,
  system: "system",
  prompt: "prompt",
}

describe("extractAndLog", () => {
  test("a successful call logs the reported tokens against `ingestion`", async () => {
    const { ctx, runMutation } = stubCtx()
    const object = { course: { name: "CS103" }, deadlines: [] }
    const extract = vi.fn(
      async (): Promise<ExtractResult<never>> => ({
        object: object as never,
        usage: { promptTokens: 2918, completionTokens: 513 },
        model: "anthropic/claude-haiku-4-5",
      })
    )

    const result = await extractAndLog(ctx, STUDENT, input, extract as never)

    expect(result).toEqual(object)
    expect(runMutation).toHaveBeenCalledTimes(1)
    expect(runMutation).toHaveBeenCalledWith(
      internal.usage.log,
      expect.objectContaining({
        studentId: STUDENT,
        surface: "ingestion",
        model: "anthropic/claude-haiku-4-5",
        promptTokens: 2918,
        completionTokens: 513,
      })
    )
  })

  test("a FAILED extraction still logs the tokens it burned, then rethrows", async () => {
    const { ctx, runMutation } = stubCtx()
    const extract = vi.fn(async () => {
      throw new ExtractionError("schema rejected the object", "anthropic/claude-haiku-4-5", {
        promptTokens: 4000,
        completionTokens: 120,
      })
    })

    await expect(extractAndLog(ctx, STUDENT, input, extract as never)).rejects.toThrow(
      /schema rejected/
    )

    expect(runMutation).toHaveBeenCalledTimes(1)
    expect(runMutation).toHaveBeenCalledWith(
      internal.usage.log,
      expect.objectContaining({ surface: "ingestion", promptTokens: 4000, completionTokens: 120 })
    )
  })

  test("a call that never reached the provider logs a zeroed row, not nothing", async () => {
    // The row is the evidence the call happened. A missing row reads as "we
    // never called", which is the one thing it must not be able to mean.
    const { ctx, runMutation } = stubCtx()
    const extract = vi.fn(async () => {
      throw new Error("network down")
    })

    await expect(extractAndLog(ctx, STUDENT, input, extract as never)).rejects.toThrow(
      /network down/
    )
    expect(runMutation).toHaveBeenCalledWith(
      internal.usage.log,
      expect.objectContaining({ promptTokens: 0, completionTokens: 0 })
    )
  })
})
