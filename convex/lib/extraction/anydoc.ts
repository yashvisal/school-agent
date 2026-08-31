"use node"

/**
 * Uploaded document → markdown, locally.
 *
 * core.md "Stack": **AnyDoc** (Firecrawl's MIT Rust library with Node bindings,
 * no API key) for all uploaded documents — "student documents never leave our
 * infra". That is the whole reason this is a local native binding rather than a
 * hosted parse API: a syllabus is a student's document, and shipping it to a
 * third party to read is not a tradeoff we get to make quietly.
 *
 * AnyDoc is a NAPI package with per-platform binaries, so it is declared in
 * `convex.json` under `node.externalPackages` and imported dynamically — a
 * static import would pull the native binding into every bundle that merely
 * type-checks this module.
 *
 * The converter is injectable (`DocToMarkdown`) so the adapters can be driven
 * from markdown fixtures with no native binding present, which is what the
 * deterministic test layer does.
 */

export type DocToMarkdown = (bytes: Uint8Array, filename?: string) => Promise<string>

/** Formats AnyDoc cannot infer from content alone need the extension. */
const FORMAT_BY_EXTENSION: Record<string, string> = {
  csv: "csv",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
}

const extensionOf = (filename?: string): string | undefined => {
  const match = /\.([a-z0-9]+)$/i.exec(filename ?? "")
  return match ? match[1].toLowerCase() : undefined
}

/** Text formats AnyDoc has nothing to do to — decoded here rather than shipped out. */
const PASSTHROUGH = new Set(["markdown", "text"])

export const anydocToMarkdown: DocToMarkdown = async (bytes, filename) => {
  const format = FORMAT_BY_EXTENSION[extensionOf(filename) ?? ""]
  if (format && PASSTHROUGH.has(format)) {
    return new TextDecoder().decode(bytes)
  }

  const { toMarkdownBytes } = await import("@firecrawl/anydoc")
  try {
    return await toMarkdownBytes(bytes, (format as never) ?? null)
  } catch (error) {
    // AnyDoc puts a `ConvertErrorCode` on `code`. `needsOcr` is the one worth
    // naming to the student: it means a scanned syllabus, which core.md says
    // falls back to a vision-capable model — a follow-up, not a failure the
    // student can act on by re-uploading the same file.
    const code = (error as { code?: string } | null)?.code
    if (code === "needsOcr") {
      throw new Error(
        "This document is a scan with no text layer, so it can't be read as text. " +
          "Upload it as an image instead, or send a text/PDF version."
      )
    }
    throw new Error(
      `Could not convert this document to text${code ? ` (${code})` : ""}: ` +
        (error instanceof Error ? error.message : String(error))
    )
  }
}
