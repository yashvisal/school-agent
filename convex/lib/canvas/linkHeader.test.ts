import { describe, expect, test } from "vitest"

import pagination from "../../../fixtures/canvas/pagination.json"
import { nextPageUrl, parseLinkHeader } from "./linkHeader"

/**
 * Canvas pagination is the thing most likely to bite on the live-validation
 * pass (plans/live-validation.md), so the parser is pinned against the header
 * samples in `fixtures/canvas/pagination.json`.
 */

describe("parseLinkHeader", () => {
  test("reads every rel on a first page", () => {
    const links = parseLinkHeader(pagination.firstPage)
    expect(links.current).toBe(
      "https://canvas.example.edu/api/v1/courses/1002/assignments?page=1&per_page=100"
    )
    expect(links.next).toBe(
      "https://canvas.example.edu/api/v1/courses/1002/assignments?page=2&per_page=100"
    )
    expect(links.first).toContain("page=1")
    expect(links.last).toContain("page=3")
    expect(links.prev).toBeUndefined()
  })

  test("reads prev and next on a middle page", () => {
    const links = parseLinkHeader(pagination.middlePage)
    expect(links.prev).toContain("page=1")
    expect(links.next).toContain("page=3")
  })

  test("a last page has no next", () => {
    expect(nextPageUrl(pagination.lastPage)).toBeUndefined()
    expect(nextPageUrl(pagination.noNext)).toBeUndefined()
  })

  test("bookmark cursors survive verbatim", () => {
    expect(nextPageUrl(pagination.bookmarkStyle)).toBe(
      "https://canvas.example.edu/api/v1/courses/1002/students/submissions?page=bookmark:WyIxMDAyIiwxXQ&per_page=100"
    )
  })

  test("tolerates unquoted rel values and stray whitespace", () => {
    const links = parseLinkHeader(pagination.spacedAndUnquoted)
    expect(links.next).toBe(
      "https://canvas.example.edu/api/v1/courses/1002/files?page=2&per_page=100"
    )
    expect(links.current).toContain("page=1")
  })

  test("no header, empty header, and junk all mean no pages", () => {
    expect(parseLinkHeader(null)).toEqual({})
    expect(parseLinkHeader("")).toEqual({})
    expect(parseLinkHeader("not a link header")).toEqual({})
    expect(nextPageUrl(undefined)).toBeUndefined()
  })

  test("a next that points at the current page is not followed", () => {
    const header =
      '<https://x/api?page=3>; rel="current",<https://x/api?page=3>; rel="next"'
    expect(parseLinkHeader(header).next).toBe("https://x/api?page=3")
    expect(nextPageUrl(header)).toBeUndefined()
  })
})
