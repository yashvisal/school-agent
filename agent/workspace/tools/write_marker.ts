import { defineTool } from "eve/tools"
import { z } from "zod"

/**
 * Spike B isolation probe: write a session-scoped marker file into /workspace
 * and report the sandbox id that owns it. Two sessions must never see each
 * other's marker.
 */
export default defineTool({
  description:
    "Write a session-scoped marker file into the workspace and report the sandbox id.",
  inputSchema: z.object({
    note: z.string().max(200).default("spike-b"),
  }),
  async execute({ note }, ctx) {
    const sandbox = await ctx.getSandbox()
    const path = `marker-${ctx.session.id}.txt`
    await sandbox.writeTextFile({
      path,
      content: `${note}\nsessionId=${ctx.session.id}\nsandboxId=${sandbox.id}\nat=${new Date().toISOString()}\n`,
    })
    return { path, sandboxId: sandbox.id, sessionId: ctx.session.id }
  },
})
