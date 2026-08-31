/**
 * Outbound-URL guardrails, shared by everything that fetches a URL a student
 * (or a remote server) supplied: `sources.add` validation, and the Canvas
 * client's pagination follower — a `rel="next"` link comes from the *response*
 * and gets the bearer token attached, so it is the same SSRF surface as the
 * configured base URL (CR 3897465401).
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"])

/** Private / loopback / link-local / CGNAT IPv4, given the four octets. */
const isBlockedV4 = (a: number, b: number): boolean =>
  a === 10 ||
  a === 127 ||
  a === 0 ||
  (a === 192 && b === 168) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 169 && b === 254) || // link-local, incl. cloud metadata
  (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64.0.0/10

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true
  // IPv4 literals. WHATWG URL already canonicalizes decimal/octal/hex forms
  // (`2130706433`, `0177.0.0.1`, `0x7f.0.0.1`) into dotted-quad, so matching
  // the dotted form here covers the obfuscated spellings too.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) return isBlockedV4(Number(v4[1]), Number(v4[2]))
  // IPv4-mapped IPv6 (`::ffff:10.0.0.1`, or hex `::ffff:7f00:1`): unwrap and
  // re-check as IPv4 — the mapped form reaches the same socket.
  const mapped = /^::ffff:(.+)$/.exec(host)
  if (mapped) {
    const inner = mapped[1]
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(inner)
    if (dotted) return isBlockedV4(Number(dotted[1]), Number(dotted[2]))
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      return isBlockedV4(hi >> 8, hi & 0xff)
    }
    return true // unparseable mapped form: refuse rather than guess
  }
  // IPv6 loopback / link-local / unique-local — gated on a colon, which after
  // URL normalization only an IPv6 literal contains. Without the gate, public
  // DNS names starting "fc"/"fd" (fcps.instructure.com, fdu.edu) would be
  // rejected with no workaround (CR 3897559085).
  if (host.includes(":")) {
    if (host === "::" || host.startsWith("fe80:")) return true
    if (host.startsWith("fc") || host.startsWith("fd")) return true
  }
  return false
}

/** Throws `400: …` unless `raw` is an absolute, public http(s) URL. */
export function requireFetchableUrl(label: string, raw: unknown): void {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`400: ${label} must be a URL`)
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`400: ${label} must be an absolute URL`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`400: ${label} must be http(s), not ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error(`400: ${label} must not embed credentials`)
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error(`400: ${label} must not point at a private or loopback host`)
  }
}
