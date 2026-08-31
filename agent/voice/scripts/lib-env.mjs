import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Minimal .env.local reader so the spike scripts run as plain node. */
export function loadEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
  let raw = ""
  try {
    raw = readFileSync(join(root, ".env.local"), "utf8")
  } catch {
    return
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}
