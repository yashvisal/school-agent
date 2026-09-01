import { describe, expect, test } from "vitest"

import { concatPages, discoverLinks, MAX_SITE_PAGES } from "./siteLinks"

/**
 * Which links a course-site scrape follows.
 *
 * This is a security boundary as much as a relevance one: the links come out of
 * a page WE did not write, and each one becomes a server-side fetch. Same-origin
 * plus `requireFetchableUrl` is what keeps a hand-edited course page from
 * pointing our backend at cloud metadata (`lib/net.ts`).
 */

const seed = "https://cs.example.edu/213/index.html"

const md = (...links: string[]) => links.join("\n\n")
const link = (text: string, href: string) => `[${text}](${href})`

describe("discoverLinks", () => {
  test("picks the pages that carry dates, most promising first", () => {
    const found = discoverLinks(
      md(
        link("Home", "/213/"),
        link("Course staff", "/213/staff.html"),
        link("Schedule", "/213/schedule.html"),
        link("Assignments and due dates", "/213/assignments.html")
      ),
      seed
    )
    // "Assignments and due dates" hits three keywords, "Schedule" one.
    expect(found[0]).toBe("https://cs.example.edu/213/assignments.html")
    expect(found).toContain("https://cs.example.edu/213/schedule.html")
    // An unremarkable link is skipped entirely — the budget is four pages, so
    // queueing "staff" behind the good ones would be spending it on nothing.
    expect(found).not.toContain("https://cs.example.edu/213/staff.html")
  })

  test("never leaves the seed's origin", () => {
    const found = discoverLinks(
      md(
        link("Schedule", "https://evil.example.com/213/schedule.html"),
        link("Calendar", "http://cs.example.edu/213/calendar.html")
      ),
      seed
    )
    // Different host AND different scheme are both different origins.
    expect(found).toEqual([])
  })

  test("a same-origin link at a blocked host cannot get through", () => {
    // Belt and braces: if the seed itself were on a private host, same-origin
    // would happily follow it deeper.
    expect(
      discoverLinks(link("Schedule", "/schedule.html"), "http://169.254.169.254/x")
    ).toEqual([])
  })

  test("fragments and self-links are not a second page", () => {
    expect(discoverLinks(link("Schedule", "#schedule"), seed)).toEqual([])
    expect(discoverLinks(link("Schedule", "/213/index.html"), seed)).toEqual([])
  })

  test("binaries and feeds are skipped — a markdown scrape cannot use them", () => {
    const found = discoverLinks(
      md(
        link("Syllabus (PDF)", "/213/syllabus.pdf"),
        link("Calendar feed", "/213/schedule.ics"),
        link("Syllabus", "/213/syllabus.html")
      ),
      seed
    )
    expect(found).toEqual(["https://cs.example.edu/213/syllabus.html"])
  })

  test("the same page linked twice is scraped once", () => {
    const found = discoverLinks(
      md(link("Schedule", "/213/schedule.html"), link("Due dates", "/213/schedule.html")),
      seed
    )
    expect(found).toEqual(["https://cs.example.edu/213/schedule.html"])
  })

  test("a malformed seed yields nothing rather than throwing mid-scrape", () => {
    expect(discoverLinks(link("Schedule", "/schedule.html"), "not a url")).toEqual([])
  })

  test("the page budget stays small", () => {
    expect(MAX_SITE_PAGES).toBe(4)
  })
})

describe("concatPages", () => {
  test("marks every page with its url, which becomes the deadline's pageRef", () => {
    const joined = concatPages([
      { url: "https://a.example/1", markdown: "# one" },
      { url: "https://a.example/2", markdown: "# two" },
    ])
    expect(joined).toContain("page: https://a.example/1")
    expect(joined).toContain("page: https://a.example/2")
    expect(joined.indexOf("# one")).toBeLessThan(joined.indexOf("page: https://a.example/2"))
  })
})
