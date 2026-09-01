import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { EXTRACTION_MODEL, extractStructured } from "../convex/lib/extraction/llm"
import { normalizeScheduleExtraction } from "../convex/lib/extraction/normalize"
import type { TimeBlock } from "../convex/lib/extraction/normalize"
import {
  documentPrompt,
  scheduleSystemPrompt,
  siteSystemPrompt,
  syllabusSystemPrompt,
} from "../convex/lib/extraction/prompts"
import type {
  ScheduleExtraction,
  SyllabusExtraction,
} from "../convex/lib/extraction/schemas"
import {
  scheduleExtractionSchema,
  syllabusExtractionSchema,
} from "../convex/lib/extraction/schemas"
import type { FixtureMeta } from "./score"
import { formatScore, normalizeFor, scoreExtraction } from "./score"

/**
 * Live extraction evals (core.md "Definition of done": "**Extraction eval
 * fixtures checked in:** every real syllabus, course site and schedule upload
 * has a hand-verified expected-output fixture; the extraction pipelines run
 * against them").
 *
 * These call the REAL model through the AI Gateway. Nothing is written to
 * Convex — there is no `ctx` here, so no `usage` row; the mandatory usage
 * logging is asserted in the convex-test layer (`convex/ingest/extracted.test.ts`)
 * where a real `ctx` exists. This file measures the *prompt and schema*, which
 * is the part a deterministic test cannot measure at all.
 *
 * Run with `pnpm eval`. With no `AI_GATEWAY_API_KEY` it skips loudly rather
 * than failing, so a contributor without a key still gets a green `pnpm test`.
 *
 * **Bootstrapping a new fixture:** drop in `source.md` + `fixture.json` and run
 * the eval. With no `expected.json` present it prints the model's extraction and
 * skips, so you have a starting point to hand-verify against `source.md` — read
 * it yourself, correct it, save it. The printed output is a DRAFT, never the
 * expectation; a fixture that expects whatever the model happened to say
 * measures nothing.
 */

const ROOT = join(process.cwd(), "fixtures", "extraction")
const HAS_KEY = Boolean(process.env.AI_GATEWAY_API_KEY)

type FixtureCase = {
  slug: string
  dir: string
  source: string
  meta: FixtureMeta
  expected: unknown
}

function load(kind: "syllabi" | "sites" | "schedules"): FixtureCase[] {
  const base = join(ROOT, kind)
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(base, entry.name)
      const expectedPath = join(dir, "expected.json")
      return {
        slug: `${kind}/${entry.name}`,
        dir,
        source: readFileSync(join(dir, "source.md"), "utf8"),
        meta: JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8")) as FixtureMeta,
        expected: existsSync(expectedPath)
          ? JSON.parse(readFileSync(expectedPath, "utf8"))
          : undefined,
      }
    })
}

if (!HAS_KEY) {
  console.log(
    "\n[eval] AI_GATEWAY_API_KEY is not set — skipping the live extraction evals.\n" +
      "       Set it in .env.local (or the environment) to measure the prompts.\n"
  )
}

const draft = (slug: string, object: unknown) => {
  console.log(
    `\n[eval] ${slug} has no expected.json. DRAFT extraction below — hand-verify it\n` +
      `       against source.md before saving it as expected.json.\n` +
      `${JSON.stringify(object, null, 2)}\n`
  )
}

// ---------------------------------------------------------------------------
// syllabi + course sites
// ---------------------------------------------------------------------------

for (const kind of ["syllabi", "sites"] as const) {
  const source = kind === "syllabi" ? ("syllabus" as const) : ("site" as const)
  const cases = load(kind)

  describe.skipIf(!HAS_KEY || cases.length === 0)(`extraction: ${kind}`, () => {
    for (const fixture of cases) {
      it(fixture.slug, async () => {
        const { object, usage, model } = await extractStructured<SyllabusExtraction>({
          schema: syllabusExtractionSchema,
          system:
            source === "syllabus"
              ? syllabusSystemPrompt(fixture.meta.semester)
              : siteSystemPrompt(fixture.meta.semester),
          prompt: documentPrompt(fixture.source, fixture.slug),
        })
        console.log(
          `[eval] ${fixture.slug}: ${model} ${usage.promptTokens}in/${usage.completionTokens}out`
        )

        if (!fixture.expected) {
          draft(fixture.slug, object)
          return
        }

        const expected = syllabusExtractionSchema.parse(fixture.expected)
        const score = scoreExtraction(
          fixture.slug,
          normalizeFor(expected, fixture.meta, source),
          normalizeFor(object, fixture.meta, source)
        )
        console.log(formatScore(score))
        expect(score.failures, fixture.meta.note ?? "").toEqual([])
      })
    }
  })
}

// ---------------------------------------------------------------------------
// class schedules
// ---------------------------------------------------------------------------

/**
 * A schedule is scored on the BLOCKS, exactly, not fuzzily. Every block becomes
 * a hard constraint the planner may never schedule over, so "close" is the one
 * thing it cannot be: a block half an hour off either lets work land on a class
 * or blocks out a free afternoon.
 */
const blockKey = (block: TimeBlock) =>
  `${block.dayOfWeek}@${block.startMin}-${block.endMin}`

describe.skipIf(!HAS_KEY)("extraction: schedules", () => {
  for (const fixture of load("schedules")) {
    it(fixture.slug, async () => {
      const { object, usage, model } = await extractStructured<ScheduleExtraction>({
        schema: scheduleExtractionSchema,
        system: scheduleSystemPrompt(),
        prompt: documentPrompt(fixture.source, fixture.slug),
      })
      console.log(
        `[eval] ${fixture.slug}: ${model} ${usage.promptTokens}in/${usage.completionTokens}out`
      )

      if (!fixture.expected) {
        draft(fixture.slug, object)
        return
      }

      const expected = normalizeScheduleExtraction(
        scheduleExtractionSchema.parse(fixture.expected)
      )
      const actual = normalizeScheduleExtraction(object)

      const want = new Set(expected.blocks.map(blockKey))
      const got = new Set(actual.blocks.map(blockKey))
      const missing = [...want].filter((key) => !got.has(key))
      const extra = [...got].filter((key) => !want.has(key))

      console.log(
        `${missing.length === 0 && extra.length === 0 ? "PASS" : "FAIL"}  ${fixture.slug}\n` +
          `  blocks     ${want.size} expected, ${got.size} extracted, ` +
          `${missing.length} missing, ${extra.length} extra` +
          (missing.length > 0 ? `\n  missing    ${missing.join(" | ")}` : "") +
          (extra.length > 0 ? `\n  extra      ${extra.join(" | ")}` : "")
      )

      expect({ missing, extra }, fixture.meta.note ?? "").toEqual({ missing: [], extra: [] })
    })
  }
})

// A reminder that this file is not the gate: `pnpm test` is.
export const EVAL_MODEL = EXTRACTION_MODEL
