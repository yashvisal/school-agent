import type { NextConfig } from "next"
import { withEve } from "eve/next"

const nextConfig: NextConfig = {}

// Two eve agents, one Next app (vision §10). Named agents mount under
// `/eve/agents/<name>/eve/v1/*`.
export default withEve(nextConfig, {
  agents: {
    voice: "./agent/voice",
    workspace: "./agent/workspace",
  },
})
