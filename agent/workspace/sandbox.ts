import { defaultBackend, defineSandbox } from "eve/sandbox"
import type { SandboxBackend } from "eve/sandbox"
import { vercel } from "eve/sandbox/vercel"

/**
 * One sandbox per *durable session* — i.e. per workspace session
 * (student × course). vision §10: "Isolation is non-negotiable."
 *
 * Mechanism (eve 0.47): session sandboxes are keyed per durable session, not
 * per agent and not per deployment. `onSession` runs once per session (and
 * again when the sandbox definition changes), and `sandbox.id` is a stable
 * per-session identifier. See `agent/workspace/README.md` for the Spike B
 * evidence.
 *
 * Network policy is set on the **factory**, not only in `onSession`: a
 * provider-loss replacement reuses the same sandbox key and does *not* rerun
 * `onSession`, so factory config is the only place a security-critical
 * baseline reliably holds (eve docs, sandbox.mdx "Network policy").
 */
/**
 * Production runs on Vercel, where `defaultBackend()` resolves to Vercel
 * Sandbox. Set `EVE_SANDBOX_BACKEND=vercel` to pin that backend from local dev
 * too (creates real hosted sandboxes; needs Vercel credentials) when you want
 * to re-run the Spike B evidence against the production backend.
 */
const backend = (
  process.env.EVE_SANDBOX_BACKEND === "vercel"
    ? vercel({ networkPolicy: "deny-all" })
    : defaultBackend({
        vercel: { networkPolicy: "deny-all" },
        docker: { networkPolicy: "deny-all" },
        // just-bash has no network to deny; it is the local dev fallback only.
      })
) as SandboxBackend

export default defineSandbox({
  description: "Per-session course workspace (student × course), deny-all egress.",
  backend,

  // NOTE: `use` is not destructured — eslint's react-hooks/rules-of-hooks reads a
  // bare `use(...)` call as the React hook.
  async onSession(input) {
    const { ctx } = input
    const sandbox = await input.use()
    const principal = ctx.session.auth.current

    // Staleness is explicit (face.md, "Workspace filesystem = materialized view",
    // rule 3): every hydration is timestamped and the session records who it
    // was hydrated for.
    const lines = [
      "# workspace session",
      "",
      `sessionId: ${ctx.session.id}`,
      `sandboxId: ${sandbox.id}`,
      `principal: ${principal ? `${principal.authenticator}:${principal.principalId}` : "anonymous"}`,
      `hydratedAt: ${new Date().toISOString()}`,
      "",
      "This filesystem is a materialized view of Convex. It is always rebuildable;",
      "delete + re-hydrate is lossless. Nothing durable about the student lives here.",
      "",
    ].join("\n")

    await sandbox.writeTextFile({ path: "SESSION.md", content: lines })

    // TODO(core, Spike B #3): hydrateWorkspace(studentId, courseId) goes here —
    // resolve studentId from `principal` and courseId from session context, then
    // write `state.md` (deadlines / grading / plan), `signals.md`
    // (studentSignals digest) and a materials manifest from Convex queries.
    // Not in scope for Spike B #1. Convex stays the only truth; nothing written
    // here is authoritative.
  },
})
