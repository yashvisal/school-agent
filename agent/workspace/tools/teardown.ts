import { defineTool } from "eve/tools"
import { z } from "zod"

/**
 * Spike B probe for teardown semantics (vision §10 cost posture: sandboxes are
 * ephemeral and stopped promptly — memory bills wall-clock).
 *
 * `stop()` releases compute; the next `ctx.getSandbox()` reattaches the same
 * filesystem. `delete()` destroys the sandbox and its disposable state; the
 * next `ctx.getSandbox()` provisions a fresh workspace and reruns `onSession`.
 */
export default defineTool({
  description:
    "Tear down this session's sandbox. mode=stop releases compute (filesystem survives); mode=delete destroys the workspace and re-hydrates on next use.",
  inputSchema: z.object({
    mode: z.enum(["stop", "delete"]),
  }),
  async execute({ mode }, ctx) {
    const sandbox = await ctx.getSandbox()
    const sandboxId = sandbox.id
    if (mode === "delete") {
      await sandbox.delete()
    } else {
      await sandbox.stop()
    }
    return { mode, sandboxId, sessionId: ctx.session.id }
  },
})
