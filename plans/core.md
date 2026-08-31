# Core — State, Ingestion, Diff, Planner

> Inherits [vision.md](./vision.md) (esp. §5 state model, §6 loop, §7 ingestion, §9 facts vs. inference, §10 stack). Siblings: [voice.md](./voice.md), [face.md](./face.md). This is *what Core delivers for Milestone 1 ("it talks"), how, and how we know it's done* — not a task list.

## Goal

The facts-only state model, the pipes that fill it, the diff engine, and a v0 planner — so Face can render onboarding / Dashboard / Semester and Voice can send a correct first morning text.

**Exit test:** spec-derived Canvas fixtures + any real syllabi / course sites → complete, correct deadlines and grading schemes with provenance; a change feed that correctly reports synthetic changes; a feasible-actions set for "tomorrow" that never violates a hard constraint.

## In scope (Milestone 1)

1. Repo scaffold (`convex/`, `app/`, `agent/`); Convex schema + functions; types via Convex codegen consumed by Face and the eve agents.
2. Ingestion adapters (five in M1): Canvas (token), iCal, syllabus PDF, course website, class schedule. Personal calendar is M2.
3. Snapshot → diff → changes, with the two-tier apply/approve rule.
4. Planner v0: feasible actions for a date under hard constraints; nightly precompute cron that triggers Voice.
5. Spec-derived Canvas/iCal fixtures + real documents, including synthetic change scenarios and extraction eval fixtures.

## Not in scope here

- Photon, LLM prompts, voice → `voice.md`. UI → `face.md`.
- Materials library / `prepared` fulfillment (Milestone 3) — but the Canvas adapter *captures* files/modules/pages now (raw, cheap).
- Pacing/compliance learning, browser extension (Milestone 4).

## Stack

Core lives in `convex/` (vision §10 repo shape): schema, ingestion, diff, planner, changes, signals, hydrate queries, usage, crons. **Convex** (DB, real-time, scheduled functions, file storage), **Clerk** (auth). LLM calls through a provider-agnostic layer (Vercel AI SDK) with zod schemas; models chosen per task, swappable. **AnyDoc** (Firecrawl's MIT Rust library, Node bindings, no API key) for all uploaded documents → markdown (PDF, Word, PPT, Excel, EPUB…), run locally in a Convex **Node action** (`convex.json` `node.externalPackages: ["@firecrawl/anydoc"]`; the importing lib file needs its own `"use node"` since Convex bundles every convex/ file as an entry point) — verified end to end; student documents never leave our infra; scanned/image PDFs fall back to a vision-capable model. Hosted Firecrawl API only for crawling course websites. Agents run on eve (vision §10); Core has no agent code — it is what agents read and write through Convex functions.

## State model — facts, minimal

Principle: store what sources say; derive the rest. Every fact carries `source`, `sourceRef`, `confidence`, `snapshotId`.

- `students` — clerkId, timezone, phone, semester start/end, **class schedule** (hard blocks: parsed from an uploaded schedule image/file or Canvas sections, approved by the student), availability (weekly template + exceptions).
- `courses` — studentId, name, code, sourceRefs (canvasCourseId, icalUrl, siteUrl), gradingScheme (as stated: categories, weights, points, drop rules), status.
- `deadlines` — courseId, title, kind (`homework | project | exam | quiz | reading | other`), dueAt, pointsPossible, category, submissionStatus, description/ref, provenance.
- `tasks` — studentId, courseId?, deadlineId?, title, type (`do | prepared`), status (`todo | in_progress | done | skipped`), plannedFor?, estEffortMin?, actualEffortMin?, createdBy (`agent | student`).
- `changes` — kind (`deadline_added | deadline_moved | deadline_updated | deadline_removed | submitted | grade_posted | course_added | course_updated | task_created | task_updated | availability_updated | chat_decision | other`), before/after, origin (`canvas | ical | syllabus | site | chat | manual | schedule`), tier (`auto | needs_approval`), status (`applied | pending | approved | rejected | expired` — `expired` is rule 5's "dropped with a note", a terminal state distinct from a student's `rejected`), snapshotIds. Removals are soft: `deadline_removed` sets `deadlines.status: "removed"` (never deletes — the row is the audit trail and the diff base); unpublished Canvas courses land as `courses.status: "hidden"`.
- `sources` — studentId, kind, config, lastPolledAt, health.
- `snapshots` — sourceId, fetchedAt, contentHash, raw payload. Immutable, **stored only when the hash changes**; identical polls just bump `sources.lastPolledAt`. The hash covers *content only* — `fetchedAt` is excluded from identity, or every poll would look new and the rule would be inoperative on live sources.
- `materials` — courseId, file ref (Convex storage), origin. Captured now for Milestone 3. Materials are upserted directly, **not** through `changes`: they are raw source captures (files/modules/pages/announcements as Canvas served them), not facts about the student's obligations — nothing to approve, nothing the planner reads. The `changes` rule covers student state.
- `usage` — studentId, surface (`voice | workspace | ingestion | planner`), model, promptTokens, completionTokens, costUsd, sessionId?, at. **Written on every LLM call from day one**; the only cost record that survives a runtime change.
- `studentSignals` — studentId, kind (`pacing | availability | preference | difficulty | life_event | other`), text (as observed/told, e.g. "said 2h, took 4h on CS pset 3"), refs (courseId?, deadlineId?, taskId?), origin (`chat | workspace | web | observed`), observedAt, provenance. **Written from day one by every surface**; never aggregated into stored scores (vision §4b).
- `planRuns` — the nightly precompute's stored output (feasible set, pending annotations, signals digest) plus the idempotent `operationId` and trigger status for the eve run. A **cache of a derived view, not truth** (always recomputable from facts); Voice reads it via `getFeasibleActions`, which serves a run computed within the last 6h *unless a change was applied since it was computed* — then it recomputes, so an inline confirmation is visible in the very next tool call.

Not modeled: importance, rhythm, hell weeks. Cheap helpers may compute simple views (weekly deadline density) for the UI, but interpretation belongs to the agent.

## Ingestion design

### Snapshot → diff → changes

Every fetch is stored as an immutable snapshot. `diff(prevNormalized, nextNormalized) → changes[]` is a pure function. State updates come *only* from applied changes.

- Canvas has no push; polling is the only option (start 30 min; back off). Diffing is required anyway.
- **No live data needed to test it:** mutate spec-derived fixture snapshots to exercise the full pipeline (deadline moved/added/removed, submission landed) without any Canvas access.
- Replayable, debuggable, provenance for free.
- Submission-status *regressions* (submitted → unsubmitted, graded → submitted) are first-class `deadline_updated` changes — a retracted grade must reopen the row, not read as progress; the planner's closed-deadline filter depends on it.
- Source configs are validated at registration: http(s) URLs only, no credentials in URLs, no loopback/private/link-local hosts (a Canvas base URL is fetched server-side with a bearer token — SSRF surface).

### Two-tier apply rule

- `auto`: changes from authoritative structured sources (Canvas, iCal) apply immediately and appear in the change feed as "new since you last looked."
- `needs_approval`: anything the LLM interpreted (chat, syllabus parse, screenshots, website extraction) or any source conflict → held pending until approved.

### Approval channels and pending semantics (load-bearing — see vision §3.2)

The pending queue must never become a chore inbox. Rules:

1. **Inline chat confirmation is a first-class approval channel**, equal to a web tap. A change born in chat is confirmed in chat in the same exchange ("got it — midterm now Friday, right?" → "yeah" → `approved`, applied). It does *not* also wait in the web queue. Every inline confirmation carries **evidence** — the student's confirming reply quoted verbatim (plus the message id when available), stored on the change and shown in the feed ("confirmed in chat: 'yeah'"). Accountability, not proof: the claim is visible and contestable; verifying the message id against the inbound log comes with webhook dedupe.
2. **The web queue holds only what chat could not confirm in-flow:** bulk syllabus/site parses at onboarding (bulk approve UI), schedule-upload parses, and source conflicts.
3. **The planner plans on applied facts only.** Any option touched by a pending change is *annotated* (`pending: due date may move to Fri`) so the LLM can see and mention it — never silently planned on, never silently ignored.
4. **Chat drains the queue proactively:** when a pending change enters the planning horizon (would affect the next plan), the nightly pass surfaces it for a one-word confirmation in the morning text. Nothing rots because the student didn't open the Dashboard.
5. Pending changes older than the horizon with no signal are dropped with a note in the feed, not applied.

### Adapters (each: `fetch → snapshot`, `normalize → courses/deadlines/materials`)

1. **Canvas** — REST, per-user token, Link-header pagination. Courses, assignments (due, points, group weights), submissions, plus files/modules/pages/announcements (raw). Handle unpublished/concluded courses. Verify rate limits at developerdocs.instructure.com.
2. **iCal** — VEVENTs → deadlines (title + date only). Canvas iCal feeds encode the assignment ID in the event UID (`event-assignment-<id>`), so dedupe against the Canvas adapter is an **exact join on ID**; fuzzy title/date matching is only the fallback for non-Canvas feeds. Canvas wins on conflict.
3. **Syllabus PDF** — AnyDoc → markdown → LLM extraction into zod schema: grading scheme, exam dates, dated readings/psets → deadlines. Every item carries the model's confidence + a verbatim `sourceText` quote and page ref; all of it is `needs_approval` at onboarding (bulk-approve UI). Date rules (extract-don't-infer, vision §9, enforced by the evals): a syllabus rarely states years, so the model reports month-day and **our code resolves the year from the term window** — a date that fits no year in the window (±21 days slack) is dropped with a reason, never guessed; "pset due every Friday" emits ONE undated series item, never expanded dates (an invented date is a hard eval failure), and a count ("there will be 6 problem sets") is likewise one item — the prompt says so, but at temperature 0 the model still enumerates 1–6 on some runs, so the invariant is enforced in code: three or more undated, numbered items quoting the *identical* sentence collapse to one series item, the rest recorded as dropped. A syllabus whose course can't be resolved proposes `course_added` and defers its deadlines until that's approved (a pending course can't mint the `courseId` its deadlines need); against an existing course it proposes only the `gradingScheme` — never name/code. Extracted deadlines dedupe per-course against stored rows: same title+day → nothing (a re-statement isn't news); same title, different day → `deadline_moved` with `conflict: true` (syllabus never silently outranks Canvas on dates); unmatched → `deadline_added`.
4. **Course website** — Firecrawl **keyless scrape, not crawl** → markdown → same extraction schema. Keyless (`POST /v2/scrape`, no Authorization header, 1,000 free credits/mo + per-IP daily caps) covers scrape/search/parse but NOT `/crawl`/`/map`, so the adapter scrapes the seed URL, extracts same-origin links from the returned markdown, and scrapes at most 4 more pages — plenty for a course site, and a keyed crawl is a config upgrade if scale ever demands it. A 429 records source health `error` ("keyless daily cap"), not a retry loop. Site sources re-poll via `pollAll`; uploads stay event-driven.
5. **Class schedule** — uploaded image/file (or Canvas sections/iCal class events where available) → LLM extraction into weekly hard blocks → `needs_approval` (student verifies the parse in a simple weekly view) → becomes the planner's class boundaries.
6. **Personal calendar** (Milestone 2) — Google/Apple calendar read access → busy blocks and life events (not deadlines). Trivial OAuth compared to school email; turns availability from a static grid into reality.

Merge precedence: Canvas (status/dates) > syllabus (grading scheme) > iCal > site; `manual` and `chat` sit above all sources for the fields the student explicitly set (the student outranks their sources about their own life). The order follows *how directly each source witnesses the fact*: Canvas is the system of record the professor actually edits — its dates and submission states are operational data, not descriptions of it. The syllabus outranks Canvas only for the grading scheme because that is the one thing professors state in prose and rarely encode in Canvas correctly (weights, drop rules); it never outranks Canvas on dates, which drift after week 1. iCal is Canvas's own feed minus fields (titles + dates only), so it can never beat the API it mirrors — it exists for students without a token. Course sites are the loosest witness (hand-edited HTML, LLM-extracted) and go last. Unresolvable conflict → `needs_approval`, never a silent pick — including one-sided disagreements (iCal has a date Canvas lacks). iCal items that resolve to no known course land in a per-feed fallback course ("Calendar (host)") rather than being dropped: `deadlines.courseId` is required, and losing a deadline is worse than a cosmetic bucket the student can re-file.

## Planner v0

`feasibleActions(studentId, date) → option[]` — for each open task/deadline within horizon, the windows it could fit given availability, class blocks, and due dates; each option annotated with plain facts (due in N days, points/category, remaining windows before due). No LLM. No importance formula — the annotations *are* what the LLM weighs. Hard guarantee: never proposes a window that overlaps a class or a time after the due date. **Overdue unsubmitted deadlines stay in the option set** (within a 14-day lookback) flagged `overdue`, with an empty window list and a "past due" fact — the agent must be able to name a missed deadline in a replan (vision §3.3); the guarantee holds because no window is ever offered for them.

**Effort estimates (decided):** v0 uses crude priors by deadline kind (reading 45m, homework 2h, quiz prep 1h, project 4h, exam prep 3h — tune on real syllabi) as **low-confidence estimates**, labeled as such in the annotation; `studentSignals` on pacing override them per course when present. Enough to size windows; the agent treats them as hints, not facts.

**Nightly precompute (Convex cron):** for each active student (paginated, one scheduled run per student), compute tomorrow's feasible set, pending-change annotations, and a signals digest, store the snapshot, then trigger the eve Voice run (`POST /eve/v1/session` with an idempotent `operationId`). A failed or stuck trigger is retried by later hourly passes for up to 6 hours after the student's nightly hour; missing eve config records `skipped` rather than failing the pass. Convex decides who gets a run; eve decides what to say (voice.md M1 #2).

## What Core hands to Voice and Face

- Onboarding pipeline: `addSource → fetch → normalize → pendingChanges[]` → bulk approve → state.
- Live queries (Convex): courses, deadlines, tasks, changes (pending/recent), all real-time for Dashboard/Semester.
- **The three Voice tools** (the entire surface Voice has on Core): `getFeasibleActions(studentId, date)` — options annotated with facts, effort priors, and relevant `studentSignals`; `proposeChange(change)` — the only mutation path, always through `changes` with tier/approval semantics, origin forced to `chat` server-side (Voice cannot claim an authoritative origin or supply provenance, so it can never self-elevate to the `auto` tier; on `students`, chat-origin changes may touch only the five scheduling fields — never phone/status/timezone/identity); `recordSignal(signal)` — writes `studentSignals`. Nothing else planning-shaped is reachable from the agent; two bookkeeping routes ride alongside (`logUsage` — the mandatory per-call cost log, vision §10 — and `resolveStudent`, phone → student, needed before any tool can be called). Contract: `convex/VOICE_TOOLS.md`.
- `studentSignals` read/write for Voice and the workspace agent; a shared "recently discussed" view for Dashboard ordering.
- **Workspace hydration data** (M3): everything `hydrateWorkspace(studentId, courseId)` needs, as Convex queries — course materials (or a manifest for fetch-on-demand), deadlines/grading/plan for `state.md`, signals digest for `signals.md`, recent conversation summaries, prior artifacts. Core owns the queries; Face owns the rendering into files.
- Agent tools are the *only* write path from eve into Core, and they all emit `changes` (vision §10 truth rule).
- Mid-semester onboarding: past deadlines default `submitted` if Canvas says so; otherwise one prompt.

## Test data & limitations — build to spec, validate later

**No live Canvas of any kind until a friend's token arrives (a few days after v1).** Duke no longer issues tokens to alumni, the Free-for-Teacher sandbox is not available, and the founder's Duke iCal feed is too stale to trust. Decision: **build every adapter to the published spec now, validate on a real account later.** Concretely:

- **Canvas fixtures are hand-authored from Instructure's API docs** (developerdocs.instructure.com publishes an example JSON response per endpoint): courses, assignments (incl. assignment groups/weights), submissions, files/modules/pages/announcements, plus `Link`-header pagination samples. Shapes and field names come from the docs, never from memory. Fixtures live in `fixtures/canvas/` and are committed (they contain no real data).
- **Synthetic change scenarios** are derived from those fixtures (deadline moved / added / removed, submission landed) and drive the diff → changes tests.
- **iCal fixtures** are hand-authored `.ics` files using Canvas's `event-assignment-<id>` UID convention, so the exact-join dedupe is tested.
- Syllabus / site / schedule adapters run on whatever real documents the founder supplies; until then, one or two public syllabi from the web.
- **Deferred to the live-validation pass (first friend's token):** rate limits, real pagination behavior, unpublished/concluded course handling, submission-status edge cases, and the `Link` header in practice. Expect a short fix-up cycle then; design the adapter so the fetch layer is thin and swappable.
- Canvas per-user token is ToS-gray on institutional instances and may break silently → `sources.health` surfaced in Face.
- **The live-validation checklist is written and lives at [live-validation.md](./live-validation.md)** — run it the day a real token arrives; it is the deferred list above, made concrete per endpoint.

## Definition of done

- [ ] Repo + Convex + Clerk scaffold; Convex codegen types consumed by `app/` and `agent/`.
- [ ] Snapshot/diff/changes with tests on synthetic fixtures; two-tier rule enforced.
- [ ] Five adapters (Canvas, iCal, syllabus, site, schedule) normalize spec fixtures + real documents; merge precedence implemented.
- [x] **Extraction eval fixtures checked in:** every syllabus, course site, and schedule fixture has a hand-verified expected-output fixture (public sources: MIT OCW 6.0001, Stanford CS103, CMU 15-213; schedule synthetic — a real one is private); `pnpm eval` runs live extraction against them in CI (gated on the gateway secret). Thresholds: deadline F1 ≥ 0.8 (fuzzy title, Dice ≥ 0.5), grading weights exact (normalized as a set), stated dates exact, and **any invented date fails regardless of F1** — the recurrence-expansion bug the first eval run caught is exactly what this guards. (eve's `defineEval` guards the agents; this guards the Convex-side extraction.)
- [ ] `feasibleActions` with constraint tests; effort priors labeled low-confidence.
- [ ] Nightly precompute cron stores a snapshot and triggers a Voice run with an idempotent `operationId`.
- [ ] Mid-semester path works.
- [ ] **Live-validation checklist written** (what to verify the day a real token arrives) — see Test data.

## Open questions

- Availability beyond class blocks: how much to ask up front vs. learn from behavior.
- Polling cadence and Canvas rate limits.

## References

- Canvas LMS API — https://developerdocs.instructure.com/
- Convex — https://convex.dev · Clerk — https://clerk.com · AnyDoc — https://github.com/firecrawl/anydoc (docs→markdown, MIT, keyless) · Firecrawl — https://firecrawl.dev (course-site crawling only)
