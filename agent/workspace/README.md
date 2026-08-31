# `agent/workspace` — the course workspace agent

The Milestone-3 agent behind a course workspace (vision §10, plans/face.md).
Separate eve agent from Voice (`agent/voice`): its own instructions, tools,
sandbox, channel, hooks, evals and traces. **Scope is enforced by tool
availability, not by prompt** — there are no planning tools here and there never
will be. "What should I do / when" is a thread question.

Mounted by `next.config.ts` via
`withEve(nextConfig, { agents: { workspace: "./agent/workspace" } })`, so it
serves at `/eve/agents/workspace/eve/v1/*` on the Next.js origin.

## Layout

| Path                      | What it is                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `agent.ts`                | `defineAgent` — model (`anthropic/claude-haiku-4.5` while de-risking) + per-session token limits. |
| `instructions.md`         | Scope: course materials + `state.md` only. Explicit "no planning" rule.                          |
| `sandbox.ts`              | `defineSandbox` — per-session workspace, `onSession` writes `SESSION.md`, deny-all egress.        |
| `tools/write_marker.ts`   | Spike B probe: write `marker-<sessionId>.txt`, return `sandbox.id`.                               |
| `tools/list_workspace.ts` | Spike B probe: list `/workspace`, return `sandbox.id`.                                            |
| `tools/teardown.ts`       | Spike B probe: `sandbox.stop()` / `sandbox.delete()`.                                             |
| `tools/propose_change.ts` | The real seam: `approval: always()`, returns a pending change envelope. **Stub** — see below.     |
| `tools/agent.ts`          | `disableTool()` — no subagent delegation from the workspace agent.                                |
| `channels/eve.ts`         | Route auth for `/eve/v1/*`. Fail-closed; Clerk verifier still TODO.                               |
| `hooks/usage.ts`          | Logs per-step model usage. **Stub** — must write to the Convex `usage` table.                     |
| `hooks/spike-b-probe.ts`  | Test-only, off unless `SPIKE_B_PROBE=1`. Delete once agent-mode evidence is live.                 |
| `package.json`            | Created by `eve dev` when it auto-installed the optional `just-bash` peer dep.                    |

## Run it

```bash
pnpm dev -p 3004                                          # Next + the eve dev server
curl localhost:3004/eve/agents/workspace/eve/v1/health     # {"ok":true,"status":"ready",...}
```

Isolation test (`scripts/spike-b-isolation.mts`, Node >= 22.18 strips types natively):

```bash
# probe mode (default) — no model calls, $0
SPIKE_B_PROBE=1 pnpm dev -p 3004
node scripts/spike-b-isolation.mts

# same, pinned to the production backend (real hosted sandboxes)
SPIKE_B_PROBE=1 EVE_SANDBOX_BACKEND=vercel pnpm dev -p 3004
node scripts/spike-b-isolation.mts

# agent mode — drives the real tools through the model (needs a funded gateway)
pnpm dev -p 3004
node scripts/spike-b-isolation.mts --mode=agent
```

Next refuses a second `next dev` for the same directory, so when another dev
server is already up, run the eve server standalone instead and point the script
at it (env is not inherited from the repo root in that case):

```bash
cd agent/workspace
SPIKE_B_PROBE=1 EVE_SANDBOX_BACKEND=vercel VERCEL_OIDC_TOKEN=<from repo-root .env.local> ../../node_modules/.bin/eve dev --port 4004
EVE_HOST=http://127.0.0.1:4004 node scripts/spike-b-isolation.mts
```

---

## Spike B #1 verdict — per-session isolation: **YES**

**eve is not disqualified.** 14/14 checks pass on the **Vercel Sandbox backend**
(what production uses) and again on `just-bash`.

### Mechanism

Session sandboxes are **keyed per durable session**, not per agent and not per
deployment. `onSession({ use, ctx })` runs once per session (and again when the
sandbox definition changes, or after a `delete()`), and `ctx.session.auth.current`
identifies the principal while the sandbox initializes — exactly the hook
`hydrateWorkspace(studentId, courseId)` needs. `sandbox.id` is stable per
session and literally embeds the durable session id:

```
eve-sbx-ses-vercel-07271c4eea03b1cb-c6c47d291d1f-wrun_01M1B5JVS52HACBMEF002DZX01-__root__
                                                  ^ durable sessionId
```

### Evidence (Vercel Sandbox backend, `EVE_SANDBOX_BACKEND=vercel`)

```
PASS  A1 probe reached a live sandbox
PASS  A1 marker written and visible in session A
PASS  A1 onSession hydrated SESSION.md
PASS  B1 cannot see session A's marker   [DISQUALIFYING]
PASS  B1 sandbox id differs from A       [DISQUALIFYING]
PASS  B1 got its own hydrated SESSION.md
PASS  A2 marker persists across turns in the same session
PASS  A2 same sandbox id across turns
PASS  A2 still cannot see anything of B's
PASS  B2 marker written in B
PASS  B3 sandbox.delete() succeeded
PASS  B3 delete discarded the workspace (marker gone)
PASS  B3 onSession reran on re-provision (SESSION.md rebuilt)
PASS  B3 replacement sandbox still isolated from A

session A : wrun_01M1B5JVS52HACBMEF002DZX01
session B : wrun_01M1B5JYF4TW31YC6BJ931K185
```

Two durable sessions of the *same* agent: A's `marker-<A>.txt` never appears in
B's `/workspace`, B's never appears in A's, and the two carry different sandbox
ids. Within one session the filesystem persists across turns.
`sandbox.delete()` destroys the workspace and the next `getSandbox()`
re-provisions and reruns `onSession` — so "hydrate → use → tear down →
re-hydrate" is a supported lifecycle, and face.md rule (1) "always rebuildable"
holds.

The evidence was produced **without model calls**: `hooks/spike-b-probe.ts`
reaches the live sandbox through `ctx.getSandbox()` on `message.received` — the
same runtime seam an authored tool uses. The AI Gateway account is currently
unusable (`customer_verification_required`: no credit card on the Vercel team),
so `--mode=agent` has not been executed end to end. That gap is about the
*model*, not about isolation: probe and tools call the identical
`ctx.getSandbox()` API.

### Caveats to carry forward

- **`sandbox.id` is eve's per-session key, not the provider's sandbox id.** After
  `delete()` the key string is unchanged (it is derived from the session id)
  while the physical sandbox is new. Assert isolation on *file visibility*, not
  only on the id.
- **Vercel Sandbox idles out (default 30 min).** eve preserves the filesystem and
  resumes on the next message. A resume is not a fresh session, so `onSession`
  does not rerun — the hydration timestamp must therefore live in the workspace
  (`SESSION.md`), which is why `onSession` writes one.
- **`onSession` does not rerun on a provider-loss replacement.** If the persisted
  Vercel sandbox is gone, eve creates a replacement under the same sandbox key
  *without* running `onSession`. Security-critical config must live on the
  **backend factory** — which is why `networkPolicy: "deny-all"` is set in
  `defaultBackend({ vercel: ... })` and not only in `onSession`. It also means a
  replacement can come back with an *empty* workspace: treat re-hydration as
  idempotent and cheap, never assume files survive.
- **Local dev is not VM isolation.** With no Docker, on Windows,
  `defaultBackend()` falls back to `just-bash` — a virtual filesystem under
  `.eve/sandbox-cache/`, no real binaries, no network isolation. It proves eve's
  session keying; only the Vercel run proves VM-level isolation.
- **Cost.** Vercel Sandbox memory bills wall-clock. `sandbox.stop()` (a
  `turn.completed` hook, or `tools/teardown.ts`) is the lever; Spend Management
  with *pause* must be on before real traffic (Spike B #4, still open).

---

## What is still stubbed

- `hydrateWorkspace(studentId, courseId)` — the `onSession` comment marks where
  `state.md` / `signals.md` / the materials manifest get written from Convex
  (Spike B #3).
- `propose_change` writes nowhere. **Convex is the only truth**; Core adds
  `changes.propose` and the tool calls it.
- `hooks/usage.ts` console-logs the usage row instead of writing the Convex
  `usage` table. Idempotency key = `event.meta.id`.
- `channels/eve.ts` has no Clerk verifier, so browser users get 401 in
  production. Dev-only until that lands.

---

## Streaming facts for the harness (Spike B #2)

- Hook: `useEveAgent({ agent: "workspace" })` from `eve/react`. `withEve` mounts
  the routes same-origin, so no `host` and no CORS. Returns
  `{ data, status, error, events, session, send, respond, resume, cancel, reset }`;
  `status` is `ready | resuming | submitted | streaming | error`.
- `data.messages` are `EveMessage[]` — **not** AI SDK `UIMessage[]`. Parts:
  `text | reasoning | file | step-start | dynamic-tool | authorization`.
- A tool call is a `dynamic-tool` part and moves through
  `input-streaming` → `input-available` → (`approval-requested`) → `output-available`.
  `input-streaming` carries partial raw JSON in `part.inputText`;
  `input-available` carries the validated `part.input`.
- **Approvals.** When a gated tool is called, eve emits `input.requested`, the
  turn parks at `session.waiting`, and the pending request rides at
  `part.toolMetadata?.eve?.inputRequest` on the `dynamic-tool` part whose
  `state === "approval-requested"`. Scan **all** messages (an unrelated turn can
  append newer messages while an approval stays open). Answer with
  `agent.respond([{ requestId, optionId }])` — option ids are `approve` /
  `cancel`; a freeform question answer is `{ requestId, text }`. `request.kind`
  is `tool-approval | question | session-limit` — branch on `kind`, not on
  `toolName`.
- Map onto the forked harness primitives by `toolName`: `propose_change` →
  approval card + diff table; `list_workspace` / hydrate → tool chips.
- `propose_change` output shape (what the diff table renders):

  ```jsonc
  {
    "ok": true,
    "change": {
      "kind": "deadline_moved",       // | "deadline_added" | "deadline_removed"
      "title": "PS4",
      "before": "2026-09-10",         // optional
      "after": "2026-09-12",          // optional
      "reason": "syllabus says the 12th",
      "tier": "needs_approval",
      "status": "pending"
    }
  }
  ```

- Resume across reloads with `initialSession: { sessionId, streamIndex }` +
  `resume: true`; persist events from `onEvent` and the cursor from
  `onSessionChange`. Dedupe on `event.meta.id` (stable across reconnects and
  rewinds; a *retried* step re-emits under new ids).
- Usage for a cost rail is on `step.completed`
  (`data.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costUsd}`);
  the model id is on the preceding `step.started` (`data.modelId`).

---

## Face glue (Spike B #2) — **live-verified**

- **Reducer:** `lib/eve/reduce.ts`. Pure `EveMessage[] → RailItem[]`, no React,
  no DOM. `reasoning` → thinking row, `text` → streaming prose, `dynamic-tool`
  → tool chips labelled as Core actions ("listed workspace", "proposed
  change"), a gated `propose_change` in `approval-requested` → approval card +
  diff table, `output-available` → a collapsed "change proposed — pending in
  Core" row. `input-streaming` shows a "preparing…" chip and never parses the
  partial `inputText`. Every message is scanned, so an approval stays
  discoverable while later turns append messages.
- **Rail:** `components/workspace/chat-rail.tsx` — `useEveAgent({ agent:
  "workspace" })`, composer with `turnPolicy: "steer"` while a turn is live,
  Approve/Reject → `respond([{ requestId, optionId }])`, and the failure text
  shown verbatim instead of a spinner. Option ids are eve's own `approve` /
  `cancel`; only the *label* for `cancel` is rewritten to "Reject".
- **Live pass** (`anthropic/claude-haiku-4.5`, real Clerk session, dev server on
  3003): typed a prompt in the rail → `propose_change` streamed in → approval
  card rendered with the `Oct 9 → Oct 12` diff and the model's one-line reason →
  Approve → `output-available` collapsed row. `scripts/spike-b-isolation.mts
  --mode=agent` also passed the two HITL checks (`A3 propose_change parked for
  human approval`, `A4 approved propose_change returns the pending change
  envelope`) for `$0.006644` of gateway spend.
- **Model-free path is kept on purpose.** `lib/eve/fixtures.ts` holds frames of
  a real turn typed against eve's `EveMessage`, so a projection change on
  upgrade breaks `pnpm typecheck` first. `node scripts/spike-b-stream-check.mts`
  asserts the reducer output frame by frame (36/36), and `?replay=1` on a course
  page (dev only) feeds the same frames through the same renderers — the rail is
  demoable with the gateway down, at $0.
