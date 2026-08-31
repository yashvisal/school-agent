# Face — The Web App

> Inherits [vision.md](./vision.md) (esp. §7 onboarding, §8 product surfaces). Siblings: [core.md](./core.md), [voice.md](./voice.md). Milestone 1: harness fork + onboarding + Dashboard + Semester + Connectors + course workspace shell. Milestone 3: workspace agent, Library, artifacts, lessons.

## Goal

Where the student looks, reads, fixes, and works — visited when needed, often sent there by the thread. Never asks the student to schedule; never negotiates the plan (that's Voice). Web chat exists only inside course workspaces, scoped to the workspace and its artifacts (vision §8 scope rule).

## Shell: forked agent harness

Fork [Beautiful UI](https://github.com/slev12397/beautiful-ui) (MIT, Next.js + Tailwind v4) as the app shell: **nav sidebar | viewport | adaptive rail**. Copy `components/primitives/*` (thinking state, streaming text, approval cards, tool chips, records/diff tables, prompt bar), the `IceCreamHarness.tsx` arrangement, and the design tokens in `globals.css`; keep tokens/radii/hairline borders intact. Strip: PostHog, sounds (cuelume); **keep DialKit** (we use it — see CLAUDE.md "UI tooling"); swap the commercial `@central-icons-react` set for open icons. Replace the demo `SCENARIOS` with Convex queries/actions — real-time subscriptions drive streaming and progress primitives directly.

Primitive → product mapping: approval cards → change feed (two-tier approvals); tool chips → core actions ("polled Canvas", "parsed syllabus"); diff tables → deadlines with changes; Context rail → provenance on every fact; Tasks rail → this course's plan (read-only, from Core).

Every page renders in the viewport with a rail: Dashboard/Semester get Context/Tasks; workspaces add artifact-scoped Chat.

**Agent streaming into the harness:** the workspace agent (`agent/workspace`) runs on eve, co-located via `withEve(nextConfig)`, and streams through `useEveAgent()` from `eve/react` — eve's own NDJSON event stream, *not* the AI SDK `useChat` protocol (no official adapter). Messages are `EveMessage[]` with parts `text | reasoning | file | step-start | dynamic-tool | authorization`; tool calls arrive as `dynamic-tool` parts with streaming input, JSON output, and approval states. A thin custom reducer maps these onto the harness primitives (`dynamic-tool` → tool chips / approval cards / diff tables by `toolName`; `text`/`reasoning` → streaming + thinking states). Verified feasible; roughly a day of glue.

## Milestone 1 scope

1. **Auth + shell** — Clerk; Next.js App Router; sidebar: Dashboard · Semester · Library (stub) · Connectors · Settings · — · one entry per course.
2. **Onboarding** — connect Canvas token / iCal → drop syllabi (many at once) → **upload weekly class schedule** (image or file; approve the parse in a simple weekly view — these become hard planning boundaries) → optional course URLs → **review pending changes** (bulk approve, fix inline) → briefing → phone capture → "we'll text you tomorrow morning" (first message fires). Payoff must be immediate and visceral. Mid-semester variant: same flow + "mark everything before today done?"
3. **Dashboard** — relevance-ordered, not a fixed widget grid: what's happening (today's plan), what's upcoming, the **change feed** (auto-applied "new from Canvas" + the few pending approvals chat couldn't confirm in-flow — this must never become a chore inbox; see core.md "Approval channels"), recent artifacts (M3), quick links. Ordering informed by recent chat context. Real-time via Convex.
4. **Semester** — calendar-shaped: deadlines + planned tasks, filter by course, zoom week/month/semester, diffs highlighted (moved / added / pending). Click → facts, provenance, fix. No drag-to-plan.
5. **Course workspace (shell only in M1)** — course-scoped view: grading scheme, upcoming, materials, artifacts. The viewport/rail shell is in place; the workspace agent and artifact chat arrive in M3 when there are artifacts to talk about. Don't ship a chat rail with nothing to chat about.
6. **Connectors** — Canvas, iCal, email-in (later), health status, re-sync.
7. **Settings** — availability, phone, check-in preferences.

## Spike B — de-risk eve for the workspace (2–3 days, parallel to Spike A)

1. **Per-session isolation (first, disqualifying if it fails).** eve's default is one sandbox per *agent*. We need one isolated sandbox/filesystem per workspace session (student × course), hydrated for that student only, torn down after. Find the supported path (`onSession()` / `ctx.getSandbox()` / per-session backend); if there is none, eve does not run the workspace agent.
2. **Streaming** — an eve session streams `dynamic-tool` parts into the forked harness and renders an approval card and a diff table (load-bearing for Face).
3. **`hydrateWorkspace` prototype** on one Duke course — assemble `state.md`, `signals.md`, materials manifest from Convex; have the agent answer a question from `state.md`; write an artifact back to Convex storage before session end. This single test exercises the truth rule, hydration, and the eve↔Convex seam.
4. **Cost hygiene** — Spend Management with *pause* enabled (default is notify-only at $200); sandboxes ephemeral and stopped promptly (memory bills wall-clock); confirm sandbox region pricing; `usage` rows appear in Convex for every call.

## Workspace filesystem = materialized view (vision §10)

`hydrateWorkspace(studentId, courseId)` assembles the agent's filesystem from Convex per session: course materials (or a manifest + fetch-on-demand), `state.md` (deadlines / grading / plan rendered as markdown), `signals.md` (studentSignals digest), recent conversation summaries, prior artifacts. Three rules: (1) **always rebuildable** — delete + re-hydrate is lossless; (2) **agent writes never stay local** — the Convex write is the event, the filesystem write is a side effect; (3) **staleness is explicit** — hydration is timestamped; mid-session `changes` re-hydrate or are surfaced to the agent. What we choose to hydrate is context engineering, and it is where the quality lives.

## Milestone 3 — workspaces come alive

- **Course workspace** — the harness proper, driven by the **workspace agent** (`agent/workspace`, its own eve agent definition, separate from Voice; no planning tools — scope enforced by tool availability; hydrate + artifact + `recordSignal` tools only). Viewport: an artifact the agent prepared — primer, review outline, or a **lesson** — or a file it was built from. Lesson form borrows from [Heptabase AI Tutor](https://heptabase.com/ai-tutor#explore-learning): parts with a progress tracker, prose in the viewport, chat alongside, "create notes" → Library at the end. Difference: a lesson is always the fulfillment of a *planned task* ("review ch. 7 before Thursday's quiz"), built from the student's own materials — never "what do you want to learn?". Rail: **Context** (sources with provenance), **Tasks** (this course's plan), **Chat** (artifact-scoped). A **workspace agent** orchestrates the course: builds artifacts for `prepared` tasks, keeps them current as materials change, answers within the course's library and notes. Artifact-scoped chat sits beneath it and talks about the thing in the viewport. The rail chat is a bot *with access to* everything in the library/notes — not a list of notes.
- **Library** — its own tab, Drive-like: agent artifacts + everything the student brings in (PDFs, notes, Notion/Docs imports), foldered by course, searchable. This is how class-related information gets in beyond connectors.
- Every workspace/artifact exchange writes `studentSignals` (difficulty, confusion, what they asked about, which lesson part they stalled on) — the cognitive-signal capture from vision §4b.

## Later

- Editor for student-authored notes in the workspace — only if M3 usage shows students want to write here, not just read and ask.
- Notion/Docs imports; personal calendar connector UI (M2).

## Design rules

- Every edit is a *fact fix* that flows through Core `changes` (origin `manual`, auto-applied) — no shadow state.
- Provenance visible on hover/click for every fact.
- Empty states carry insight, not instructions.

## Open questions

- How much of the harness's dark-only token set to keep vs. adding a light theme.
- eve per-session sandbox isolation (Spike B #1) — the one open question that can change the runtime decision.
- How "recently discussed" context is represented so Dashboard ordering stays simple.
- Schedule-parse approval UI: how simple can the weekly verification view be?

## References

- Beautiful UI harness — demo https://www.beautifului.dev/harness · source https://github.com/slev12397/beautiful-ui
- Heptabase AI Tutor — https://heptabase.com/ai-tutor#explore-learning (lesson UX reference only)
- Convex https://convex.dev · Clerk https://clerk.com
- eve — https://github.com/vercel/eve · Next.js frontend https://eve.dev/docs/guides/frontend/nextjs · streaming/sessions https://eve.dev/docs/concepts/sessions-runs-and-streaming · sandbox https://eve.dev/docs/sandbox · chat template https://vercel.com/templates/eve/eve-chat-template · assistant-ui adapter https://www.assistant-ui.com/docs/runtimes/eve/overview
