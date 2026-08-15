# Phase 1 — State & Ingestion Spine

> Inherits [vision.md](./vision.md). Read that first. This doc covers *what Phase 1 delivers, how it's built, and how we know it's done.* Not a task list — those get generated from this.

## Goal

Build the core asset (state model) and the pipes that fill it, ending in the onboarding payoff: a student connects their sources and immediately sees a correct, insightful picture of their semester.

**Exit test:** the founder's Duke Canvas data + syllabi + course sites → a semester map that is factually correct (every deadline, weight, exam) and says at least one non-obvious true thing ("3 hell weeks; Tuesdays structurally overloaded").

## In scope

1. Monorepo scaffold, shared state model + DB schema.
2. Ingestion: Canvas API (token), iCal feeds, syllabus PDF, course websites.
3. Snapshot-diff sync design (see below) — built now, exercised on stale data.
4. Web app: onboarding flow + semester map + basic state editing.
5. Test harness against the Duke dataset.

## Not in scope (later phases)

- Any messaging / Photon (Phase 2). Deterministic planner + LLM judgment (Phase 2).
- Materials library, S3/R2, `prepared` fulfillment (Phase 3).
- Pacing/compliance learning, browser extension (Phase 4).
- **Optional stretch, only if Phase 1 lands early:** a single "here's tomorrow" text from real data as a demo slice — do not let it pull planner design forward.

## Stack (decided)

- **TypeScript everywhere. No Python.** Rationale in vision §8 spirit: one state model, one set of types.
- Monorepo (pnpm workspaces + Turborepo):
  ```
  packages/core     state model, Drizzle schema, ingestion adapters, snapshot-diff, (later) planner
  apps/web          Next.js (App Router) — onboarding, semester map, state editing
  apps/agent        (Phase 2) Photon webhooks, LLM layer, scheduler
  ```
- Postgres (Neon or Supabase) + Drizzle ORM. Zod for all LLM I/O boundaries.
- Anthropic SDK for syllabus/website parsing (PDFs passed natively, structured output via tool-use + zod).
- Firecrawl for course websites → markdown.
- Node runtime.
- No agent framework (LangGraph etc.) — plain TS orchestration; revisit only if flows demand it.

## State model (v1 schema)

Keep it minimal; typed for extension.

- `students` — id, timezone, availability blocks (weekly template + exceptions), semester start/end.
- `courses` — student_id, name, code, source refs (canvas_course_id, ical_url, site_url), grade weights (jsonb: `[{category, weight}]`), rhythm (jsonb: recurring lecture/reading/pset cadence), status.
- `tasks` — course_id, title, type (`do | prepared`), due_at, est_effort_min, actual_effort_min (nullable), grade_impact (derived: weight × points share), status (`todo | in_progress | done | skipped`), source (`canvas | ical | syllabus | site | manual`), source_ref, confidence.
- `sources` — student_id, kind, config (token/url), last_polled_at, health.
- `snapshots` — source_id, fetched_at, raw payload (jsonb). Immutable.
- `events` — derived changes: `task_added | due_moved | task_removed | submitted | grade_posted`, with before/after, source snapshot ids. Feeds Phase 2 replanning.

Provenance and confidence on every task from day one — the "never hallucinate a fact" rule needs to know where each fact came from.

## Ingestion design

### Snapshot → diff → events (the core pattern)

Every fetch is stored as an immutable snapshot. A pure function `diff(prev, next) → events[]` derives changes. State is updated *from events*, never directly from a fetch. Why:
- Canvas has no push; polling is the only option, so we need diffing anyway.
- **It makes stale data useful:** we can hand-mutate or synthetically generate a "next" snapshot from the Duke data and exercise the full change pipeline (due date moved, assignment added) without a live semester.
- Replayable: re-run history for debugging; provenance is free.

### Adapters (each: `fetch → snapshot`, `normalize → tasks/courses`)

1. **Canvas** — REST, per-user token, `Link`-header pagination. Pull: courses, assignments (due, points, group weights), submissions (status/score), and *also files/modules/pages/announcements now* (store raw; used in Phase 3 — costs nothing to capture early). Handle unpublished/concluded courses gracefully (Duke data is ~half unpublished).
2. **iCal** — parse VEVENTs; titles + due dates only. Dedupe against Canvas by title/date fuzzy match; Canvas wins on conflict.
3. **Syllabus PDF** — Claude native PDF → zod schema: grade weights, exam dates, recurring schedule, policies (late, drops). Every extracted item carries a confidence + source page. Low-confidence items surface for one-tap confirmation in onboarding, not silent insertion.
4. **Course website** — Firecrawl → markdown → same extraction schema as syllabus.

### Merge & conflict rules

Sources overlap. Rule of thumb: Canvas (authoritative for status/dates) > syllabus (authoritative for weights/rhythm) > iCal > site. Conflicts that can't be auto-resolved become onboarding confirmation prompts. Never silently pick.

## Onboarding & semester map (web)

Flow: create account → add Canvas token and/or iCal → upload syllabi (one per course, drag many) → optional course URLs → **confirm the handful of low-confidence items** → semester map renders.

Semester map must deliver the payoff:
- Timeline of all deadlines/exams by week, weighted by grade impact.
- Workload heat: which weeks are hell weeks (sum of grade-weighted effort per week).
- Structural observations (deterministic, computed): overloaded weekdays, weeks with 3+ high-weight items, exam clusters.
- Everything editable inline (fix a weight, move a date) — this is the state-editing surface.

**Mid-semester onboarding** works from the same flow: past-due tasks default to `done` if Canvas says submitted, otherwise prompt once ("mark all before today as done?").

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
- [ ] Onboarding flow end-to-end; semester map renders and passes the exit test above.
- [ ] Mid-semester onboarding path works on the same data.

## Open questions

- Neon vs Supabase (Supabase gives auth for free; Neon is leaner). Lean Supabase for auth unless we pick Clerk.
- Auth provider for the web app (needed for onboarding). Clerk vs Supabase auth.
- Availability capture in onboarding: import a class schedule from Canvas/iCal automatically vs manual weekly grid. Aim: auto from Canvas course sections; manual fallback.
- How much of the semester map is deterministic vs LLM-narrated? Bias: computed facts, LLM only writes the one-paragraph "here's your semester" narration over them.
