import { defineTool } from "eve/tools"
import { z } from "zod"

/**
 * Spike B isolation probe: list everything under /workspace plus the owning
 * sandbox id, so a caller can assert one session cannot see another's files.
 */
export default defineTool({
  description: "List the files in this session's /workspace and report the sandbox id.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const sandbox = await ctx.getSandbox()
    const result = await sandbox.run({ command: "ls -1a /workspace" })
    const files = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "." && line !== "..")
    return {
      sandboxId: sandbox.id,
      sessionId: ctx.session.id,
      files,
      exitCode: result.exitCode,
    }
  },
})
