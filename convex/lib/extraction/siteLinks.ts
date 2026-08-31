import { requireFetchableUrl } from "../net"

/**
 * Which pages of a course website are worth a second request, and how the
 * scraped pages are stitched together.
 *
 * Pure and separate from `ingest/site.ts` on purpose: that file carries
 * `"use node"` (it reaches the AI SDK), and link selection is exactly the part
 * worth testing without a runtime, a key, or a network.
 */

/**
 * Pages scraped BEYOND the seed. Four covers the shape of a real course site
 * (home → syllabus, assignments, calendar, policies) without turning
 * Firecrawl's shared keyless quota into a crawl budget.
 */
export const MAX_SITE_PAGES = 4

/** Link text or path that means "the page with the dates on it". */
const INTERESTING = [
  "assignment",
  "homework",
  "pset",
  "problem set",
  "calendar",
  "schedule",
  "syllabus",
  "due",
  "exam",
  "grading",
  "coursework",
  "deadline",
]

/** Binaries and feeds a markdown scrape cannot use. */
const SKIP_EXTENSIONS =
  /\.(pdf|docx?|pptx?|xlsx?|zip|tar|gz|png|jpe?g|gif|svg|webp|mp4|mp3|ics|rss|xml|json)$/i

export type ScrapePage = { url: string; markdown: string }

/**
 * Same-origin links worth a second request, most promising first.
 *
 * Same-origin is not a nicety. This follows links out of a page WE did not
 * write, so without it a course site could point our server anywhere it liked —
 * the same lever `lib/net.ts` exists for. `requireFetchableUrl` is the second
 * gate, for a link whose origin passes but whose host resolves somewhere it
 * should not.
 */
export function discoverLinks(markdown: string, seed: string): string[] {
  let base: URL
  try {
    base = new URL(seed)
  } catch {
    return []
  }

  // The seed is compared in the same canonical form as the candidates: the raw
  // config value can differ by fragment, host case, or encoding, and a
  // self-link must never spend one of the four scrapes (CR 3898632546).
  const seedNormalized = (() => {
    try {
      const u = new URL(seed)
      u.hash = ""
      return u.toString()
    } catch {
      return seed
    }
  })()
  const scored = new Map<string, number>()
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of markdown.matchAll(linkRe)) {
    const [, text, href] = match
    let url: URL
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    // A fragment is the same page; following it would spend a scrape on markdown
    // we already have.
    url.hash = ""
    const normalized = url.toString()
    if (url.origin !== base.origin) continue
    if (
      normalized === seedNormalized ||
      normalized === `${seedNormalized}/` ||
      `${normalized}/` === seedNormalized
    )
      continue
    if (SKIP_EXTENSIONS.test(url.pathname)) continue
    try {
      requireFetchableUrl("site link", normalized)
    } catch {
      continue
    }
    const haystack = `${text} ${url.pathname}`.toLowerCase()
    const score = INTERESTING.reduce(
      (total, word) => total + (haystack.includes(word) ? 1 : 0),
      0
    )
    // Scored, not crawled: an unremarkable link is skipped entirely rather than
    // queued behind the good ones, because the budget is four pages, not four
    // hundred.
    if (score === 0) continue
    scored.set(normalized, Math.max(scored.get(normalized) ?? 0, score))
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([url]) => url)
}

/**
 * Pages joined with an explicit `page: <url>` marker. The marker is not
 * cosmetic: the site prompt tells the model to use it as `pageRef`, so a student
 * can see which page of the site a deadline was read off.
 */
export const concatPages = (pages: ScrapePage[]): string =>
  pages.map((page) => `\n\n---\npage: ${page.url}\n\n${page.markdown}`).join("").trim()
