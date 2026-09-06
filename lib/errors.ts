/**
 * Convex throws its handler errors back to the client wrapped in a request id,
 * a "Server Error" line and a server stack trace. The message Core wrote —
 * `400: phone is not a usable number`, `409: phone already in use` — is the
 * only part a student can act on, and Core writes those deliberately (they are
 * the documented contract in `lib/data/README.md`), so surface exactly that
 * line rather than a house-style paraphrase that would drift from it.
 */
export function errorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const thrown = raw.match(/Uncaught (?:Convex)?Error:\s*(.*)/)
  const line = (thrown?.[1] ?? raw.split("\n")[0] ?? raw).trim()
  // Strip the numeric status Core prefixes for the caller's benefit; "400: "
  // in front of a sentence is noise to the person reading it.
  return line.replace(/^\[Request ID: [^\]]+\]\s*/, "").replace(/^\d{3}:\s*/, "")
}
