"use node"

import { v } from "convex/values"

import { internal } from "../_generated/api"
import { internalAction } from "../_generated/server"
import { hashSnapshotPayload } from "../lib/diff"
import { documentPrompt, siteSystemPrompt } from "../lib/extraction/prompts"
import { extractAndLog } from "../lib/extraction/run"
import type { SyllabusExtraction } from "../lib/extraction/schemas"
import { syllabusExtractionSchema } from "../lib/extraction/schemas"
import type { ScrapePage } from "../lib/extraction/siteLinks"
import { concatPages, discoverLinks, MAX_SITE_PAGES } from "../lib/extraction/siteLinks"
import { requireFetchableUrl } from "../lib/net"
import type { DocumentIngestResult } from "./extracted"

/**
 * The course-website adapter (core.md "Adapters" #4): Firecrawl → markdown →
 * the same extraction schema as the syllabus, because a course site states the
 * same *kind* of fact (grading scheme, dated assignments) in a looser form.
 *
 * **Firecrawl keyless (decided).** `POST /v2/scrape` works with no
 * `Authorization` header at all; `/crawl` and `/map` do not. So this adapter
 * does NOT crawl. It scrapes the configured seed URL, reads the same-origin
 * links out of the returned markdown, and scrapes at most `MAX_SITE_PAGES`
 * more — enough to reach the "assignments" and "calendar" pages that carry the
 * dates, and bounded so one course site can never spend a student's whole
 * keyless quota.
 *
 * Keyless means a shared free tier: 1,000 credits/month plus a per-IP daily
 * cap. A 429 is therefore an expected, self-healing condition, not a bug — it
 * is surfaced as source health with a message that says so rather than retried
 * into the cap.
 *
 * Every URL — the seed AND every link discovered in a *remote response* — goes
 * through `requireFetchableUrl`. A link in someone else's HTML is exactly the
 * same SSRF lever as a student-typed base URL (`lib/net.ts`).
 */

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape"

/** A stalled host must not hold the action open until the platform limit. */
const SCRAPE_TIMEOUT_MS = 30_000

export type Scrape = (url: string) => Promise<string>

const runResultV = v.object({
  ok: v.boolean(),
  snapshotId: v.optional(v.id("snapshots")),
  created: v.boolean(),
  pages: v.number(),
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
  pages: 0,
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
    courseId: v.optional(v.id("courses")),
    force: v.optional(v.boolean()),
  },
  returns: runResultV,
  handler: async (ctx, args) => {
    const source = await ctx.runQuery(internal.ingest.extracted.context, {
      sourceId: args.sourceId,
    })
    if (!source) throw new Error("404: source not found")
    if (source.kind !== "site") {
      throw new Error(`ingest.site.run: source ${args.sourceId} is ${source.kind}`)
    }
    const bag =
      source.config && typeof source.config === "object" && !Array.isArray(source.config)
        ? (source.config as Record<string, unknown>)
        : {}
    const seed = typeof bag.url === "string" ? bag.url : ""
    requireFetchableUrl("site config.url", seed)

    try {
      const pages = await scrapeSite(seed)
      const payload = {
        kind: "site" as const,
        url: seed,
        fetchedAt: Date.now(),
        markdown: concatPages(pages),
        pages: pages.map((page) => page.url),
      }
      const contentHash = await hashSnapshotPayload(payload)

      const extraction = await extractAndLog<SyllabusExtraction>(ctx, source.studentId, {
        schema: syllabusExtractionSchema,
        system: siteSystemPrompt({
          ...(source.semesterStart ? { start: source.semesterStart } : {}),
          ...(source.semesterEnd ? { end: source.semesterEnd } : {}),
        }),
        prompt: documentPrompt(payload.markdown, seed),
      })

      const courseId =
        args.courseId ?? (typeof bag.courseId === "string" ? bag.courseId : undefined)
      const result: DocumentIngestResult = await ctx.runMutation(
        internal.ingest.extracted.ingestDocument,
        {
          sourceId: args.sourceId,
          origin: "site",
          payload,
          contentHash,
          extraction,
          ...(courseId ? { courseId: courseId as never } : {}),
          ...(args.force ? { force: true } : {}),
        }
      )

      await ctx.runMutation(internal.ingest.sources.setHealth, {
        sourceId: args.sourceId,
        status: result.deferred > 0 ? "stale" : "ok",
        ...(result.deferred > 0
          ? {
              message:
                `${result.deferred} deadline(s) are waiting on a course. Approve the new ` +
                `course in your change feed, then re-run this site.`,
            }
          : {}),
      })

      return {
        ok: true,
        snapshotId: result.snapshotId,
        created: result.created,
        pages: pages.length,
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
// scraping
// ---------------------------------------------------------------------------

/** Keyless Firecrawl v2 scrape. Injectable so tests never touch the network. */
export const firecrawlScrape: Scrape = async (url) => {
  const response = await fetch(FIRECRAWL_SCRAPE_URL, {
    method: "POST",
    // Deliberately NO Authorization header: `/v2/scrape` is keyless.
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, formats: ["markdown"] }),
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  })
  if (response.status === 429) {
    throw new Error(
      "Firecrawl's keyless daily cap is reached for this deployment. Course-site " +
        "scraping will work again after it resets; nothing else is affected."
    )
  }
  if (!response.ok) {
    throw new Error(`Firecrawl scrape ${response.status} for ${url}`)
  }
  const body: unknown = await response.json()
  const markdown = (body as { data?: { markdown?: unknown } } | null)?.data?.markdown
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    throw new Error(`Firecrawl returned no markdown for ${url}`)
  }
  return markdown
}

/**
 * The seed plus up to `MAX_SITE_PAGES` same-origin links found in it.
 *
 * A failure on a *discovered* page is swallowed: the seed already produced
 * usable markdown, and losing the calendar page is a smaller loss than losing
 * the whole scrape to one dead link. A failure on the SEED propagates — there
 * is nothing to extract from.
 */
export async function scrapeSite(
  seed: string,
  scrape: Scrape = firecrawlScrape,
  maxExtraPages: number = MAX_SITE_PAGES
): Promise<ScrapePage[]> {
  const pages: ScrapePage[] = [{ url: seed, markdown: await scrape(seed) }]

  for (const url of discoverLinks(pages[0].markdown, seed).slice(0, maxExtraPages)) {
    try {
      pages.push({ url, markdown: await scrape(url) })
    } catch {
      // Discovered pages are best-effort; the seed already carried content.
    }
  }
  return pages
}
