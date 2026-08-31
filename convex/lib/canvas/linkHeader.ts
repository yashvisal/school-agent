/**
 * `Link` header parsing for Canvas pagination.
 *
 * Shape from https://developerdocs.instructure.com/services/canvas/basics/file.pagination:
 *
 *   Link: <https://.../topics.json?opaqueA>; rel="current",
 *         <https://.../topics.json?opaqueB>; rel="next",
 *         <https://.../topics.json?opaqueA>; rel="first",
 *         <https://.../topics.json?opaqueD>; rel="last"
 *
 * The docs also warn the URLs are opaque: follow `rel="next"` verbatim rather
 * than reconstructing `?page=n` yourself, because some endpoints paginate with
 * bookmarks (`page=bookmark:...`) instead of numbers.
 */

export type LinkRel = "current" | "next" | "prev" | "first" | "last"

export type ParsedLinks = Partial<Record<LinkRel, string>>

const KNOWN_RELS: ReadonlySet<string> = new Set([
  "current",
  "next",
  "prev",
  "first",
  "last",
])

/**
 * Splits on commas that are NOT inside angle brackets — a bookmark cursor can
 * legitimately contain a comma once URL-decoded, and some instances emit
 * unquoted `rel=next` with stray whitespace.
 */
function splitEntries(header: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < header.length; i++) {
    const ch = header[i]
    if (ch === "<") depth++
    else if (ch === ">") depth = Math.max(0, depth - 1)
    else if (ch === "," && depth === 0) {
      entries.push(header.slice(start, i))
      start = i + 1
    }
  }
  entries.push(header.slice(start))
  return entries
}

export function parseLinkHeader(header: string | null | undefined): ParsedLinks {
  if (!header) return {}
  const links: ParsedLinks = {}

  for (const entry of splitEntries(header)) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue

    const open = trimmed.indexOf("<")
    const close = trimmed.indexOf(">", open + 1)
    if (open === -1 || close === -1) continue
    const url = trimmed.slice(open + 1, close).trim()
    if (url.length === 0) continue

    for (const param of trimmed.slice(close + 1).split(";")) {
      const eq = param.indexOf("=")
      if (eq === -1) continue
      const name = param.slice(0, eq).trim().toLowerCase()
      if (name !== "rel") continue
      const rel = param
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase()
      // `rel` may carry several space-separated values per RFC 8288.
      for (const candidate of rel.split(/\s+/)) {
        if (KNOWN_RELS.has(candidate) && links[candidate as LinkRel] === undefined) {
          links[candidate as LinkRel] = url
        }
      }
    }
  }

  return links
}

/** The URL to fetch next, or `undefined` when this was the last page. */
export function nextPageUrl(header: string | null | undefined): string | undefined {
  const { next, current } = parseLinkHeader(header)
  // Canvas emits `rel="next"` on the last page of some endpoints pointing back
  // at the current page; following it would loop forever.
  if (next && next !== current) return next
  return undefined
}
