# Core — State, Ingestion, Diff, Planner

> Inherits [vision.md](./vision.md) (esp. §5 state model, §6 loop, §7 ingestion, §9 facts vs. inference, §10 stack). Siblings: [voice.md](./voice.md), [face.md](./face.md). This is *what Core delivers for Milestone 1 ("it talks"), how, and how we know it's done* — not a task list.

## Goal

The facts-only state model, the pipes that fill it, the diff engine, and a v0 planner — so Face can render onboarding / Dashboard / Semester and Voice can send a correct first morning text.

**Exit test:** founder's Duke Canvas data + syllabi + course sites → complete, correct deadlines and grading schemes with provenance; a change feed that correctly reports synthetic changes; a feasible-actions set for "tomorrow" that never violates a hard constraint.

## In scope (Milestone 1)

1. Repo scaffold (`convex/`, `app/`, `agent/`); Convex schema + functions; types via Convex codegen consumed by Face and the eve agents.
2. Ingestion adapters (five in M1): Canvas (token), iCal, syllabus PDF, course website, class schedule. Personal calendar is M2.
3. Snapshot → diff → changes, with the two-tier apply/approve rule.
4. Planner v0: feasible actions for a date under hard constraints; nightly precompute cron that triggers Voice.
5. Fixtures + tests from the Duke dataset, including synthetic change scenarios and extraction eval fixtures.

## Not in scope here

- Photon, LLM prompts, voice → `voice.md`. UI → `face.md`.
- Materials library / `prepared` fulfillment (Milestone 3) — but the Canvas adapter *captures* files/modules/pages now (raw, cheap).
- Pacing/compliance learning, browser extension (Milestone 4).

## Stack

Core lives in `convex/` (vision §10 repo shape): schema, ingestion, diff, planner, changes, signals, hydrate queries, usage, crons. **Convex** (DB, real-time, scheduled functions, file storage), **Clerk** (auth). LLM calls through a provider-agnostic layer (Vercel AI SDK) with zod schemas; models chosen per task, swappable. Firecrawl for course sites and PDF→markdown. Agents run on eve (vision §10); Core has no agent code — it is what agents read and write through Convex functions.

## State model — facts, minimal

Principle: store what sources say; derive the rest. Every fact carries `source`, `sourceRef`, `confidence`, `snapshotId`.

- `students` — clerkId, timezone, phone, semester start/end, **class schedule** (hard blocks: parsed from an uploaded schedule image/file or Canvas sections, approved by the student), availability (weekly template + exceptions).
- `courses` — studentId, name, code, sourceRefs (canvasCourseId, icalUrl, siteUrl), gradingScheme (as stated: categories, weights, points, drop rules), status.
- `deadlines` — courseId, title, kind (`homework | project | exam | quiz | reading | other`), dueAt, pointsPossible, category, submissionStatus, description/ref, provenance.
- `tasks` — studentId, courseId?, deadlineId?, title, type (`do | prepared`), status (`todo | in_progress | done | skipped`), plannedFor?, estEffortMin?, actualEffortMin?, createdBy (`agent | student`).
- `changes` — kind (`deadline_added | deadline_moved | deadline_removed | submitted | grade_posted | course_added | chat_decision | ...`), before/after, origin (`canvas | ical | syllabus | site | chat | manual`), tier (`auto | needs_approval`), status (`applied | pending | approved | rejected`), snapshotIds.
- `sources` — studentId, kind, config, lastPolledAt, health.
- `snapshots` — sourceId, fetchedAt, contentHash, raw payload. Immutable, **stored only when the hash changes**; identical polls just bump `sources.lastPolledAt`.
- `materials` — courseId, file ref (Convex storage), origin. Captured now for Milestone 3.
- `usage` — studentId, surface (`voice | workspace | ingestion | planner`), model, promptTokens, completionTokens, costUsd, sessionId?, at. **Written on every LLM call from day one**; the only cost record that survives a runtime change.
- `studentSignals` — studentId, kind (`pacing | availability | preference | difficulty | life_event | other`), text (as observed/told, e.g. "said 2h, took 4h on CS pset 3"), refs (courseId?, deadlineId?, taskId?), origin (`chat | workspace | web | observed`), observedAt, provenance. **Written from day one by every surface**; never aggregated into stored scores (vision §4b).

Not modeled: importance, rhythm, hell weeks. Cheap helpers may compute simple views (weekly deadline density) for the UI, but interpretation belongs to the agent.

## Ingestion design

### Snapshot → diff → changes

Every fetch is stored as an immutable snapshot. `diff(prevNormalized, nextNormalized) → changes[]` is a pure function. State updates come *only* from applied changes.

- Canvas has no push; polling is the only option (start 30 min; back off). Diffing is required anyway.
- **Stale data becomes useful:** hand-mutate or synthesize "next" snapshots from the Duke data to exercise the full pipeline (deadline moved/added/removed, submission landed) without a live semester.
- Replayable, debuggable, provenance for free.

### Two-tier apply rule

- `auto`: changes from authoritative structured sources (Canvas, iCal) apply immediately and appear in the change feed as "new since you last looked."
- `needs_approval`: anything the LLM interpreted (chat, syllabus parse, screenshots, website extraction) or any source conflict → held pending until approved.

### Approval channels and pending semantics (load-bearing — see vision §3.2)

The pending queue must never become a chore inbox. Rules:

1. **Inline chat confirmation is a first-class approval channel**, equal to a web tap. A change born in chat is confirmed in chat in the same exchange ("got it — midterm now Friday, right?" → "yeah" → `approved`, applied). It does *not* also wait in the web queue.
2. **The web queue holds only what chat could not confirm in-flow:** bulk syllabus/site parses at onboarding (bulk approve UI), schedule-upload parses, and source conflicts.
3. **The planner plans on applied facts only.** Any option touched by a pending change is *annotated* (`pending: due date may move to Fri`) so the LLM can see and mention it — never silently planned on, never silently ignored.
4. **Chat drains the queue proactively:** when a pending change enters the planning horizon (would affect the next plan), the nightly pass surfaces it for a one-word confirmation in the morning text. Nothing rots because the student didn't open the Dashboard.
5. Pending changes older than the horizon with no signal are dropped with a note in the feed, not applied.

### Adapters (each: `fetch → snapshot`, `normalize → courses/deadlines/materials`)

1. **Canvas** — REST, per-user token, Link-header pagination. Courses, assignments (due, points, group weights), submissions, plus files/modules/pages/announcements (raw). Handle unpublished/concluded courses (Duke data ~half unpublished). Verify rate limits at developerdocs.instructure.com.
2. **iCal** — VEVENTs → deadlines (title + date only). Canvas iCal feeds encode the assignment ID in the event UID (`event-assignment-<id>`), so dedupe against the Canvas adapter is an **exact join on ID**; fuzzy title/date matching is only the fallback for non-Canvas feeds. Canvas wins on conflict.
3. **Syllabus PDF** — Firecrawl → markdown → LLM extraction into zod schema: grading scheme, exam dates, dated readings/psets → deadlines. Every item carries confidence + page ref; all of it is `needs_approval` at onboarding (bulk-approve UI).
4. **Course website** — Firecrawl → markdown → same extraction schema.
5. **Class schedule** — uploaded image/file (or Canvas sections/iCal class events where available) → LLM extraction into weekly hard blocks → `needs_approval` (student verifies the parse in a simple weekly view) → becomes the planner's class boundaries.
6. **Personal calendar** (Milestone 2) — Google/Apple calendar read access → busy blocks and life events (not deadlines). Trivial OAuth compared to school email; turns availability from a static grid into reality.

Merge precedence: Canvas (status/dates) > syllabus (grading scheme) > iCal > site. Unresolvable conflict → `needs_approval`, never a silent pick.

## Planner v0

`feasibleActions(studentId, date) → option[]` — for each open task/deadline within horizon, the windows it could fit given availability, class blocks, and due dates; each option annotated with plain facts (due in N days, points/category, remaining windows before due). No LLM. No importance formula — the annotations *are* what the LLM weighs. Hard guarantee: never proposes a window that overlaps a class or a time after the due date.

**Effort estimates (decided):** v0 uses crude priors by deadline kind (reading 45m, homework 2h, quiz prep 1h, project 4h, exam prep 3h — tune on Duke data) as **low-confidence estimates**, labeled as such in the annotation; `studentSignals` on pacing override them per course when present. Enough to size windows; the agent treats them as hints, not facts.

**Nightly precompute (Convex cron):** for each active student, compute tomorrow's feasible set, pending-change annotations, and a signals digest, store the snapshot, then trigger the eve Voice run (`POST /eve/v1/session` with an idempotent `operationId`). Convex decides who gets a run; eve decides what to say (voice.md M1 #2).

## What Core hands to Voice and Face

- Onboarding pipeline: `addSource → fetch → normalize → pendingChanges[]` → bulk approve → state.
- Live queries (Convex): courses, deadlines, tasks, changes (pending/recent), all real-time for Dashboard/Semester.
- **The three Voice tools** (the entire surface Voice has on Core): `getFeasibleActions(studentId, date)` — options annotated with facts, effort priors, and relevant `studentSignals`; `proposeChange(change)` — the only mutation path, always through `changes` with tier/approval semantics; `recordSignal(signal)` — writes `studentSignals`. Nothing else is reachable from the agent.
- `studentSignals` read/write for Voice and the workspace agent; a shared "recently discussed" view for Dashboard ordering.
- **Workspace hydration data** (M3): everything `hydrateWorkspace(studentId, courseId)` needs, as Convex queries — course materials (or a manifest for fetch-on-demand), deadlines/grading/plan for `state.md`, signals digest for `signals.md`, recent conversation summaries, prior artifacts. Core owns the queries; Face owns the rendering into files.
- Agent tools are the *only* write path from eve into Core, and they all emit `changes` (vision §10 truth rule).
- Mid-semester onboarding: past deadlines default `submitted` if Canvas says so; otherwise one prompt.

## Test data & limitations

- Founder's Duke token (~half courses published) + course sites/syllabi. Capture snapshots into scrubbed fixtures early so tests don't depend on Duke.
- Stale: no real-time dynamics; synthetic change fixtures cover it. Live behavior validated once friends' tokens exist.
- Canvas per-user token is ToS-gray, may break silently → `sources.health` surfaced in Face.

## Definition of done

- [ ] Repo + Convex + Clerk scaffold; Convex codegen types consumed by `app/` and `agent/`.
- [ ] Snapshot/diff/changes with tests on synthetic fixtures; two-tier rule enforced.
- [ ] Five adapters (Canvas, iCal, syllabus, site, schedule) normalize Duke data; merge precedence implemented.
- [ ] **Extraction eval fixtures checked in:** every Duke syllabus, course site, and schedule upload has a hand-verified expected-output fixture; the extraction pipelines run against them in CI. (eve's `defineEval` guards the agents; nothing else guards the Convex-side extraction.)
- [ ] `feasibleActions` with constraint tests; effort priors labeled low-confidence.
- [ ] Nightly precompute cron stores a snapshot and triggers a Voice run with an idempotent `operationId`.
- [ ] Mid-semester path works.

## Open questions

- Availability beyond class blocks: how much to ask up front vs. learn from behavior.
- Polling cadence and Canvas rate limits.

## References

- Canvas LMS API — https://developerdocs.instructure.com/
- Convex — https://convex.dev · Clerk — https://clerk.com · Firecrawl — https://firecrawl.dev
