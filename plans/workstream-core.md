# Workstream: Core — State & Ingestion

> Inherits [vision.md](./vision.md) (esp. §5 state model, §7 ingestion, §9 facts vs. inference, §11 workstreams). This doc covers *what Core delivers for Milestone 1, how it's built, and how we know it's done.* Sibling docs: `workstream-thread.md`, `workstream-web.md` (to be written). Not a task list — those get generated from this.

## Goal

Build the core asset (facts-only state model) and the pipes that fill it, so that Web can render the onboarding briefing / Dashboard / Semester and Thread can send a correct first morning text (Milestone 1: "it talks").

**Exit test:** the founder's Duke Canvas data + syllabi + course sites → normalized facts that are complete and correct (every deadline, grading category, exam), with provenance, plus computed observations that say at least one non-obvious true thing ("3 hell weeks; Tuesdays structurally overloaded").

## In scope (Milestone 1)

1. Monorepo scaffold, shared state model + DB schema, exported types consumed by Web and Thread.
2. Ingestion adapters: Canvas API (token), iCal feeds, syllabus PDF, course websites.
3. Snapshot→diff→events sync — built now, exercised on stale data.
4. Derived layer: importance, weekly workload, structural observations (pure functions over facts).
5. Planner v0: feasible option set for "tomorrow" (hard constraints only) — enough for Thread's morning text.
6. Test harness + fixtures from the Duke dataset.

## Not in scope here

- Photon / LLM / voice → `workstream-thread.md`. UI → `workstream-web.md`.
- Materials library, S3/R2, `prepared` fulfillment (Milestone 3) — but the Canvas adapter *captures* files/modules now.
- Pacing/compliance learning, browser extension (Milestone 4).

## Stack (decided — see vision §10)

- **TypeScript everywhere. No Python.** One state model, one set of types.
- Monorepo (pnpm workspaces + Turborepo):
  ```
  packages/core     state model, Drizzle schema, ingestion adapters, snapshot-diff, (later) planner
  apps/web          Next.js (App Router) — onboarding, semester map, state editing
  apps/agent        Photon webhooks, LLM layer, scheduler (Thread workstream)
  ```
- Postgres (Neon or Supabase) + Drizzle ORM. Zod for all LLM I/O boundaries.
- Anthropic SDK for syllabus/website parsing (PDFs passed natively, structured output via tool-use + zod).
- Firecrawl for course websites → markdown.
- Node runtime.
- No agent framework (LangGraph etc.) — plain TS orchestration; revisit only if flows demand it.

## State model (v1 schema) — facts only

Principle (vision §9): tables store what sources *say*; anything derived is a pure function, not a column. Keep it minimal; typed for extension.

- `students` — id, timezone, availability blocks (weekly template + exceptions), semester start/end.
- `courses` — student_id, name, code, source refs (canvas_course_id, ical_url, site_url), **grading scheme as stated** (jsonb: categories with weight/points/drop rules + provenance), **schedule facts as stated** (jsonb: e.g. `week 3: read ch. 5–6`, `pset every Fri` — extracted, not inferred), status.
- `tasks` — course_id, title, type (`do | prepared`), due_at, points_possible, category, status (`todo | in_progress | done | skipped`), source (`canvas | ical | syllabus | site | manual`), source_ref, confidence, est_effort_min / actual_effort_min (nullable, learned later).
- `sources` — student_id, kind, config (token/url), last_polled_at, health.
- `snapshots` — source_id, fetched_at, raw payload (jsonb). Immutable.
- `events` — derived changes: `task_added | due_moved | task_removed | submitted | grade_posted`, with before/after, source snapshot ids. Feeds replanning.

**Derived (functions in `core`, never stored as truth):** `importance(task)` — a simple ordinal from category weight + points + proximity, explicitly *not* a grade formula (dropped lowest, half-counting quizzes, curves make any formula wrong); `weeklyLoad`, `hellWeeks`, `structuralObservations`; later rhythm and pacing.

Provenance and confidence on every fact from day one — the "never hallucinate a fact" rule needs to know where each fact came from.

## Ingestion design

### Snapshot → diff → events (the core pattern)

Every fetch is stored as an immutable snapshot. A pure function `diff(prev, next) → events[]` derives changes. State is updated *from events*, never directly from a fetch. Why:
- Canvas has no push; polling is the only option, so we need diffing anyway.
- **It makes stale data useful:** we can hand-mutate or synthetically generate a "next" snapshot from the Duke data and exercise the full change pipeline (due date moved, assignment added) without a live semester.
- Replayable: re-run history for debugging; provenance is free.

### Adapters (each: `fetch → snapshot`, `normalize → tasks/courses`)

1. **Canvas** — REST, per-user token, `Link`-header pagination. Pull: courses, assignments (due, points, group weights), submissions (status/score), and *also files/modules/pages/announcements now* (store raw; used at Milestone 3 — costs nothing to capture early). Handle unpublished/concluded courses gracefully (Duke data is ~half unpublished).
2. **iCal** — parse VEVENTs; titles + due dates only. Dedupe against Canvas by title/date fuzzy match; Canvas wins on conflict.
3. **Syllabus PDF** — Claude native PDF → zod schema: grade weights, exam dates, recurring schedule, policies (late, drops). Every extracted item carries a confidence + source page. Low-confidence items surface for one-tap confirmation in onboarding, not silent insertion.
4. **Course website** — Firecrawl → markdown → same extraction schema as syllabus.

### Merge & conflict rules

Sources overlap. Rule of thumb: Canvas (authoritative for status/dates) > syllabus (authoritative for weights/rhythm) > iCal > site. Conflicts that can't be auto-resolved become onboarding confirmation prompts. Never silently pick.

## What Core hands to Web and Thread

- **Onboarding contract:** `addSource → fetch → normalize → confirmations[]` (low-confidence facts needing one tap) → `commit`. Web owns the UI; Core owns the pipeline.
- **Briefing data:** courses + grading schemes, task list, `weeklyLoad`, `hellWeeks`, `structuralObservations` — deterministic facts the LLM narrates over (one paragraph), never invents.
- **Planner v0:** `feasibleActions(student, date) → scored options[]` respecting due dates, availability, no overlap with classes. Thread's LLM picks within this set.
- **Mid-semester onboarding:** past-due tasks default `done` if Canvas says submitted; otherwise one prompt ("mark everything before today done?"). Same pipeline, partial data.

## Test data & known limitations

- Dataset: founder's Duke Canvas token (~half courses published), plus course sites/syllabi where retrievable. Capture full snapshots early and check them into a fixtures dir (scrubbed) so tests don't depend on Duke keeping the courses up.
- **Stale:** no real-time dynamics. Synthesize change scenarios by mutating snapshots (fixtures for: due moved, task added, task removed, submission landed).
- Canvas polling cadence TBD (start: every 30 min; back off on no-change). Verify rate limits from developerdocs.instructure.com.
- Canvas per-user token is ToS-gray and can break silently → `sources.health` + surfaced in web app.

## Definition of done

- [ ] Monorepo scaffolds, `core` importable from `web`.
- [ ] Schema migrated; snapshot/diff/events pipeline with tests on synthetic change fixtures.
- [ ] All four adapters produce normalized tasks/courses from Duke data; merge rules implemented.
- [ ] Syllabus extraction ≥ manually verified correct on all Duke syllabi (weights, exam dates).
- [ ] Derived layer + planner v0 with tests; briefing data passes the exit test above.
- [ ] Types/contracts consumed by Web and Thread without leaking DB details.
- [ ] Mid-semester onboarding path works on the same data.

## Open questions

- Neon vs Supabase (Supabase gives auth for free; Neon is leaner). Lean Supabase for auth unless we pick Clerk.
- Auth provider for the web app (needed for onboarding). Clerk vs Supabase auth.
- Availability capture in onboarding: import a class schedule from Canvas/iCal automatically vs manual weekly grid. Aim: auto from Canvas course sections; manual fallback.
- Importance heuristic: how simple can it be and still order tasks sensibly? Start crude; tune on Duke data.
