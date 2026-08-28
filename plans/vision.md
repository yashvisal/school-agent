# Product Vision — Student Execution Agent

> **Purpose of this doc.** This is the durable, high-level statement of what we're building and why. Any future agent or teammate should be able to read this and understand where we're coming from before touching anything. Phase-level planning docs live alongside this in `plans/` and inherit this context. When a decision here changes, change it here.

---

## 1. Thesis

The problem for college students is not knowing what is due. It is the **cognitive load of deciding what to do, when to do it, and how to recover when plans break.**

The product is a **student execution agent** — not a chatbot, an open-ended tutor, a calendar, or a generic planner. It maintains a live model of the student's courses, workload, deadlines, available time, and progress, and continuously turns that state into a realistic plan and a recommended next action.

**The core differentiator is closing the loop between planning and doing:**

```
prioritize → prepare the support needed to do the work → observe progress → replan
```

Pull tools (ChatGPT, Quizlet) wait to be asked. This product **pushes**: it knows what the student will need, when, and has it ready unprompted. Value is delivered as the fulfillment of a scheduled action — "Tomorrow 2pm: Bio ch. 7" arrives with the primer attached; "Midterm in 6 days — review outline is built from your lecture slides, start Thursday."

### The magic, honestly stated

The **wow factor for acquisition** is the end-to-end loop: the agent planned your day, prepared the material, and texted it to you before you asked. The **trust core for retention** is the triage loop itself — realistic plans, calm replans, semester-level foresight. Content generation on its own is a commodity (every AI tool does it on request); it becomes differentiated only as the fulfillment step of a plan the agent made for you. We don't relitigate which half is "the" magic — we build the whole loop, and we sequence the content-preparation half behind solving materials access (see §7).

### Positioning vs. the market

- **MyStudyLife / Shovel:** organization and scheduling only — they stop at visibility and leave the deciding to the student.
- **Canvas / LMS:** course administration.
- **AI study tools:** on-demand content generation — the crowded part of the space; we do not compete there directly.
- **AI tutors (e.g. [Heptabase AI Tutor](https://heptabase.com/ai-tutor#explore-learning)):** goal-driven — the student states what they want to learn, the AI invents a syllabus and teaches it in lessons. Excellent lesson UX; we borrow the *form* (lesson parts, progress, chat alongside, notes generated at the end) but never the premise. Our syllabus already exists (the course), the goal is the deadline, and the plan already decided what you need and when. We teach only what the plan says you need, from your own materials, before you ask.
- **Nobody owns the full execution loop. That is the wedge.**

We are a **student-controlled layer above existing school systems**. Institutional integration (an AI-native LMS connecting teacher intent to student execution) is a possible long-term direction but is explicitly not what we're building now, and nothing in v1 should depend on it.

---

## 2. Who it's for

**First user:** a college student with real deadline pressure, imperfect discipline, and a phone-native life — someone who knows roughly what's due but loses the war of deciding, starting, and recovering. (Concretely: a student like the founder was at Duke.)

**Anti-user:** the already-organized student with a working Notion/planner system. They don't have the problem; designing for them dilutes the product.

*Status: working assumption, to be sharpened against real onboarding.*

---

## 3. Critical product risks (design against these)

1. **Cold start / state maintenance.** The agent is only as good as its model of the student's state. If the student must manually feed the system, we have *added* cognitive load and they churn in two weeks (the Notion-template death). Every design decision is judged by: *does this reduce what the student must tell the system?*
2. **The system can't observe most work directly.** Canvas submission status is the one hard signal, and only for submitted work. Progress observation is therefore mostly conversational. The design constraint that follows: **a check-in must cost the student less than the value of the replan it produces** — a one-word text reply, never a form. The agent should synthesize state from whatever the chat gives it and ask only when asking is cheap.
3. **The replanning moment is the retention event.** Every planner dies at the first broken plan. A student who skipped two days is anxious; a naive replan ("do 6 hours today") or a moralizing one kills trust. A calm triage builds it. **Missing a day should increase trust in the product.**
4. **Trust doesn't survive a caused missed deadline.** The factual layer can never hallucinate (see §10 — this is the reason the architecture has a deterministic core).
5. **Channel risk (accepted).** The daily loop rides on iMessage via unofficial infrastructure (Photon). Apple has killed such products before (Beeper). We take this risk deliberately — iMessage is that much better than SMS on cost, richness, and where students actually live. Mitigation: keep the delivery layer thin so the channel is an adapter, not the architecture; a channel death should be a painful week, not a rewrite. Exit, stated honestly: Photon's SDK and `imessage-local` are MIT, but the cloud relay is not published — the self-host path is *running our own Mac* signed into Messages, which loses SMS fallback, attachment fetch, reactions, and read receipts. Real, but degraded. Photon serves consumer text-an-agent products (Fae, Ditto with 140k users) — we are their core market shape, not an edge case.
6. **Structural churn and seasonal acquisition.** Semesters end, summers are dead, users graduate; peak onboarding motivation is a two-window-a-year event (September/January). We must support **mid-semester onboarding**: assume N topics covered and M assignments done, backfill from what sources give us, and move forward — a degraded-but-real path, not a locked door.

---

## 4. Voice & personality (product-critical, not cosmetic)

Part of the college experience is messing around and being a non-ideal student. The agent accepts this as reality instead of fighting it — the goal is to meet students where they are, not to change ingrained behaviors. Tone = **competent friend doing triage**, never nagging parent. No guilt, no moralizing, no fake enthusiasm. Replans are matter-of-fact and realistic. The voice ships as written guidelines for the LLM layer and is a first-class product asset.

---

## 4b. What "expert in the student" means

The value axis is the agent becoming an expert in *this* student and adjusting to them. Three layers, each a different product:

1. **Behavioral** — when and how they actually work. "you never do anything friday nights, so nothing's scheduled; saturday morning is open." Says 2h, takes 4h on psets — plan for 4 without saying so. This is where retention lives: it's what makes the first week not churn. Mostly *noticing what the student already tells us in chat* — cheap, and pulled into Milestone 2.
2. **Content** — what their courses contain. Materials, slides, syllabi → prepared artifacts from *their* class, not generic. Milestone 3.
3. **Cognitive** — what they understand and don't. "you were shaky on eigenvalues last week — that's 30% of this exam." Genuinely uncopyable, and not buildable now — but the **signals that make it possible must be captured from day one** (what they got stuck on, what they said was hard, how long it really took). Cheap to log, impossible to backfill.

Consequence: every conversation on every surface is a signal, not just a state update (see `studentSignals`, §5). And voice (§4) is the *acquisition surface for that signal* — students only say "I got stuck on 3" or "my friend's birthday is saturday" to something they want to talk to.

---

## 5. State model (the core asset)

Everything else in the product is a view over this state. Stored as **facts with provenance** (see §9); derived quantities are computed or interpreted by the agent, not stored as truth. Keep the schema minimal — do not over-model.

- **Course:** name/code, grading scheme as stated (categories, weights, points, drop rules), source refs, materials.
- **Deadline (fact):** something due, from a source — homework, project, exam, quiz, reading. Kind, due date, points/category, submission status, source + confidence.
- **Task (work):** a unit of work the student will actually do — planned by the agent or created by the student — usually pointing at a deadline (several tasks per deadline is normal), sometimes free-standing. Type `do | prepared` (typed from day one so new fulfillment types are handlers, not restructures), status, effort estimate/actual as learned.
- **Change (event):** every difference between what we knew and what a source or the chat now says — added, moved, removed, submitted, decided-in-chat. Diffing is a core mechanic (§6).
- **Student (global):** class schedule, available time blocks, personal calendar.
- **Student signals (facts about the student, with provenance):** observed or told — "said 2h, took 4h on CS psets", "doesn't work Friday nights", "got stuck on eigenvalues", "friend's birthday Sat". Written by every surface from day one; read by the planner and every agent. Pacing, compliance patterns, weaknesses are *interpretations over signals*, not stored values (§4b).

Things like importance, rhythm, and "hell weeks" are **not schema** — they are cheap computed views or the agent's own interpretation over the facts. Don't over-constrain the system to pre-encode them.

**Defensibility lives in the accumulated state model** (switching cost once it knows your semester) **and in earned trust** (a student rescued from two broken weeks doesn't leave) — not in any single learned parameter.

---

## 6. The loop

1. **Nightly plan pass** — Convex precomputes what's possible for tomorrow; a triggered Voice run picks 1–3 actions and composes the text.
2. **Morning push** over iMessage.
3. **Replan on miss** — the triage moment described in §3.
4. **Ambient updates any time** in natural language ("exam moved to Friday", "not doing this, rework the plan") → state update → replan. Conversation happens in iMessage; organization, semester view, and accumulated resources live on the web app.
5. **Diff everything.** Every source poll and every chat decision produces *changes* against the known state. Changes from authoritative sources (Canvas, iCal) auto-apply and are surfaced as "new since you last looked"; changes the LLM *interpreted* (chat, syllabus parse, screenshots) or that conflict between sources are **held for one-tap approval**. Crucially, an inline chat confirmation ("got it — midterm now Friday, right?" → "yeah") *is* approval, first-class and equal to a web tap; the web queue only holds what chat couldn't confirm in-flow. The change feed lives on the Dashboard and Semester views and is what keeps the web app in sync with the conversation.

---

## 7. Ingestion

Constraint: institutional LMS integration is out of scope. Student-controlled sources only.

### Structure & deadlines (v1, in priority order)

1. **iCal feeds from LMS** — baseline. Titles + due dates only; often incomplete because professors half-use Canvas.
2. **Student-generated Canvas API token** — optional but rich: submission status, grades, descriptions. Per-student, ToS-gray, can break silently — an accepted, listed fragility for MVP.
3. **Syllabus upload (PDF)** — the *primary* structural source, not supplementary: grade weights, exam dates, reading schedules, how the professor actually runs the course. LLM-parsed into structured state.
4. **Course-specific websites** — same treatment as syllabi.

### Materials access (the open problem gating `prepared` fulfillment)

Anticipatory content prep requires having the underlying materials. Current thinking, ranked by friction:

1. **Canvas API token (passive, bulk).** The same token from above also exposes `files`, `modules`, `pages`, and `announcements` — for token-connected students, posted slides and readings arrive automatically. This is the biggest lever and costs nothing extra.
2. **iMessage attachments (catch-all).** The conversation thread *is* an ingestion surface: text the agent a PDF, a screenshot, a photo of a whiteboard. iOS share sheet → Messages covers "file on my phone" with zero new UI.
3. **Email-in address** — forward anything to the agent's inbox. Cheap to build, also catches announcement emails without any OAuth.
4. **Browser extension (later).** The interesting version is *passive*: it syncs files as the student browses Canvas normally. Deferred — a real build, not v1.

*Status: direction, not settled. The bar for any addition here: does it feel hands-free?*

### Development reality (until a real token arrives)

We have **no live Canvas access at all** until a friend at school hands over a token — a few days after v1, at semester start. Duke no longer issues tokens to alumni, the free sandbox instance isn't available, and the founder's old iCal feed is too stale to trust. Decision: **build every adapter to Instructure's published spec (fixtures hand-authored from the docs' example responses), validate against a real account in a short fix-up pass afterwards.** Canvas has no push/WebSocket API, so live sync is polling-based regardless; the snapshot→diff design means the change pipeline is fully testable on fixtures. Details and the live-validation checklist in core.md.

### Email integration (deferred)

School email is usually institutional Microsoft 365 behind SSO — real integration is a headache (and consumer Gmail scopes require a paid security assessment). Deferred. The email-in forwarding address above is the zero-integration stopgap.

### Onboarding is an investment moment, not a chore

~15 minutes at semester start (the natural high-motivation window — students buy planners in September). The payoff must be immediate and visceral: the agent instantly renders the full-semester picture ("3 hell weeks: Oct 12, Nov 2, finals; your Tuesdays are structurally overloaded"). Setup that returns insight feels like power; setup that returns an empty dashboard feels like homework. Mid-semester onboarding (§3.6) gets the same treatment on partial data.

**Onboarding ends inbound-first.** Apple filters iMessage on behavior: a line that texts first, or leads with a link, gets the Report-Junk banner and suppressed links until the recipient replies. So onboarding ends with "**text this number now**" — the student sends the first message, the agent replies with the briefing. The first message from us never contains a link or media.

---

## 8. Product surfaces: Core, Voice, Face

**Thread negotiates, workspace builds, core knows.** The core plans, the thread tells you what to do and when, the workspace prepares the work itself and lets you do it — often before you ask — and what you do (or don't) feeds back into tomorrow's plan.

Three surfaces, three scopes, one ground truth:

- **Core** — the ground truth everything sits on: state model, integrations, diff engine, planner. Not an agent; what agents read from and write to (via `changes`).
- **Voice** — the iMessage thread: a **planning agent** over Core. Scope: what to do, when, replans, check-ins, ambient updates, attachments as ingestion. The daily product.
- **Face** — the web app: where the student looks, reads, fixes, and works. Inside each course is a **workspace** run by a separate **workspace agent** that orchestrates that course's materials and artifacts; beneath it, **artifact-scoped chat** talks about the thing in the viewport.

### Scope rule (load-bearing)
Web chat is *workspace/artifact-scoped*: "make this outline shorter", "explain problem 3", "what does the syllabus say about late work". **Planning — what to do, when, "I'm not doing this" — happens only in the thread.** Same student memory across all three (every exchange writes signals, §5), different scopes. Without this line, students plan in the web chat and the daily push loses its reason to exist.

### The thread (Voice — iMessage via Photon / Spectrum)
Morning plan, replans, check-ins, ad-hoc questions ("when's my next chem thing?"), state updates in natural language, attachments as ingestion, links out to the web app. Channel risk accepted per §3.5. Runs on eve via its official Photon channel (§10).

### The web app (Face)
Built on a forked agent-UI harness (Beautiful UI, MIT, Next.js + Tailwind v4 — see face.md): **nav sidebar | viewport | adaptive rail**. The rail flips role with the viewport — Context (sources with provenance), Tasks (this course's plan, from Core), or Chat (artifact-scoped) when an artifact is in the viewport. Its primitives map onto our concepts directly: approval cards = change feed; tool chips = core actions; diff tables = deadlines with changes; Context rail = provenance made visible.

Sidebar: **Dashboard · Semester · Library · Connectors · Settings · — · one workspace per course.**

- **Dashboard (home)** — what's happening, what's upcoming, the **change feed** (new from Canvas, decided in chat — approve/fix in one tap), recent artifacts, quick links. Prioritized by up-to-date chat context: if we just talked about the chem pset, the chem pset leads. Relevance ordering, not a fixed widget grid.
- **Semester** — calendar-shaped, filterable by course, zoomable (week / month / semester). Deadlines and planned tasks with **diffs highlighted** (moved, added, pending approval). Click into anything to see facts + provenance and **fix** it. Not a scheduler — never drag-to-plan.
- **Course workspaces** — the harness proper. Viewport: an artifact the agent prepared — a primer, a review outline, or a **lesson** (Heptabase-style: parts with progress, prose in the viewport, chat alongside, notes into the Library at the end — but scoped to a planned task and built from the student's materials) — or a file it was built from; later an editor for the student's own notes. Lessons are also the richest **cognitive-signal** source we'll have (§4b): "stuck on part 3" is exactly the data the expert-in-the-student layer needs. Rail: Context / Tasks / artifact-scoped Chat — a bot with access to everything in this course's library and notes, *not* a list of notes. Exists for one reason: the agent prepared something for a planned task and this is where the student uses it. Generic-workspace features (editors, student-authored notes) come later, only if usage shows students want to write here rather than read and ask.
- **Library** — Drive-like, its own tab. Everything the agent prepared and everything the student brought in (PDFs, notes, imports from Notion/Docs). Foldered by course, searchable. How class-related information gets into the system beyond connectors.
- **Connectors** — Canvas token, iCal, personal calendar, email-in address, later more. Set-and-forget with health status.
- **Settings** — availability, phone, voice preferences ("fewer check-ins"), account.

---

## 9. Facts vs. inference (state model principle)

The state model stores **what sources say**: points possible, category, due date, "readings for week 3: ch. 5–6", submission status, extracted syllabus text with provenance. Everything derived — importance, rhythm, hell weeks, pacing — is **computed downstream** and recomputable when we change our minds. Do not encode a formula (e.g. grade impact = weight × point share) into the schema: real courses have dropped lowest, quizzes that half-count, curves. Store ingredients; derive a simple *importance* later. The LLM at ingestion **extracts; it does not infer.**

---

## 10. Architecture: hybrid planner with a precise seam

**Deterministic layer owns facts and invariants:** state model, candidate task list, hard constraints (due dates, available windows, never schedule over classes), importance, pacing adjustments. Output: a scored, *feasible* option set.

**LLM layer owns judgment and language:** choosing among feasible options, weighting soft context ("he's stressed about chem"), interpreting messy student replies into state updates ("yeah i didnt do it lol im going out"), and all outbound communication. The LLM freestyles **within** the feasible set; it never generates the set.

**Rationale — asymmetric failure modes.** LLM picks a suboptimal-but-feasible plan → mediocre day. LLM hallucinates the set (invents a free window, misremembers a due date, drops a task) → missed deadline → trust death. The deterministic layer exists to make LLM mistakes non-catastrophic, not to limit its intelligence.

Side benefit: "why this?" gets a true, legible answer ("worth 25%, due Thursday, last 2-hour window") instead of a post-hoc rationalization. Cheap to build this way from the start; expensive to retrofit.

**Stack (decided):** all TypeScript, one repo. **Convex** for database, real-time, scheduled functions, and file storage; **Clerk** for auth. **Model-agnostic LLM layer** via the Vercel AI SDK with zod-validated structured outputs; swap models per task; never depend on provider-specific features (documents are parsed to markdown — AnyDoc, locally — before the model). **Deployed on Vercel** — everything else already is.

### Agent runtime: eve — and the truth rule

**Division of labor, stated once: Convex decides what's true and what's possible; eve agents decide what to say and do within that, and everything they learn or produce flows back through tools.** Same rule for Voice and the workspace agent — one architecture, two agents.

The deterministic seam (above) was never about runtime location; it is about the **tool boundary**. The Voice agent can only see the plan through `getFeasibleActions` and can only mutate state through `proposeChange` (and record what it learns through `recordSignal`). It freestyles composition within what tools return — exactly the seam as designed. Convex keeps the planner, the diff engine, the changes pipeline, signals, and usage logging; eve gets the channel, the loop, and the talking. Voice guidelines become `instructions.md` plus skills — checked-in markdown, which is precisely how we wanted to manage them.

Agents run on [eve](https://github.com/vercel/eve) (Vercel's open-source agent framework, Apache-2.0, built on the AI SDK; public beta since June 2026). It gives us, natively: sandboxes, connections (managed auth), cron schedules, skills as markdown, subagents, evals, OTel tracing with replayable runs, human-in-the-loop approvals, an official Photon iMessage channel, and a first-class stream into our Next.js harness. It is a v0-era dependency (0.x, fast-moving, open P0s) — **pin every version**, and keep tools and skills runtime-portable so a change of runtime is wiring, not logic.

**The non-negotiable rule: eve runs agents; Convex remains the only truth.** Agents touch Core exclusively through tools that call Convex functions. All mutations go through `changes`. Artifacts write back to Convex storage before a session ends. Nothing durable about the student lives in eve. A workspace agent's filesystem is a **materialized view** hydrated from Convex per session — rebuildable, never the source, staleness explicit (see face.md).

**Two agents, one framework.** Voice (`agent/voice`) and the workspace agent (`agent/workspace`) are separate eve agent definitions: separate instructions, tools, skills, evals, and traces. The scope rule (§8) is enforced by *tool availability*, not prompt: the workspace agent has no planning tools; Voice has no artifact tools.

**Decision: Voice runs on eve, as the first eve agent, from Milestone 1.** The official Photon channel collapses most of the Voice scaffolding we would otherwise build (webhook registration, signature handling, turn management, cancel-and-steer on rapid texts); the morning push is eve's flagship schedule use case; and the tool boundary keeps it safe. Because this commits early to a two-month-old framework, Spike A's job is to **validate the default, not choose** — with named kill criteria (voice.md). Fall back to raw webhook → `convex/voice/` only if one trips. None trips → eve-Voice is final and `convex/voice/` never exists; the pipeline logic lives behind the tools.

**Repo shape** — dictated by deployable units (Convex needs `convex/`; eve defines agents as directories), not by workstreams, which are an ideological split across parallel threads (§11). No packages, no Turborepo.

```
convex/                 Core: schema, ingestion, diff, planner, changes, signals,
                        hydrate queries, usage, crons (polling, nightly precompute)
app/ components/ lib/   Face: Next.js harness + shared schemas
agent/                  eve project — both agents, per eve convention
  voice/                planning agent: Photon channel, morning schedule,
                        instructions.md + voice-guideline skills,
                        tools → convex (getFeasibleActions, proposeChange, recordSignal)
  workspace/            M3: per-session sandbox, hydrate tool, component streaming
```

*Asterisk:* whether eve's convention for two agents is subdirectories, subagents, or two eve projects is a Spike A verification item. The logical structure above is decided; the physical nesting follows whatever eve wants. Shared types come from Convex codegen.

**Isolation is non-negotiable.** Every workspace session (one student, one course) gets its own sandbox / isolated filesystem, hydrated for that student only and torn down after. No student ever sees another student's files. If eve cannot isolate per session (its default is one sandbox per agent), that disqualifies it for the workspace agent regardless of anything else — Spike B's first question.

**Cost posture.** Infra is a rounding error (~$1–2/student/month at five workspace sessions a day); the real per-student cost is LLM tokens. Therefore **per-student token/cost logging from the first LLM call is mandatory** (`usage` in Core, not in eve — the one thing that stays true across runtimes). Sandboxes ephemeral by default and stopped promptly (memory bills wall-clock, not just active CPU). Vercel Spend Management with *pause* enabled — it is notify-only by default — before the first agent loop runs.

---

## 11. Workstreams, milestones, and how we build

Three workstreams over a shared core, developed **in parallel** — parallelism is a process choice (separate concurrent Fable threads, each delegating to Opus subagents, founder tests), not a reason to over-split the repo.

- **Core (core.md)** — facts-only state model (courses, deadlines, tasks, changes, signals), ingestion adapters (Canvas, iCal, syllabus, sites, schedule, personal calendar), snapshot→diff→changes sync, planner (feasible set). Goes first, then keeps growing.
- **Voice (voice.md)** — Photon, the planning agent, voice guidelines, nightly pass, morning push, replan, check-ins, observe-and-remember.
- **Face (face.md)** — harness fork → onboarding → Dashboard (with change feed)/Semester → Library/Connectors → course workspaces + workspace agent + artifacts.

Milestones cut across workstreams:
1. **It talks** — facts ingested from spec-derived fixtures (real Canvas later), onboarding + Dashboard/Semester, first morning text. Demo the product, not a dashboard.
2. **It holds** — replan on miss, check-ins, observe-and-remember (behavioral expertise, §4b), personal calendar connector, mid-semester onboarding, live tokens from friends.
3. **It prepares** — materials access (§7), Library, course workspaces + workspace agent, `prepared` tasks.
4. **It learns** — statistical pacing/compliance over signals, cognitive signals consumed, more connectors (Notion/Docs), browser extension if warranted.

Plan docs: `plans/core.md`, `plans/voice.md`, `plans/face.md`.

---

## 11b. How we'd actually go about it

We are not starting from a blank page on the Face: we start from a fork of the [Beautiful UI harness](https://www.beautifului.dev/harness) ([source](https://github.com/slev12397/beautiful-ui)), whose shell — nav sidebar | viewport | adaptive rail — and primitives (approval cards, tool chips, diff tables, streaming, thinking states) are close to what we want across the whole web app. So the Face work runs *backwards from the shell*: first make the fork ours (strip demo scenarios, analytics, commercial icons; keep tokens and radii; wire the shell to Convex so every panel is a live query), then turn the shell into a **course workspace** — the viewport shows a real artifact or file from fixture data, the rail shows Context with real provenance and Tasks from the real plan, and the artifact-scoped chat gets a workspace agent behind it once there is something to talk about. From the workspace, **extrapolate outward** rather than designing fresh: the Dashboard is the same viewport with relevance-ordered cards and the change feed rendered with the approval primitive; Semester is the viewport with a calendar-shaped diff table; Library and Connectors are viewport lists with the same rail. Onboarding is the one genuinely new flow, and it is mostly the approval primitive applied in bulk to the syllabus/schedule parses.

In parallel, and independent of the Face: **Core** starts on day one against spec-derived fixtures — schema, Canvas/iCal/syllabus adapters, snapshot→diff→changes with synthetic change fixtures, `feasibleActions` — because everything else is a view over it; and **Voice** starts with Spike A — the Photon spike on eve's official channel (send/receive/attachment on a real number, deliverability rules, pricing) — before anything else, then the nightly pass and morning text over `feasibleActions`, then inbound classification and inline approvals. Face runs Spike B in parallel — eve streaming into the harness, per-session sandbox isolation, and `hydrateWorkspace` on one fixture course — before committing the workspace agent to eve. The three run as three concurrent threads (§11); the first integration point is Milestone 1 — fixture-backed facts → a Dashboard on the forked shell → a morning text on a real phone. Everything after that (replans, signals, materials, workspace agent, lessons) is added to a loop that already runs end to end.

---

## 12. Explicitly not building now

- Institutional / LMS-side integration of any kind.
- Real email integration (OAuth/SSO into school Microsoft 365 or Gmail).
- Browser extension (candidate for a later milestone).
- Plan negotiation on the web — web chat is workspace/artifact-scoped only (§8 scope rule).
- Generic-workspace features (text editor, student-authored notes) before Milestone 3 usage shows students want to write, not just read and ask.
- **Open-ended, goal-driven tutoring** ("teach me X"). We only teach what the plan says you need, from your materials — lessons are a prepared artifact inside the loop, not a product. No mastery modeling yet; capture the signals now (§4b).

## 13. Open questions

- Materials access end-state: which combination of §7 mechanisms actually feels hands-free in practice?
- Pacing mechanism: how does the planner learn estimated-vs-actual effort without burdensome self-report?
- Check-in cadence: evening pings vs. ask-only-when-tomorrow-depends-on-it.
- First-user definition (§2) needs validation against real onboarding.
- Monetization and the LTV shape (low student willingness-to-pay, ≤4-year lifespan) — unaddressed by design for now; revisit after the loop demonstrably retains.

---

## 14. References

- **Beautiful UI harness** — demo: https://www.beautifului.dev/harness · source (MIT, Next.js + Tailwind v4): https://github.com/slev12397/beautiful-ui — the Face shell and primitives.
- **Heptabase AI Tutor** — https://heptabase.com/ai-tutor#explore-learning — reference for lesson UX (parts, progress, chat alongside, notes generated); explicitly *not* our premise (goal-driven tutoring).
- **Photon / Spectrum (iMessage)** — https://photon.codes · docs: https://photon.codes/docs/ · TS SDK: https://github.com/photon-hq/spectrum-ts · pricing: https://photon.codes/pricing · deliverability: https://photon.codes/docs/best-practices/imessage-deliverability · webhooks: https://photon.codes/docs/webhooks/events, https://photon.codes/docs/webhooks/verifying-signatures, https://photon.codes/docs/webhooks/delivery · Convex component: https://photon.codes/blog/your-convex-agent-can-text-now-using-photon · eve channel: https://vercel.com/changelog/imessage-support-for-eve-agents, https://eve.dev/docs/channels/photon — the Voice channel.
- **eve (agent runtime)** — repo: https://github.com/vercel/eve · docs: https://eve.dev/docs, https://vercel.com/docs/eve · launch: https://vercel.com/blog/introducing-eve · sandbox: https://eve.dev/docs/sandbox · connections: https://eve.dev/docs/connections · schedules: https://eve.dev/docs/schedules · evals: https://eve.dev/docs/evals/overview · observability: https://vercel.com/docs/eve/observability · streaming/sessions: https://eve.dev/docs/concepts/sessions-runs-and-streaming · Next.js frontend: https://eve.dev/docs/guides/frontend/nextjs · pricing: https://vercel.com/docs/eve/pricing · critical review: https://zackproser.com/blog/is-vercel-eve-worth-it-agent-framework-review
- **Vercel pricing** — Sandbox: https://vercel.com/docs/sandbox/pricing · Workflows: https://vercel.com/docs/workflows/pricing · Functions: https://vercel.com/docs/functions/usage-and-pricing · Pro plan: https://vercel.com/docs/plans/pro-plan · Spend Management: https://vercel.com/docs/spend-management
- **Canvas LMS API** — https://developerdocs.instructure.com/ — REST, per-user tokens, no push (polling); iCal feeds encode assignment IDs in event UIDs.
- **Convex** — https://convex.dev — DB, real-time, scheduled functions, file storage. **Clerk** — https://clerk.com — auth.
- **AnyDoc** — https://github.com/firecrawl/anydoc — uploaded documents → markdown, MIT, local, no API key. **Firecrawl** — https://firecrawl.dev — course-site crawling only.
- **Braintrust** (optional, later) — eval/trace SaaS eve can report to; local `eve eval` + Vercel Agent Runs suffice for M1–M2.
