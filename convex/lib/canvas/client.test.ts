import { describe, expect, test } from "vitest"

import { CanvasError, fetchAll, fetchCanvasSnapshot, type FetchFn } from "./client"

/**
 * The fetch layer is the one part of the Canvas adapter that cannot be tested
 * against real behaviour until a token arrives (plans/live-validation.md). It
 * is therefore kept thin and fully injectable — these tests drive it through a
 * fake transport that mimics the documented pagination and throttling headers.
 */

type Page = { status?: number; body: unknown; link?: string; headers?: Record<string, string> }

function transport(pages: Record<string, Page>) {
  const calls: string[] = []
  const fetchFn: FetchFn = async (url) => {
    calls.push(url)
    const page = pages[url] ?? { status: 404, body: { errors: ["not found"] } }
    const headers: Record<string, string> = { ...(page.headers ?? {}) }
    if (page.link) headers.Link = page.link
    return {
      status: page.status ?? 200,
      headers: { get: (name: string) => headers[name] ?? null },
      text: async () => JSON.stringify(page.body),
    }
  }
  return { fetchFn, calls }
}

const noSleep = async () => {}

describe("fetchAll", () => {
  test("adds per_page and follows rel=next until it runs out", async () => {
    const p1 = "https://canvas.example.edu/api/v1/courses/1/assignments?per_page=100"
    const p2 = "https://canvas.example.edu/api/v1/courses/1/assignments?page=2&per_page=100"
    const { fetchFn, calls } = transport({
      [p1]: { body: [{ id: 1 }, { id: 2 }], link: `<${p2}>; rel="next"` },
      [p2]: { body: [{ id: 3 }] },
    })

    const rows = await fetchAll<{ id: number }>(
      "https://canvas.example.edu/",
      "tok",
      "/api/v1/courses/1/assignments",
      {},
      { fetchFn, sleep: noSleep }
    )

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3])
    expect(calls).toEqual([p1, p2])
  })

  test("array params repeat the key, the way Canvas expects", async () => {
    const url =
      "https://canvas.example.edu/api/v1/courses/1/students/submissions?student_ids%5B%5D=self&per_page=100"
    const { fetchFn, calls } = transport({ [url]: { body: [] } })
    await fetchAll(
      "https://canvas.example.edu",
      "tok",
      "/api/v1/courses/1/students/submissions",
      { "student_ids[]": ["self"] },
      { fetchFn, sleep: noSleep }
    )
    expect(calls[0]).toContain("student_ids%5B%5D=self")
  })

  test("sends the bearer token", async () => {
    let seen: Record<string, string> = {}
    const fetchFn: FetchFn = async (_url, init) => {
      seen = init.headers
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => "[]",
      }
    }
    await fetchAll("https://x", "secret-token", "/api/v1/courses", {}, { fetchFn })
    expect(seen.Authorization).toBe("Bearer secret-token")
  })

  test("a rel=next loop is bounded, not infinite", async () => {
    const url = "https://canvas.example.edu/api/v1/x?per_page=100"
    const { fetchFn, calls } = transport({
      [url]: { body: [{ id: 1 }], link: `<${url}>; rel="next"` },
    })
    const rows = await fetchAll("https://canvas.example.edu", "t", "/api/v1/x", {}, {
      fetchFn,
      sleep: noSleep,
    })
    expect(rows).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  test("retries a 429 and then succeeds", async () => {
    let attempt = 0
    const delays: number[] = []
    const fetchFn: FetchFn = async () => {
      attempt++
      if (attempt < 3) {
        return {
          status: 429,
          headers: { get: () => null },
          text: async () => "Rate Limit Exceeded",
        }
      }
      return { status: 200, headers: { get: () => null }, text: async () => "[{}]" }
    }
    const rows = await fetchAll("https://x", "t", "/api/v1/x", {}, {
      fetchFn,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(rows).toHaveLength(1)
    expect(delays).toEqual([500, 1000])
  })

  test("honours Retry-After when Canvas supplies one", async () => {
    let attempt = 0
    const delays: number[] = []
    const fetchFn: FetchFn = async () => {
      attempt++
      if (attempt === 1) {
        return {
          status: 429,
          headers: { get: (n: string) => (n === "Retry-After" ? "3" : null) },
          text: async () => "",
        }
      }
      return { status: 200, headers: { get: () => null }, text: async () => "[]" }
    }
    await fetchAll("https://x", "t", "/api/v1/x", {}, {
      fetchFn,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(delays).toEqual([3000])
  })

  test("backs off pre-emptively when the quota runs low", async () => {
    const delays: number[] = []
    const fetchFn: FetchFn = async () => ({
      status: 200,
      headers: {
        get: (n: string) => (n === "X-Rate-Limit-Remaining" ? "12" : null),
      },
      text: async () => "[]",
    })
    await fetchAll("https://x", "t", "/api/v1/x", {}, {
      fetchFn,
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(delays).toEqual([1000])
  })

  test("a 401 is a CanvasError carrying the status, not a silent empty page", async () => {
    const fetchFn: FetchFn = async () => ({
      status: 401,
      headers: { get: () => null },
      text: async () => '{"errors":[{"message":"Invalid access token."}]}',
    })
    await expect(
      fetchAll("https://x", "bad", "/api/v1/courses", {}, { fetchFn, sleep: noSleep })
    ).rejects.toBeInstanceOf(CanvasError)
  })
})

describe("fetchCanvasSnapshot", () => {
  test("walks courses then everything per course", async () => {
    const seen: string[] = []
    const fetchFn: FetchFn = async (url) => {
      seen.push(new URL(url).pathname)
      const body = url.includes("/api/v1/courses?") ? [{ id: 1002, name: "CS201" }] : []
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      }
    }

    const payload = await fetchCanvasSnapshot("https://canvas.example.edu", "tok", {
      fetchFn,
      sleep: noSleep,
      now: () => 1_700_000_000_000,
    })

    expect(payload.kind).toBe("canvas")
    expect(payload.baseUrl).toBe("https://canvas.example.edu")
    expect(payload.fetchedAt).toBe(1_700_000_000_000)
    expect(payload.courses).toHaveLength(1)
    expect(Object.keys(payload.byCourse)).toEqual(["1002"])
    expect(seen).toEqual([
      "/api/v1/courses",
      "/api/v1/courses/1002/assignment_groups",
      "/api/v1/courses/1002/assignments",
      "/api/v1/courses/1002/students/submissions",
      "/api/v1/courses/1002/files",
      "/api/v1/courses/1002/modules",
      "/api/v1/courses/1002/pages",
      "/api/v1/announcements",
    ])
  })
})
