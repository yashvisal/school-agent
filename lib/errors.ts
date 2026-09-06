/**
 * Convex throws its handler errors back to the client wrapped in a request id,
 * a "Server Error" line and a server stack trace. The message Core wrote —
 * `400: phone is not a usable number`, `409: phone already in use` — is the
 * only part a student can act on, and Core writes those deliberately (they are
 * the documented contract in `lib/data/README.md`), so surface exactly that
 * line rather than a house-style paraphrase that would drift from it.
 */
function thrownLine(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const thrown = raw.match(/Uncaught (?:Convex)?Error:\s*(.*)/)
  return (thrown?.[1] ?? raw.split("\n")[0] ?? raw)
    .trim()
    .replace(/^\[Request ID: [^\]]+\]\s*/, "")
}

export function errorMessage(cause: unknown): string {
  // Strip the numeric status Core prefixes for the caller's benefit; "400: "
  // in front of a sentence is noise to the person reading it.
  return thrownLine(cause).replace(/^\d{3}:\s*/, "")
}

/**
 * The status Core prefixed, when it prefixed one. Not every error is a failure
 * the UI should paint red: a `429` from `sources.resync` means the button was
 * pressed inside its cooldown, which is information, not a broken source.
 */
export function errorStatus(cause: unknown): number | undefined {
  const code = thrownLine(cause).match(/^(\d{3}):\s*/)?.[1]
  return code ? Number(code) : undefined
}
