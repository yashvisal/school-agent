"use client"

import { Agentation } from "agentation"
import { DialRoot } from "dialkit"
import "dialkit/styles.css"

/**
 * Development-only UI tooling (see CLAUDE.md "UI tooling"):
 * - Agentation: click-to-annotate toolbar; annotations sync to the coding agent via the
 *   agentation MCP server (port 4747). The founder marks up UI in the browser; the agent
 *   reads, fixes, and resolves.
 * - DialKit: live parameter panel for `useDialKit()` calls; tune spacing/motion/colour in
 *   the browser, then bake the chosen values into code.
 * Renders nothing in production.
 */
export function DevTools() {
  if (process.env.NODE_ENV !== "development") return null
  return (
    <>
      <Agentation endpoint="http://localhost:4747" />
      <DialRoot />
    </>
  )
}
