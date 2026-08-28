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
