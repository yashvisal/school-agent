import { describe, expect, test } from "vitest"

import { redactConfig, validateSourceConfig } from "./sources"

/**
 * `sources.add` is the one public write path that hands the backend a URL it
 * will later fetch *from the server* — with a Canvas bearer token attached, and
 * with the response body stored in `snapshots`. So the per-kind shape check is
 * a security boundary, not a nicety.
 */

const accepts = (kind: string, config: unknown) =>
  expect(() => validateSourceConfig(kind, config)).not.toThrow()

const rejects = (kind: string, config: unknown, match?: RegExp) =>
  expect(() => validateSourceConfig(kind, config)).toThrow(match ?? /^400:/)

describe("ical config", () => {
  test("an absolute http(s) feed url is accepted", () => {
    accepts("ical", { url: "https://canvas.example.edu/feeds/calendars/u.ics" })
    accepts("ical", { url: "http://calendars.example.edu/u.ics" })
  })

  test("fixture mode needs no url at all", () => {
    accepts("ical", { mode: "fixture" })
    accepts("canvas", { mode: "fixture" })
  })

  test("a missing, relative, or non-http url is rejected", () => {
    rejects("ical", {})
    rejects("ical", { url: "" })
    rejects("ical", { url: "/feeds/u.ics" })
    rejects("ical", { url: "file:///etc/passwd" })
    rejects("ical", { url: 42 })
  })

  test("private, loopback and link-local hosts are rejected", () => {
    for (const url of [
      "http://localhost:3210/u.ics",
      "http://127.0.0.1/u.ics",
      "https://10.0.0.5/u.ics",
      "https://192.168.1.9/u.ics",
      "https://172.20.3.4/u.ics",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://[::1]/u.ics",
      "https://printer.local/u.ics",
    ]) {
      rejects("ical", { url }, /private or loopback/)
    }
  })

  test("embedded credentials are rejected", () => {
    rejects("ical", { url: "https://user:pw@feeds.example.edu/u.ics" }, /credentials/)
  })
})

describe("canvas config", () => {
  test("a base url plus a token is accepted", () => {
    accepts("canvas", { baseUrl: "https://canvas.example.edu", token: "tok" })
  })

  test("a base url with no token is rejected", () => {
    rejects("canvas", { baseUrl: "https://canvas.example.edu" }, /token/)
    rejects("canvas", { baseUrl: "https://canvas.example.edu", token: "  " }, /token/)
  })

  test("a private base url is rejected even with a token", () => {
    rejects("canvas", { baseUrl: "http://127.0.0.1:3000", token: "tok" })
  })
})

describe("unsupported kinds", () => {
  test("a kind with no adapter is refused rather than silently stored", () => {
    rejects("syllabus", { url: "https://x.example/s.pdf" }, /does not accept kind/)
    rejects("site", {}, /does not accept kind/)
  })
})

describe("redaction", () => {
  test("secrets never leave the server, but their presence does", () => {
    expect(redactConfig({ baseUrl: "https://x", token: "secret" })).toEqual({
      baseUrl: "https://x",
      token: "[set]",
    })
    expect(redactConfig({ token: "" })).toEqual({ token: null })
  })
})
