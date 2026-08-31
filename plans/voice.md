# Voice — The iMessage Loop

> Inherits [vision.md](./vision.md) (esp. §3 risks, §4 voice, §6 loop, §10 architecture seam). Siblings: [core.md](./core.md), [face.md](./face.md). Milestone 1: "it talks" — first morning text from real data. Milestone 2: "it holds" — replan, check-ins.

## Goal

The daily product: the **planning agent**, over Core, in iMessage (Photon / Spectrum). Morning plan, replans, check-ins, ambient state updates, ad-hoc questions, attachments as ingestion. The LLM chooses and speaks **within** the feasible set Core provides; it never invents facts.

**Scope:** planning — what to do, when, "I'm not doing this". This is the *only* surface where the plan is negotiated (vision §8 scope rule). Workspace and artifact questions belong to Face's agents; if they come up here, answer briefly and link out.

## Spike A — validate the default (before anything else; 1–2 days)

**Decision already made (vision §10): Voice runs on eve from M1.** The spike's job is to validate that default against named kill criteria, not to choose. Scaffold `agent/voice` with the official Photon iMessage channel (`eve add channel/photon-imessage`) and the three Convex tools (`getFeasibleActions`, `proposeChange`, `recordSignal`), then verify hands-on:

1. **Inbound mechanics** — signature verification (`X-Spectrum-Signature: v0=HMAC-SHA256(secret, "v0:" + timestamp + ":" + rawBody)`, reject >5 min old), at-least-once delivery (up to 6 attempts, **no ordering guarantee**, no DLQ), dedupe on `${webhookId}:${message.id}` with a 24–48h TTL. Confirm eve's channel does all of this for us, and what happens when it doesn't.
2. **Outbound from a stateless context** — there is no HTTP send endpoint; sends are gRPC via the SDK. Confirm eve's channel sends from a Vercel Function, and test the fallback (Photon's official `@spectrum-ts/convex` component from a Convex action).
3. **Attachments both directions** — webhooks carry attachment *metadata only*; bytes are fetched by GUID via the SDK. Send a PDF and an image; receive a PDF and a screenshot.
4. **Deliverability readout** — read Photon's Apple-filtering guidance before designing the morning push. Known rules: no link or media in a first message; inbound-first (student texts first); no bursts; two-way conversation matters. Confirm whether one end user consistently gets the *same* pool number (unverified; matters for "save this contact").
5. **Pricing and quotas** — Free $0 (10 users) / Pro $25/mo (100 users) on a shared pool; Business $250/line/mo for a dedicated number (production). Shared lines can only message registered users. Quotas: 5k msgs/day/server, **50 new conversations/line/day** — do the launch-day math. API 5 rps/project.
6. **Two-agent layout** — confirm eve's convention for `agent/voice` + `agent/workspace` (subdirectories, subagents, or two projects) and that Voice co-locates with the Next app or needs its own Vercel project.

**Kill criteria — fall back to raw webhook → `convex/voice/` only if one trips:**
1. eve can't **send proactively on an external trigger** to a specific user on the Photon channel (a Convex cron hits `POST /eve/v1/session` for that student and a morning text goes out with no inbound message first). We do not depend on eve schedules for per-user fan-out.
2. Composition can't be kept **constrained to tool outputs** without fighting the framework.
3. Session state can't be kept **thin enough to honor the truth rule**.
4. **Reliability/latency** on the channel is visibly worse than raw webhooks.
5. **Dependency stability** — pinned versions break a tool loop during the spike week.

None trips → eve-Voice is final; `convex/voice/` never exists.

## Spike A — readout (2026-08-30 → 08-31, eve 0.47.3, spectrum-ts 12.8.0)

Everything below was verified against the installed packages, Photon's docs, or the live line during the dates above; "unverified" is stated where it applies. Code lives in `agent/voice/`.

### Two-agent layout (item 6) — decided

**`withEve(nextConfig, { agents })` supports both agents in one Next project.** Each agent is its own eve app root in the **flat layout**, named in the map; `agent/workspace` is one more line at M3:

```ts
// next.config.ts
export default withEve(nextConfig, {
  agents: { voice: "./agent/voice" /* , workspace: "./agent/workspace" (M3) */ },
})
```

```text
agent/voice/                 eve app root, flat layout (app root == agent root)
  package.json               name-only marker ({ name, private, type }) — NO dependencies, no install
  agent.ts                   defineAgent({ model }) — AI Gateway id, pinned by string
  instructions.md            the voice (product asset)
  skills/                    replan-on-miss.md (+ more good/bad pairs over time)
  channels/photon.ts         photonIMessageChannel, portable creds, onMessage logging, turnPolicy "queue"
  channels/trigger.ts        POST /eve/v1/trigger → ctx.to(photon, target).send(...)  (kill criterion 1)
  tools/                     getFeasibleActions · proposeChange · recordSignal  +  disableTool() for every built-in
  hooks/usage.ts             step.completed → usage row (stub; Core owns the table)
  lib/                       core.ts (fixture → feasible set), students.ts (principal → student)
  fixtures/student-demo.json synthetic student; committed (no real data)
  evals/                     evals.config.ts + tone/*.eval.ts
  scripts/                   trigger.mjs, send-attachment.mjs (dev helpers)
```

What we learned, and why it's shaped this way:

- **`withEve` does not need a `package.json` in the agent dir** (it passes the root explicitly), but **the `eve` CLI does**: `eve info` / `eve eval` resolve the app root from the nearest `package.json`, otherwise they walk up to the repo root and treat `agent/` itself as the agent. So each agent keeps a **name-only marker** and nothing else. **Agents never get their own `node_modules` or lockfile entry** — one root install. (The spike briefly saw `eve add` pull in `@vercel/connect` and `eve dev` auto-install `just-bash` for the built-in bash tool; both went away once every built-in tool is disabled with `disableTool()`. Reverted; nothing per-agent is installed.)
- Mounts: `/eve/agents/voice/eve/v1/{health,info,session,photon,trigger}`. Photon's webhook URL is `https://<host>/eve/agents/voice/eve/v1/photon`. A custom channel route must live under `/eve/v1/…` — `withEve` only proxies that prefix, so `POST("/trigger")` would be unreachable.
- Flat layout prints harmless `discover/unsupported-directory` warnings for `evals/`, `fixtures/`, `scripts/`. `lib/` accepts modules only (the JSON fixture had to move to `fixtures/`). **eve's dev watcher rebuilds on every write inside the agent root** — never log into it; dev/tunnel logs go to gitignored `/.logs/`.
- Run the CLI from the agent root: `cd agent/voice && pnpm exec eve info | eve eval`. Dev: `pnpm dev -p 3002` at the repo root boots Next + the eve dev server for every named agent.
- Subagents are not the mechanism: they inherit nothing and can't own channels/schedules; the scope rule needs two roots with different tool directories, which is exactly the map above.

### Kill criteria — results

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Proactive send on an external trigger, no inbound first | **Passes, proven live end-to-end (2026-08-31).** `POST /eve/agents/voice/eve/v1/trigger` → `ctx.to(photon, { threadId: "imessage:any;-;<E.164>~shared", adapterName: "imessage" }).send(prompt, { auth })` → 202 in ~350–420 ms, a Photon session created with no inbound message, model composed the plan from `getFeasibleActions`, and the morning text was delivered to the founder's phone. The thread id for a shared-line DM is `imessage:any;-;<phone>~shared` (verified via `space.create(phone)`); on a dedicated line the chat GUID is line-specific and must be stored per student. First attempt was blocked twice by non-eve gates, both now cleared: AI Gateway `customer_verification_required` (card added) and Photon's inbound-first throttle (see Deliverability). |
| 2 | Composition constrained to tool outputs | **Passes by construction.** All built-ins disabled with `disableTool()`; the agent has exactly `getFeasibleActions`, `proposeChange`, `recordSignal`, `load_skill`. Student identity comes from `session.auth` (`photon:<phone>`), never from the model. Nothing fought us. |
| 3 | Session state thin enough for the truth rule | **Passes** — see analysis below (no `defineState`, no memory provider). |
| 4 | Reliability/latency vs raw webhook | **Does not trip, with two mitigations we own:** `turnPolicy: "queue"` and Core-side dedupe (eve has none). Hand-off overhead measured at ~0.4 s; SDK sends 1.2–2.7 s. |
| 5 | Dependency stability | **Does not trip, with one real dev-mode bug worked around** (below). Other rough edges: eve 0.47.3 ships a broken type re-export (`compiled/chat/index.d.ts` → missing `messages-*.js`, so `Message`/`Thread`/`Attachment` are `any`; we declare a local `InboundAttachment`); `eve add channel/photon-imessage --non-interactive` wants the project secret as a CLI answer (hand-authored the documented equivalent instead). |

**Known eve 0.47.3 bug — inbound Photon messages fail under `eve dev` / `pnpm dev`.** Every inbound webhook dispatch throws `TypeError: a.from(...)[INTERNAL_CHANNEL_DELIVER] is not a function` in the Chat SDK bridge, so the agent never runs a turn (outbound via `ctx.to(...)` is unaffected). Root cause: the dev host bundle (`.eve/dev-hosts/*/nitro/dev/index.mjs`) inlines its own copy of eve's `channel-operations` module while the authored channel imports the external `node_modules/eve` copy — the internal deliver `Symbol` is created twice, so the bridge can't find it on the runtime's `from()` handle. Dev-only: the **production build works** (`pnpm exec eve build && pnpm exec eve start --port 3002` from `agent/voice`; inbound → turn → reply verified live, including a real founder conversation on 2026-08-31). Until fixed upstream, test inbound against `eve build && eve start` (webhook path is then `/eve/v1/photon`, no agent prefix) or a Vercel preview; `eve dev` remains fine for outbound and tools. Worth an upstream issue with the repro. One more `eve start` footgun: it shares `.eve/.workflow-data` with the dev server — sessions created under dev fail to resume under `eve start` ("development Workflow generation selector was resumed outside a generation-bound delivery"); clear `.workflow-data` when switching.

**Decision stands: Voice runs on eve. `convex/voice/` never exists.**

Attachments (item 3): outbound text + PDF + PNG delivered to the founder's phone through the Spectrum SDK (`scripts/send-attachment.mjs`, message ids logged); inbound verified with a correctly-signed replay (200; bad signature → 401) carrying a PDF and a PNG — `onMessage` logs name/type/size for each. Live inbound from the phone is the founder's check.

### Inbound mechanics (item 1)

- **Photon side** (docs/webhooks/*): `X-Spectrum-Signature: v0=hex(HMAC-SHA256(secret, "v0:{ts}:{rawBody}"))`, 5-minute tolerance recommended; up to **6 attempts** (immediate, 200 ms, 1 s, 5 s, 10 s, ±50 % jitter, 30 s per-attempt timeout); 5xx/408/429 retry, other 4xx/3xx drop; **no DLQ**, **no ordering guarantee**; dedupe on `{X-Spectrum-Webhook-Id}:{message.id}` with a 24–48 h TTL. **Exactly one event type (`messages`)** — no delivery-status, read-receipt, or typing events; reactions arrive as a content type inside `messages`. Attachments arrive as **metadata only** (`{id, name, mimeType, size}`); bytes are fetched by id via the SDK.
- **eve side (0.47.3)**: signature + 300 s timestamp window verified with `timingSafeEqual` (400 stale / 401 bad / 500 when no secret). Secret resolution: `webhookVerifier` > `webhookSecret ?? IMESSAGE_WEBHOOK_SECRET` > same-project Vercel OIDC. Marks messages read (best-effort gRPC) and sends typing indicators on `turn.started`/tool calls; streaming is off (one complete reply per turn). **No dedupe** — nothing reads the webhook id, and Chat SDK state is `createMemoryState()` (in-process). Default `turnPolicy: "steer"` means a Photon *retry* can cancel a half-composed reply → we set **`turnPolicy: "queue"`** and Core owns dedupe (`{webhookId}:{message.id}`, 24–48 h TTL) — listed under "Needs from Core".
- **Inbound attachments: the stock channel drops them.** `messageToUserContent` only emits a file part when the attachment has a `url`; the iMessage adapter provides none, so an attachment-only message dispatches nothing to the model. The adapter does expose `getAttachment()`; eve never calls it. Our `onMessage` injects the attachment metadata as context so the agent can acknowledge; byte fetch → Core ingestion is M2 work on top of the SDK, not the channel.

### Outbound (item 2)

- Spectrum has **no HTTP send endpoint**; the SDK talks gRPC to `spectrum.photon.codes`. eve's channel reply path is `thread.post({ markdown })` — **text only, no attachment argument**. Outbound files go through the Spectrum SDK directly (`attachment(path | Buffer, { name, mimeType })`) — that is the "stateless context" path, and it is what a Convex action would use (`@spectrum-ts/convex`).
- Tell the model plain text: iMessage renders markdown literally (baked into `instructions.md`).

### Deliverability (item 4) — source: photon.codes/docs/best-practices/imessage-deliverability

- First message: **no links, no media** (Apple suppresses link-clicking until a reply lands). **Inbound-first** is Photon's stated #1 design call — it avoids the Report-Junk banner; recommended pattern is an `sms:+1…&body=…` deep link so the student sends first (this is exactly vision §7 "text this number now"). Share a contact card after the first exchange; once saved, the junk surface disappears.
- Trust: target **≥3 student-sent messages per conversation**. Flagged patterns: bursts (100+ in a tight window), broadcasting without exchange, **>2–3 follow-ups to non-responders**, cold outreach, off-hours sending.
- Limits: 5 000 msgs/server/day (hard), **50 new conversations/line/day**, 500–700 users/line at intensive use (700–1 000 moderate), stop assigning new users at 70–80 % utilisation; a line dormant ~2 months is deactivated by Apple.
- **Photon enforces inbound-first at the API, not just as advice.** The first model-composed morning push on 2026-08-30 failed at `SendTextMessage` with `RESOURCE_EXHAUSTED: New contact has sent 1 of 3 messages; replies are limited to 10 until they respond`. Until a contact has sent ≥3 messages, a line may send at most 10 replies to them; the earlier spike sends (SDK text/PDF/PNG + eve's error texts) had consumed that budget. Consequences: (a) onboarding *must* get the student to send ~3 texts before we rely on a proactive push (a short back-and-forth at "text this number now" does it); (b) never burn the 10-reply budget on error messages — the channel's failure-path texts should be suppressed for new contacts; (c) Core should track "contact warmed" (≥3 inbound) per student and gate the morning push on it.
- **Same pool number per student: unverified.** Not documented. Per-line user-capacity figures and "smart routing" only make sense if the user→line mapping is sticky, which supports "save this contact", but confirm with Photon before promising it.

### Pricing and quotas (item 5) — source: photon.codes/pricing, docs/api-reference/rate-limit

- Free $0 / 10 users and Pro $25/mo / 100 users are both **managed shared**, "daily messages: unlimited" on the pricing page (the 5 k/day and 50-new-conversations caps come from the deliverability page). Business **$250/line/mo**, dedicated, unlimited users with auto-scale, and it is the tier that adds **cold outreach (≤50 new contacts/day)** — shared lines only message registered users. API **5 rps/project** (429 above; raisable).
- Launch-day math (assumptions: inbound-first onboarding does **not** consume cold-outreach slots — *the load-bearing assumption, confirm with Photon*; ~5 outbound + ~5 inbound per student/day = "intensive" → derate to 500 users/line):

  | Students | Lines | Plan | $/mo | What bites |
  | --- | --- | --- | --- | --- |
  | 30 | 1 shared | Pro | $25 | nothing; even agent-first would fit under 50/day |
  | 100 | 1 shared | Pro (at its ceiling) | $25 | the 100-user cap — student 101 forces Business |
  | 300 | 1 dedicated | Business | $250 | Pro's user cap; if new conversations *do* count against 50/line/day, a one-day launch needs 6 lines ($1 500) — stagger onboarding over ≥6 days instead |

  Nightly fan-out must respect 5 rps: 300 morning pushes serially ≈ 60 s minimum.

### Kill criteria 3 and 4 — analysis

- **3 (state thinness) — does not trip.** eve persists per session: append-only conversation history, `defineState` slots, channel routing state, sandbox (unused here). On Vercel that is Vercel Workflow; locally `.eve/.workflow-data`. Sessions live 30 days (`limits.sessionTimeoutMs`), then the next message starts fresh (Apple's thread is unbroken; the agent's recalled history resets — survivable because the nightly precompute re-supplies facts). We keep the footprint to history + routing by construction: **no `defineState` slots and no memory provider** (`fileMemory()` would put durable student facts in Blob and break the truth rule). `compaction` and `POST …/session/:id/clear` are the levers to cap it further.
- **4 (reliability/latency) — the real risk is duplicates, not latency.** Path: Photon → signed POST → Vercel Function → `markRead` gRPC → durable Workflow run → model/tools → gRPC reply; ack is fast (work runs behind `waitUntil`). But eve re-runs an interrupted step ("make non-idempotent side effects idempotent"), and there is no webhook dedupe, so a duplicate *send* is the realistic failure mode. Mitigations: `turnPolicy: "queue"`, Core-side dedupe, idempotent `operationId` on triggers. Cold-start numbers: unverified (not documented). Spectrum exposes no delivery-status webhook — "did the morning push land" is not observable today.

### Operational notes — current spike state (temporary, until a real deploy)

- **The whole loop currently runs on the founder's machine:** `pnpm exec eve build && pnpm exec eve start --port 3002` from `agent/voice`, behind a cloudflared *quick* tunnel. If the box sleeps or either process dies, the line goes silent — that's ops, not code. A quick tunnel's URL changes on every restart, and the Photon webhook is registered against it, so a tunnel restart means **recreating the webhook** (Spectrum REST `POST /projects/{id}/webhooks`), which also **rotates the signing secret** → update `IMESSAGE_WEBHOOK_SECRET` and restart the server. First durable step: a Vercel deploy, which moves the webhook to the stable domain at `/eve/agents/voice/eve/v1/photon` and makes the secret set-once.
- **The webhook path differs by topology:** `/eve/agents/voice/eve/v1/photon` under `withEve` (Next dev / Vercel), `/eve/v1/photon` under bare `eve start`. Same for `/…/trigger`. The dev scripts take `PHOTON_PATH` / `--path` overrides for this.
- **Trigger auth is a single shared secret** (`x-voice-trigger-secret`). Acceptable while the route is only reachable through a private tunnel; on a public Vercel deploy, Core should call it with Vercel OIDC (or at minimum keep the secret only in Vercel env and rotate it), and the real `operationId` idempotency store must exist first — the in-memory dedupe is per-process.
- **The prod-build server and `eve dev` share `.eve/.workflow-data`** — never run both against the same agent dir without clearing it (see the bug note above).
- **Signing secret hygiene:** the spike's original webhook secret was rotated on 2026-08-31 (it had been echoed into a local log during debugging); secrets live only in `.env.local` / host env, never in committed files.
- **Model pin:** `agent.ts` pins the Gateway model id by string (`anthropic/claude-sonnet-5`). Changing it is a one-line PR; per-task model split (cheap classifier vs composer) is M1 work.

## Milestone 1 scope ("it talks")

1. Photon integration via the eve channel (`agent/voice`); phone ↔ student mapping (Clerk user ↔ number); onboarding hands off **inbound-first** — the student texts the number, the agent replies with the briefing.
2. Nightly pass, split at the tool boundary: a **Convex cron** runs the deterministic precompute (feasible set for tomorrow, pending-change annotations, signals digest) and then **triggers an eve Voice run** per student for selection + composition + send. eve never fans out schedules per user; Convex decides who gets a run and hands it what's true.
3. Morning push at the student's local time. Never leads with a link or media (deliverability); links out to Face come after the student has replied at least once.
4. Inbound handling v0: classify message → `state update | plan negotiation | question | noise` → structured, zod-validated → state updates emit Core `changes` (`needs_approval`) and are **confirmed inline in the same exchange** — that confirmation *is* the approval (core.md "Approval channels"). Nothing from chat lands in the web queue.
5. Nightly pass also surfaces any pending change entering the planning horizon for a one-word confirmation, so the queue drains through conversation.
6. Voice guidelines v1 as `instructions.md` + skills with good/bad example pairs, plus a first tone eval.

## Milestone 2 scope ("it holds")

- Replan on miss: student says they didn't do it (or says nothing) → calm triage over a fresh feasible set, matter-of-fact reply.
- Check-ins: default only when tomorrow's plan depends on the answer — cadence is an open question.
- Multi-turn negotiation ("move it", "why this?" → a true, legible answer from Core's annotations).
- Attachments as ingestion (PDF, screenshot) → Core pipeline → `needs_approval` change → confirmed in thread.
- **Observe and remember (behavioral expertise, vision §4b):** every exchange can write `studentSignals` — "didn't do it, went out" (Friday), "took way longer than 2h", "stressed about chem", "friend's birthday sat". The nightly pass reads signals for this student and adjusts *without stating a rule*: nothing scheduled on nights they never work; plan 4h where they said 2h and took 4h. Statistical learning stays in M4; this is noticing and using what they told us.
- Personal calendar events show up as availability, and the agent references them naturally ("you're clear tonight, go").

## Architecture

- **Runtime: eve** (`agent/voice` — its own agent definition, separate from the workspace agent; vision §10). Photon channel; one eve session per conversation (thread memory for free); nightly pass = Convex cron precompute → triggered eve run (M1 #2); HITL approvals via `needsApproval` for `needs_approval` changes. **Exactly three tools** into Core: `getFeasibleActions`, `proposeChange`, `recordSignal`. No planning logic lives in eve-specific APIs.
- **Voice guidelines = `instructions.md` + skills** — checked-in markdown with good/bad example pairs; evals (`defineEval`) guard tone regressions as bugs.
- **Provider-agnostic LLM layer** (Vercel AI SDK); models per task (cheap classifier for inbound, stronger model for planning/composition); zod at every boundary. Every call logs to Core `usage`.
- **Deterministic seam:** the LLM receives the feasible option set + facts + recent conversation; it outputs a choice + message. Any state mutation goes through Core `changes`, never direct writes.
- Runtime is eve (vision §10); no second framework. Fallback only on a Spike A kill criterion.
- Delivery adapter is thin: `send(studentId, message, attachments?)` — iMessage today, other channels tomorrow (vision §3.5).

## Tone (asset, not decoration)

Competent friend doing triage. No guilt, no moralizing, no fake enthusiasm. Short, concrete times and facts. Replans state the consequence plainly ("that's the last window before it's due") without pressure. Guidelines ship as a prompt file with test conversations; regressions in tone are bugs.

## Open questions

- Check-in cadence (evening ping vs. only-when-needed).
- How much conversation history the nightly pass sees; how "recently discussed" is exposed to Face for Dashboard ordering.
- Conversation test harness (replayable transcripts against fixtures).

## References

- Photon / Spectrum — https://photon.codes · docs https://photon.codes/docs/ · TS SDK https://github.com/photon-hq/spectrum-ts · pricing https://photon.codes/pricing · deliverability https://photon.codes/docs/best-practices/imessage-deliverability · webhooks https://photon.codes/docs/webhooks/events · Convex component https://photon.codes/blog/your-convex-agent-can-text-now-using-photon
- eve Photon channel — https://vercel.com/changelog/imessage-support-for-eve-agents · https://eve.dev/docs/channels/photon · https://photon.codes/docs/integrations/eve · example https://github.com/photon-hq/vercel-eve-imessage-example
