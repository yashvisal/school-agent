# school-agent

Student execution agent — the plan is the source of truth. **Before doing anything, read
`plans/vision.md`, then the doc for your workstream: `plans/core.md`, `plans/voice.md`, or
`plans/face.md`.** Decisions there carry their reasons; don't relitigate them — if something must
change, change the doc in the same PR.

## Workstreams and folder ownership (one thread + one worktree per workstream)

| Workstream | Owns                                         | Doesn't touch                     |
| ---------- | -------------------------------------------- | --------------------------------- |
| Core       | `convex/`, schema, `package.json`, lockfile  | `app/`, `agent/`                  |
| Voice      | `agent/voice/`                               | `convex/` (ask Core for tools)    |
| Face       | `app/`, `components/`, `lib/`, `agent/workspace/` | `convex/` (ask Core for queries) |

Need something from another workstream? Stub it against fixtures and note it in your PR; Core adds
it. Small PRs, daily, Core merges first when the schema changes.

## Hard constraints (vision §10)

- **Convex is the only truth.** Agents read/write Core only through tools that call Convex
  functions; every mutation goes through `changes`; nothing durable about a student lives in eve.
- **Tool boundary is the seam.** Voice sees the plan only via `getFeasibleActions`, mutates only via
  `proposeChange`, learns via `recordSignal`. The workspace agent has no planning tools.
- **Facts, not inference, in the schema.** Store what sources say with provenance; derive the rest.
- **Isolation.** One sandbox/filesystem per workspace session (student × course); never shared.
- **Log usage on every LLM call** to the `usage` table. All model calls go through the AI Gateway.
- **Pin eve versions.** eve is 0.x; upgrade deliberately, never `latest`.
- **Voice is a product asset.** `agent/voice/instructions.md` + skills; tone regressions are bugs.

## Stack notes

- Next.js 16 (App Router) — read `node_modules/next/dist/docs/` before writing Next code; APIs differ
  from training data.
- Convex — read `convex/_generated/ai/guidelines.md` first. Clerk auth via `convex/auth.config.ts`
  (issuer from `CLERK_JWT_ISSUER_DOMAIN`, JWT template `convex`).
- eve — docs ship in `node_modules/eve/docs/` (start at `README.md`); they match the installed
  version. Both agents live under `agent/` and are mounted with `withEve(nextConfig, { agents })`.
- Documents → markdown with AnyDoc (local, keyless). Firecrawl only for crawling course sites.
- Test data: `fixtures/` (gitignored until scrubbed) holds the founder's Duke Canvas snapshots,
  syllabi, schedule, and synthetic change scenarios. It's stale data — see vision §7.

## UI tooling — use these without being asked (Face, and anyone touching `app/`)

Both are mounted dev-only via `components/dev-tools.tsx`; neither ships to production.

- **Agentation** (`agentation` + MCP server `agentation-mcp`, port 4747) — the founder's
  visual feedback channel. He clicks elements in the running app and leaves notes; they sync to
  you through the MCP tools. **At the start of any UI task, and whenever you're told "I left
  notes," call `agentation_get_all_pending`** (or `agentation_watch_annotations` while iterating).
  Each annotation carries the selector, element path, bounding box, and comment — go straight to
  that code. When you've addressed one, `agentation_resolve` it; if you disagree or need a
  decision, `agentation_reply`. Never leave pending annotations unacknowledged at the end of a
  UI PR. The `agentation-self-driving` skill is for *you* to critique a page autonomously
  (headed browser) when asked to "review the UI".
- **DialKit** (`dialkit` + `motion`) — live parameter tuning. **Whenever you build or restyle a
  component with judgment-dependent values** — spacing, radius, blur, durations, easings,
  stagger, colour accents, thresholds — wrap them in `useDialKit("Name", {...})` so the founder
  can tune in the browser instead of round-tripping through code. Use `id` + `persist: true`
  for panels shared across pages. Once values are settled, bake them into tokens/constants and
  remove the hook (or leave it if the surface is still being designed). The Beautiful UI
  harness already uses DialKit — keep it when forking.
- Rule of thumb: Agentation is for *what's wrong*, DialKit is for *how much*. Tone regressions
  and layout bugs → expect Agentation notes. Motion/feel/density → offer DialKit dials.

## Commands

`pnpm dev` (Next + eve), `npx convex dev` (backend), `pnpm typecheck`, `pnpm lint`, `clerk doctor`.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
