# Product Vision — Student Execution Agent

> **Purpose of this doc.** This is the durable, high-level statement of what we're building and why. Any future agent or teammate should be able to read this and understand where we're coming from before touching anything. Phase-level planning docs live alongside this in `plans/` and inherit this context. When a decision here changes, change it here.

---

## 1. Thesis

The problem for college students is not knowing what is due. It is the **cognitive load of deciding what to do, when to do it, and how to recover when plans break.**

The product is a **student execution agent** — not a chatbot, tutor, calendar, or generic planner. It maintains a live model of the student's courses, workload, deadlines, available time, and progress, and continuously turns that state into a realistic plan and a recommended next action.

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
4. **Trust doesn't survive a caused missed deadline.** The factual layer can never hallucinate (see §8 — this is the reason the architecture has a deterministic core).
5. **Channel risk (accepted).** The daily loop rides on iMessage via unofficial infrastructure (Photon). Apple has killed such products before (Beeper). We take this risk deliberately — iMessage is that much better than SMS on cost, richness, and where students actually live. Mitigation: keep the delivery layer thin so the channel is an adapter, not the architecture; a channel death should be a painful week, not a rewrite.
6. **Structural churn and seasonal acquisition.** Semesters end, summers are dead, users graduate; peak onboarding motivation is a two-window-a-year event (September/January). We must support **mid-semester onboarding**: assume N topics covered and M assignments done, backfill from what sources give us, and move forward — a degraded-but-real path, not a locked door.

---

## 4. Voice & personality (product-critical, not cosmetic)

Part of the college experience is messing around and being a non-ideal student. The agent accepts this as reality instead of fighting it — the goal is to meet students where they are, not to change ingrained behaviors. Tone = **competent friend doing triage**, never nagging parent. No guilt, no moralizing, no fake enthusiasm. Replans are matter-of-fact and realistic. The voice ships as written guidelines for the LLM layer and is a first-class product asset.

---

## 5. State model (the core asset)

Everything else in the product is a view over this state.

- **Course:** grade weights, deadline list, recurring rhythm (lecture/reading/PSet cadence), materials library.
- **Task:** estimated effort, actual effort history, grade impact, status, due date, type (`do` | `prepared` — typed from day one so new fulfillment types are added as handlers, not restructures).
- **Student (global):** available time blocks, observed pacing (planning must learn the gap between estimated and actual effort — exact mechanism TBD; this is a realism feature, not a moat), compliance patterns (never works Friday nights → stop scheduling Friday nights).

**Defensibility lives in the accumulated state model** (switching cost once it knows your semester) **and in earned trust** (a student rescued from two broken weeks doesn't leave) — not in any single learned parameter.

---

## 6. The loop

1. **Nightly plan pass** → tomorrow's 1–3 recommended actions.
2. **Morning push** over iMessage.
3. **Replan on miss** — the triage moment described in §3.
4. **Ambient updates any time** in natural language ("exam moved to Friday", "not doing this, rework the plan") → state update → replan. Conversation happens in iMessage; organization, semester view, and accumulated resources live on the web app.

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

### Development reality (until semester start)

We have no live student data until the semester begins and friends hand over Canvas tokens. Until then we build and demo against the founder's old Duke account: a personal Canvas token with roughly half the courses still published, plus the associated course websites. This is **stale data** — good for exercising ingestion, parsing, and the semester-picture payoff; useless for testing real-time behavior (new assignments appearing, deadlines moving, submissions landing). Canvas also has no push/WebSocket API, so live updates will be **polling-based** regardless. Plan accordingly: Phase 1 proves ingestion correctness on stale data; real-time dynamics get validated only once live tokens exist. Details in the Phase 1 plan.

### Email integration (deferred)

School email is usually institutional Microsoft 365 behind SSO — real integration is a headache (and consumer Gmail scopes require a paid security assessment). Deferred. The email-in forwarding address above is the zero-integration stopgap.

### Onboarding is an investment moment, not a chore

~15 minutes at semester start (the natural high-motivation window — students buy planners in September). The payoff must be immediate and visceral: the agent instantly renders the full-semester picture ("3 hell weeks: Oct 12, Nov 2, finals; your Tuesdays are structurally overloaded"). Setup that returns insight feels like power; setup that returns an empty dashboard feels like homework. Mid-semester onboarding (§3.6) gets the same treatment on partial data.

---

## 8. Architecture: hybrid planner with a precise seam

**Deterministic layer owns facts and invariants:** state model, candidate task list, hard constraints (due dates, available windows, never schedule over classes), grade-impact math, pacing adjustments. Output: a scored, *feasible* option set.

**LLM layer owns judgment and language:** choosing among feasible options, weighting soft context ("he's stressed about chem"), interpreting messy student replies into state updates ("yeah i didnt do it lol im going out"), and all outbound communication. The LLM freestyles **within** the feasible set; it never generates the set.

**Rationale — asymmetric failure modes.** LLM picks a suboptimal-but-feasible plan → mediocre day. LLM hallucinates the set (invents a free window, misremembers a due date, drops a task) → missed deadline → trust death. The deterministic layer exists to make LLM mistakes non-catastrophic, not to limit its intelligence.

Side benefit: "why this?" gets a true, legible answer ("worth 25%, due Thursday, last 2-hour window") instead of a post-hoc rationalization. Cheap to build this way from the start; expensive to retrofit.

---

## 9. Interfaces

- **iMessage (via Photon / photon.codes Spectrum)** — the daily loop: morning actions, check-ins, renegotiation, updates, and ad-hoc material ingestion (attachments). Meeting students where they already are is part of the product insight, not plumbing. Nobody opens a planner web app at 11pm; everyone reads texts. (Channel risk accepted and mitigated per §3.5.)
- **Web app** — onboarding, semester view / workload map, state editing, and the **resource library** where prepared materials accumulate (the legitimate daily web-app use: finding and using resources). UI/UX and scope here still need real definition — tracked as an open question.

---

## 10. Explicitly not building now

- Institutional / LMS-side integration of any kind.
- Real email integration (OAuth/SSO into school Microsoft 365 or Gmail).
- Browser extension (candidate for a later phase).
- Tutoring / pedagogy / mastery modeling. We prepare and schedule; we don't teach.

## 11. Open questions

- Materials access end-state: which combination of §7 mechanisms actually feels hands-free in practice?
- Pacing mechanism: how does the planner learn estimated-vs-actual effort without burdensome self-report?
- Web app scope and UX: what belongs there beyond onboarding, semester map, and the resource library?
- First-user definition (§2) needs validation against real onboarding.
- Monetization and the LTV shape (low student willingness-to-pay, ≤4-year lifespan) — unaddressed by design for now; revisit after the loop demonstrably retains.
