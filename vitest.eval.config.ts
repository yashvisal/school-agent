import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { defineConfig } from "vitest/config"

/**
 * The LIVE extraction evals — separate from `vitest.config.ts` on purpose.
 *
 * `pnpm test` must stay hermetic: no network, no gateway key, no per-run cost,
 * and deterministic enough to gate a merge. `pnpm eval` is the opposite — it
 * calls the real model through the AI Gateway on the checked-in fixtures and
 * reports precision/recall. Two configs, because one of them is CI's gate and
 * the other is a measurement.
 *
 * Environment differs too: these run in Node (the AI SDK's habitat), not the
 * edge-runtime VM convex-test needs, and they get a long timeout because a real
 * model call on a 200-line document is not a millisecond operation.
 */

/**
 * `.env.local` → `test.env`, without a `dotenv` dependency.
 *
 * Next.js loads `.env.local` for the app and `npx convex env` holds the
 * deployment's copy, but a bare `vitest run` has neither, so the key would
 * simply be absent and every eval would "pass" by skipping. Deliberately narrow:
 * `KEY=value`, `#` comments, optional surrounding quotes. Anything fancier
 * belongs in a real env, not in a test harness.
 */
function loadDotEnvLocal(): Record<string, string> {
  const path = join(process.cwd(), ".env.local")
  if (!existsSync(path)) return {}
  const env: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match || line.trimStart().startsWith("#")) continue
    env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
  }
  return env
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    env: { ...loadDotEnvLocal(), ...process.env } as Record<string, string>,
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // One fixture at a time: the gateway is a shared, rate-limited resource and
    // a parallel burst is the fastest way to turn a green eval into a 429.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
})
