import type { NextConfig } from "next"
import { withEve } from "eve/next"

const nextConfig: NextConfig = {}

// Named eve agents mount at /eve/agents/<name>/eve/v1/*.
// Voice adds `voice: "./agent/voice"` here when Spike A lands — same shape,
// one entry per agent (agent/ is the eve project root per vision §10).
export default withEve(nextConfig, {
  agents: {
    workspace: "./agent/workspace",
  },
})
