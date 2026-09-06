import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "edge-runtime",
    // `agent/**` is here for the pure input-schema tests on the Voice tools —
    // the zod boundary the model hits before Core does. Nothing under `agent/`
    // that needs a live gateway belongs in `pnpm test`; those are `.eval.ts`
    // files run by eve's own runner.
    include: ["convex/**/*.test.ts", "evals/**/*.test.ts", "agent/**/*.test.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
})
