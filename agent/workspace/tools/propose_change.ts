import { defineTool } from "eve/tools"
import { always } from "eve/tools/approval"
import { z } from "zod"

/**
 * Propose a deadline fact fix.
 *
 * Convex is the only truth (vision §10): this tool must never persist anything
 * in eve. It returns the change envelope the Face harness renders as an
 * approval card + diff table; Core writes the row.
 *
 * `approval: always()` — a change is a user-impacting, externally-visible
 * mutation. It parks the turn at `input.requested` / `session.waiting` until a
 * person answers, which is also what makes the write safe across step replays.
 */
export default defineTool({
  description:
    "Propose a change to a deadline fact for this course. Requires human approval. Use only when a source in the workspace contradicts state.md.",
  inputSchema: z.object({
    kind: z.enum(["deadline_moved", "deadline_added", "deadline_removed"]),
    title: z.string().min(1).max(200),
    before: z.string().max(400).optional(),
    after: z.string().max(400).optional(),
    reason: z.string().min(1).max(600),
  }),
  approval: always(),
  async execute(input) {
    // TODO(core): call convex changes.propose (mutation) with this envelope and
    // return the persisted change id. Nothing durable about a student may live
    // in eve — this stub deliberately writes nowhere.
    return {
      ok: true as const,
      change: {
        ...input,
        tier: "needs_approval" as const,
        status: "pending" as const,
      },
    }
  },
})
