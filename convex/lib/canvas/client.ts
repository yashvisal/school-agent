import { requireFetchableUrl } from "../net"
import { nextPageUrl } from "./linkHeader"
import type {
  CanvasAssignment,
  CanvasAssignmentGroup,
  CanvasCourse,
  CanvasCourseBundle,
  CanvasDiscussionTopic,
  CanvasFile,
  CanvasModule,
  CanvasPage,
  CanvasSnapshotPayload,
  CanvasSubmission,
} from "./types"

/**
 * The Canvas fetch layer — deliberately thin and swappable.
 *
 * plans/core.md, "Test data & limitations": there is no live Canvas until a
 * friend's token arrives, and rate limits / real pagination behaviour are
 * explicitly deferred to that pass. So everything here is injectable: tests
 * pass a fixture-backed `FetchFn`, and the live-validation pass can swap the
 * transport without touching normalization or the diff.
 *
 * Pagination: https://developerdocs.instructure.com/services/canvas/basics/file.pagination
 * Throttling: https://developerdocs.instructure.com/services/canvas/basics/file.throttling
 *   - every response carries `X-Request-Cost`
 *   - `X-Rate-Limit-Remaining` is the quota left; it replenishes over time
 *   - exhausting it returns 403/429 "Rate Limit Exceeded"
 */

export type FetchResponseLike = {
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export type FetchFn = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<FetchResponseLike>

export type SleepFn = (ms: number) => Promise<void>

export type CanvasClientOptions = {
  fetchFn?: FetchFn
  sleep?: SleepFn
  /** Items per page. Canvas defaults to 10; 100 is the usual practical cap. */
  perPage?: number
  /** Hard stop so a broken `rel="next"` can never spin forever. */
  maxPages?: number
  /** Back off pre-emptively once the quota drops below this. */
  rateLimitFloor?: number
  maxRetries?: number
}

/**
 * Hard ceiling on pages per endpoint. At `perPage: 100` that is 5,000 items —
 * far past any real course — so hitting it means the feed is pathological or
 * `rel="next"` is looping, and the source is marked unhealthy rather than
 * burning the whole action budget.
 */
export const MAX_PAGES = 50

/**
 * Per-request wall clock. A stalled host would otherwise hold the action until
 * the platform limit, delaying every later poll in the same run.
 */
export const REQUEST_TIMEOUT_MS = 30_000

const DEFAULTS = {
  perPage: 100,
  maxPages: MAX_PAGES,
  rateLimitFloor: 100,
  maxRetries: 4,
} as const

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, {
    method: "GET",
    headers: init.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

export class CanvasError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string
  ) {
    super(message)
    this.name = "CanvasError"
  }
}

export const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "")

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | string[]>,
  perPage: number
): string {
  const url = new URL(path.startsWith("http") ? path : `${normalizeBaseUrl(baseUrl)}${path}`)
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item)
    } else {
      url.searchParams.set(key, String(value))
    }
  }
  if (!url.searchParams.has("per_page")) {
    url.searchParams.set("per_page", String(perPage))
  }
  return url.toString()
}

/**
 * One request, with retries on 429/403-rate-limit and 5xx. Exponential backoff
 * with a `Retry-After` override when Canvas supplies one.
 */
async function requestOnce(
  url: string,
  token: string,
  opts: Required<Pick<CanvasClientOptions, "maxRetries" | "rateLimitFloor">> & {
    fetchFn: FetchFn
    sleep: SleepFn
  }
): Promise<{ body: unknown; link: string | null }> {
  let attempt = 0
  for (;;) {
    const response = await opts.fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json+canvas-string-ids, application/json",
      },
    })

    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 403 && isRateLimited(await peekRateLimitHeader(response)))

    if (retryable && attempt < opts.maxRetries) {
      const retryAfter = Number(response.headers.get("Retry-After"))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 500 * 2 ** attempt
      attempt++
      await opts.sleep(delay)
      continue
    }

    const text = await response.text()
    if (response.status < 200 || response.status >= 300) {
      throw new CanvasError(
        `Canvas ${response.status} for ${url}: ${text.slice(0, 300)}`,
        response.status,
        url
      )
    }

    // Pre-emptive courtesy backoff: the docs say the quota replenishes faster
    // than real time, so a short pause is enough to stay under it.
    // Only when the header is actually present: `Number(null)` is 0, which
    // would make every un-throttled response look like an exhausted quota.
    const remainingHeader = response.headers.get("X-Rate-Limit-Remaining")
    if (remainingHeader !== null) {
      const remaining = Number(remainingHeader)
      if (Number.isFinite(remaining) && remaining < opts.rateLimitFloor) {
        await opts.sleep(1000)
      }
    }

    let body: unknown
    try {
      body = text.length === 0 ? [] : JSON.parse(text)
    } catch {
      throw new CanvasError(`Canvas returned non-JSON for ${url}`, response.status, url)
    }
    return { body, link: response.headers.get("Link") }
  }
}

const peekRateLimitHeader = async (response: FetchResponseLike) =>
  response.headers.get("X-Rate-Limit-Remaining")

const isRateLimited = (remaining: string | null) =>
  remaining !== null && Number(remaining) <= 0

/**
 * GET every page of a list endpoint, following `rel="next"` verbatim.
 * Returns a flat array; non-array pages (an error object, a single resource)
 * are appended as a single item so callers see the shape they asked for.
 */
export async function fetchAll<T>(
  baseUrl: string,
  token: string,
  path: string,
  params: Record<string, string | number | string[]> = {},
  options: CanvasClientOptions = {}
): Promise<T[]> {
  const perPage = options.perPage ?? DEFAULTS.perPage
  const maxPages = options.maxPages ?? DEFAULTS.maxPages
  const cfg = {
    fetchFn: options.fetchFn ?? defaultFetch,
    sleep: options.sleep ?? defaultSleep,
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    rateLimitFloor: options.rateLimitFloor ?? DEFAULTS.rateLimitFloor,
  }

  const out: T[] = []
  const seen = new Set<string>()
  let url: string | undefined = buildUrl(baseUrl, path, params, perPage)
  const firstUrl = url

  for (let page = 0; page < maxPages && url; page++) {
    if (seen.has(url)) break
    seen.add(url)

    const { body, link }: { body: unknown; link: string | null } = await requestOnce(
      url,
      token,
      cfg
    )
    if (Array.isArray(body)) out.push(...(body as T[]))
    else out.push(body as T)

    url = nextPageUrl(link)

    // A `rel="next"` URL comes out of the RESPONSE and is fetched with the
    // bearer token attached — same SSRF surface as the configured base URL, so
    // it passes the same guard (CR 3897465401). A hostile/broken link becomes
    // an `error` health status, never a token sent to a private host.
    if (url) {
      try {
        requireFetchableUrl("Canvas pagination URL", url)
      } catch (error) {
        throw new CanvasError(
          `Canvas returned an unsafe pagination link for ${firstUrl}: ` +
            (error instanceof Error ? error.message : String(error)),
          0,
          url
        )
      }
    }

    // Still more pages at the cap: refuse to guess at a partial result. The
    // adapter turns this into an `error` health status the student can see,
    // rather than silently ingesting a truncated course and diffing the missing
    // items as removals.
    if (url && page + 1 >= maxPages && !seen.has(url)) {
      throw new CanvasError(
        `Canvas pagination exceeded ${maxPages} pages for ${firstUrl}; ` +
          `refusing a truncated result`,
        0,
        firstUrl
      )
    }
  }

  return out
}

/**
 * One full poll: courses, then everything per course.
 *
 * Sequential on purpose — the throttling docs say parallel requests take an
 * extra pre-flight penalty, and a semester is a handful of pages.
 */
export async function fetchCanvasSnapshot(
  baseUrl: string,
  token: string,
  options: CanvasClientOptions & { now?: () => number } = {}
): Promise<CanvasSnapshotPayload> {
  const base = normalizeBaseUrl(baseUrl)
  const get = <T>(path: string, params?: Record<string, string | number | string[]>) =>
    fetchAll<T>(base, token, path, params ?? {}, options)

  const courses = await get<CanvasCourse>("/api/v1/courses", {
    enrollment_state: "active",
    "include[]": ["term", "concluded"],
    // Canvas defines this argument as `state[]`; a bare `state=` is ignored.
    "state[]": ["available", "completed", "unpublished"],
  })

  const byCourse: Record<string, CanvasCourseBundle> = {}
  for (const course of courses) {
    const id = String(course.id)
    const c = `/api/v1/courses/${id}`
    byCourse[id] = {
      assignmentGroups: await get<CanvasAssignmentGroup>(`${c}/assignment_groups`),
      assignments: await get<CanvasAssignment>(`${c}/assignments`),
      submissions: await get<CanvasSubmission>(`${c}/students/submissions`, {
        "student_ids[]": ["self"],
      }),
      files: await get<CanvasFile>(`${c}/files`),
      modules: await get<CanvasModule>(`${c}/modules`),
      pages: await get<CanvasPage>(`${c}/pages`),
      announcements: await get<CanvasDiscussionTopic>("/api/v1/announcements", {
        "context_codes[]": [`course_${id}`],
      }),
    }
  }

  return {
    kind: "canvas",
    baseUrl: base,
    fetchedAt: (options.now ?? Date.now)(),
    courses,
    byCourse,
  }
}
