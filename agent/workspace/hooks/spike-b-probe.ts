import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineHook } from "eve/hooks"

/**
 * Spike B #1 probe — DEV/TEST ONLY, off unless `SPIKE_B_PROBE=1`.
 *
 * Exercises the same runtime seam a tool would (`ctx.getSandbox()` inside an
 * authored callback bound to the durable session), but without a model call —
 * so per-session sandbox isolation can be proven while the AI Gateway account
 * is unusable, and at zero token cost.
 *
 * It reacts to directives embedded in the inbound message text and appends one
 * NDJSON record per observation to `$TMPDIR/spike-b-probe.ndjson`, which
 * `scripts/spike-b-isolation.mts` reads.
 *
 * Directives: SPIKE_B_MARK | SPIKE_B_LIST | SPIKE_B_DELETE | SPIKE_B_STOP
 *
 * Delete this file once the gateway works and the tool-driven path in
 * `scripts/spike-b-isolation.mts` is the live evidence.
 */

const ENABLED = process.env.SPIKE_B_PROBE === "1"
const OUT_PATH = process.env.SPIKE_B_PROBE_OUT ?? join(tmpdir(), "spike-b-probe.ndjson")

function record(row: Record<string, unknown>): void {
  appendFileSync(OUT_PATH, `${JSON.stringify(row)}\n`, "utf8")
}

export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (!ENABLED) return

      const text = event.data.message
      const sessionId = ctx.session.id

      try {
        const sandbox = await ctx.getSandbox()
        const sandboxId = sandbox.id
        const actions: string[] = []

        if (text.includes("SPIKE_B_DELETE")) {
          await sandbox.delete()
          actions.push("delete")
          record({ sessionId, sandboxId, actions, note: "deleted; re-open below" })
          // Re-open: eve provisions a fresh sandbox and reruns onSession.
          const fresh = await ctx.getSandbox()
          const freshLs = await fresh.run({ command: "ls -1 /workspace" })
          record({
            sessionId,
            sandboxId: fresh.id,
            actions: ["reopen-after-delete"],
            files: freshLs.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
          })
          return
        }

        if (text.includes("SPIKE_B_MARK")) {
          await sandbox.writeTextFile({
            path: `marker-${sessionId}.txt`,
            content: `sessionId=${sessionId}\nsandboxId=${sandboxId}\nat=${new Date().toISOString()}\n`,
          })
          actions.push("mark")
        }

        if (text.includes("SPIKE_B_STOP")) {
          await sandbox.stop()
          actions.push("stop")
          record({ sessionId, sandboxId, actions })
          return
        }

        const ls = await sandbox.run({ command: "ls -1 /workspace" })
        record({
          sessionId,
          sandboxId,
          actions: [...actions, "list"],
          files: ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
          exitCode: ls.exitCode,
        })
      } catch (error) {
        record({ sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    },
  },
})
