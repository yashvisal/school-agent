# Roadmap — where we are, what is next

> The plan docs carry the *why*; this one carries the *when* and the *state*. Update it when a slice lands or a status changes. Last full review: **2026-09-04** (independent codebase read plus the dev's review of the same day).

## Status vocabulary

Every surface below is one of:

- **implemented** — the code exists and its tests pass.
- **integrated** — it is wired across the seam (Core ↔ Voice ↔ Face) and exercised end to end on the dev deployment.
- **live-verified** — it has run on a real phone, a real account, or a real Canvas token.
- **deferred** — deliberately not built yet; the plan doc says why.

## Where we are (2026-09-04)

| Area                                   | Status                | Notes                                                                                                                                                  |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core state model, `changes`, provenance | integrated            | Every obligation-state write (courses, deadlines, tasks, students) goes through `changes`; content (`materials`, and in M3 `artifacts`) is written directly by design (core.md, workspace.md). Two-tier rule enforced; evidence on inline confirmations verified against the inbound log. |
| Canvas + iCal adapters, snapshot → diff | implemented           | Built to Instructure's spec on hand-authored fixtures. **Never run against a real token** — see [live-validation.md](./live-validation.md).             |
| Syllabus / site / schedule extraction  | implemented           | Eval fixtures (MIT, Stanford, CMU, synthetic schedule) scored live in CI; invented dates fail the eval.                                                 |
| Planner v0 (`feasibleActions`)         | integrated            | Hard-constraint tests; overdue work stays in the set with no fits; pacing signals adjust effort per course.                                             |
| Nightly pass → Voice trigger           | integrated, **buggy** | Runs at the student's nightly hour (default 4am), computes the *next* day, and texts immediately — so the 4am text describes the day after. Fix in Slice 1. |
| Voice on eve + Photon                  | live-verified         | Proactive morning text and a real inbound conversation on the founder's phone (2026-08-31), from a laptop behind a quick tunnel.                       |
| Inbound dedupe, contact warming        | integrated            | Core-owned; gates the push until the student has texted three times.                                                                                   |
| Usage logging (Voice)                  | integrated            | Idempotent per model step. The workspace agent's hook is still a console stub.                                                                         |
| Face shell, two-mode nav, live queries | integrated            | Dashboard, Semester, course Overview, Connectors, per-course Library placeholder, chats in the viewport; every data hook is a Convex subscription except chats. |
| Web approvals                          | integrated            | Approve, bulk-approve by `batchId`, and an inline **Fix** editor (`proposeManual`, superseding the card it answers). **Re-sync** runs the real poll and stays busy until the source reports one. Not live-verified against a real token.        |
| Tasks on the Dashboard                 | **not written**       | Nothing persists Voice's picks; the Today panel is empty by construction. Fix in Slice 1.                                                               |
| Student provisioning                   | implemented           | The shell calls `students.ensure` once per session when Convex reports a signed-in identity with a null viewer, passing the browser's IANA zone.        |
| Onboarding flow                        | deferred → Slice 2    | Backend pieces exist (uploads, bulk approve, past-deadline resolution); no route, no screens.                                                           |
| Workspace agent + Spike B              | implemented           | Per-session isolation and streaming proven; tools are probes; `propose_change` and usage write nowhere; browser channel 401s in any deployment.        |
| Course workspace as a builder          | deferred → Slice 4    | Redefined 2026-09-04: [workspace.md](./workspace.md).                                                                                                  |
| Deployment                             | **none**              | Prod Convex exists with zero tables; the dev deployment's Voice URL points at a dead tunnel; Vercel project is linked but main-branch deploys are disabled. |

Verification on 2026-09-04: `pnpm test` 434/434 across 19 files; `pnpm lint` three image warnings; `pnpm typecheck` fails only on a stale generated file under `.next` that references the removed global Library route (delete `.next`).

## The slices, in order

Each slice has an owner per workstream and an exit test a person can run. Merge order within a slice: Core first when the schema changes.

### Slice 0 — stand it up (this week)

The whole loop has only ever run from the founder's laptop. Onboarding ends with "text this number" and replans need a line that stays up overnight, so this comes before everything.

- Deploy Next plus both eve agents to Vercel production; deploy Convex prod; set secrets once (`CORE_AGENT_SECRET`, `VOICE_TRIGGER_SECRET`, `EVE_VOICE_URL`, Photon credentials, Clerk).
- Register the Photon webhook against the stable domain (`/eve/agents/voice/eve/v1/photon`); rotate the signing secret into env.
- Vercel Spend Management with **pause** on (vision §10 cost posture).
- Clear the dead tunnel URL from the dev deployment; delete the stale `.next`; typecheck green in CI again.
- **Chase the friend's Canvas token now.** Semesters have started; live validation reshapes ingestion and onboarding, so the sooner the better.

**Exit test:** a morning text lands on the founder's phone from production with the laptop closed.

### Slice 1 — a new student gets to a correct morning text

Combined on 2026-09-05 from the earlier "loop correctness" and "onboarding" slices (a planning change, not a code merge — the status table above is the pre-slice state and is updated as PRs land): phone registration only exists so a student can be reached, and that is onboarding. One slice, six PRs, each usable on its own. Order: 1, 2, 3, 5, 4, 6 — forms before the wizard, so real syllabi and a real token can be tested within days and the wizard is designed against that.

1. **Timing and safety (Core, Voice).** `morningHourLocal` (default **7**, decided 2026-09-05) replaces `nightlyHourLocal`; the hourly tick computes and sends *today's* plan at the student's morning hour; the retry window follows. Voice gets a per-session token limit. Update core.md and VOICE_TOOLS.md §8 in the same PR.
2. **Identity and phone (Core, Voice).** `students.ensure` on first sign-in. `students.updatePrefs` — phone, timezone, morning hour, availability, check-in preference. Saving a phone **registers it with Photon** through a small Voice route (same pattern as the trigger; Photon credentials stay on the Voice host). Shared lines can only message registered contacts, and nothing registers one today. The student's first inbound text is the verification — it resolves to that phone — so no SMS-verification setup.
3. **Plan commit (Core, Voice).** Voice's 1–3 morning picks become `tasks` rows; replans update them; the Dashboard's Today panel fills in. **Decided 2026-09-05: commits are `task_created` / `task_updated` changes with a new origin `planner`, tier `auto`** — the agent choosing within Core's feasible set is the plan itself, not an interpretation of a student statement, so it does not wait for approval; Core verifies every pick against its own feasible set before applying. `getFeasibleActions` returns committed tasks as `taskId` on later calls, so a replan updates rather than duplicates. core.md carries the origin in its enum and the two-tier rule.
4. **Face-facing mutations (Core).** `sources.resync`; a public manual-origin `changes.propose` wrapper for **Fix**; a `batchId` on changes so a syllabus parse groups as one card ("18 items from CHEM 202's syllabus"). `approveMany` already exists.
5. **Settings and Connectors wired (Face).** Phone, availability, morning hour, check-ins on Settings; an add form for a Canvas token or iCal URL; syllabus and schedule upload; a bulk-approve button on the change feed; a Fix editor; Re-sync real. Usable before any wizard exists. The fixtures copy in Settings removed.
6. **The onboarding route (Face, Paper first).** One flow — timezone, term, phone → connectors → syllabi (many at once) → class schedule with the weekly-view approval → bulk review (Fix inline) → the mid-semester "assume these N are done?" prompt (`resolvePastDeadlines`) → the semester picture → "**text this number now**" with a short three-message exchange so the push gate opens → drop into the first course.

7. **Trigger acceptance is claimed before the send (Core, Voice).** Found in review of PR #12, pre-existing: if Photon accepts a morning send but Core never receives the trigger route's 202 (timeout, dropped connection), Core marks the run `failed`, a later tick re-POSTs, and a restarted Voice process has no in-memory `seenOperations` entry — two texts. Fix: the trigger route first calls a new Core route `POST /voice/claimTrigger { operationId, sessionId? }` that atomically flips `planRuns.triggerStatus` to `triggered` create-once and answers whether this caller was first; the route sends only when it was, and answers `duplicate` otherwise. Core's retry logic is unchanged (a `triggered` run is never re-POSTed). VOICE_TOOLS.md §8's at-most-once claim is softened until this lands. Built after PR #13 settles (same files).

**Exit test:** a brand-new Clerk account reaches a correctly timed morning text with no database edits by the founder. Interim test after PR 3: the founder as student zero for five consecutive days — five texts at 7am, one deliberate miss, one calm replan, the Dashboard matching the thread every day.

### Slice 2 — (merged into Slice 1)

### Slice 3 — live Canvas, then a pilot

- Run [live-validation.md](./live-validation.md) the day the token arrives; fix the fetch layer; update the fixtures where spec and reality disagree.
- **Gates before the first real student** (not notes — nobody is provisioned until both are done): (a) the fixture semester on prod is reset (`dev/seed:reset` for the founder's Clerk id) and an identity-scoped query from a second account is confirmed to return nothing of it; (b) Clerk moves from the dev instance to a **production instance** — production keys on Vercel, `CLERK_JWT_ISSUER_DOMAIN` on Convex prod set to the production issuer, allowed origins and redirect URLs verified — and the founder signs in again end to end.
- Pilot with 3–5 students, at least one mid-semester. Watch per-student usage cost, `triggerStatus` per day, reply rates, and the replan moment ("I didn't do any of yesterday's work").

**Exit test:** every pilot student gets a correct morning text for a week, and one broken-plan recovery per student is reflected in Core and remembered the next day.

### Slice 4 — the workspace as a builder (Milestone 3)

Sequenced in [workspace.md](./workspace.md): Core tables and Library query → agent tools, hydrate, usage, Clerk verifier → Library and tabs and the document editor → deck, then sheet → `prepared` tasks close the loop.

**Exit test** (the same as workspace.md's): a planned `prepared` task exists ("review deck for Midterm 1, from the lecture slides"). Overnight the workspace agent builds the deck from that course's Canvas captures and files it under the exam's folder. The morning text mentions it. The student opens it in a tab, asks the rail chat to shorten slide 3, edits a bullet by hand, and downloads a `.pptx`. Everything they did wrote signals. Nothing they did required naming, saving, or choosing a folder.

## Decisions

Decided 2026-09-05: default morning hour **7am local**, per-student in Settings — the founder's call: the text has to land before an 8am class, and a student who wakes later still sees it first thing; plan commits are **auto-tier** changes with origin `planner` (rationale in Slice 1 item 3); Face builds the **forms before the wizard** so real data is testable in days and the wizard is designed against it.

Still pending (founder):

- Check-in cadence (voice.md open question; recommendation: only when tomorrow depends on the answer, until pilot data says otherwise).
- Artifact representation: structured-in-Convex with Office exports (workspace.md; recommendation stands unless native-file fidelity is the point).

## Deployment (2026-09-05)

Production is live: the Next app and both eve agents on Vercel (`school-agent-yashvisals-projects.vercel.app`, alias `school-agent-six.vercel.app`), Convex prod `uncommon-jay-553`, one Photon webhook on the stable domain, deployment protection preview-only, Clerk on the dev instance for now. Git deploys on `main` are disabled (`vercel.json`); ship with `npx convex deploy -y` then `pnpm exec vercel deploy --prod --yes`; Vercel env changes need a redeploy. The team is on Hobby: compute, Workflow, and Sandbox stop rather than bill; model spend is capped by prepaid AI Gateway credits. The fixture semester is seeded on prod and linked to the founder, and Clerk is still the dev instance — both are founder-only-testing state and both are Slice 3 gates before any real student. Verified end to end: `nightly:runNow` → trigger → eve session on Vercel Workflow → cached plan → two model steps → usage rows → text on the founder's phone, both directions.

## Plan-doc reconciliation (fold into the PRs above)

- core.md definition-of-done boxes: tick what shipped; the only honest unticked items are live validation and the mid-semester path's live run.
- `lib/data/README.md`: `updatePrefs`, `resync`, `proposeManual` and `batchId` all landed and are wired in Face. One correction it still needs: it says re-saving the same phone retries the Photon registration, and `updatePrefs` returns early when nothing moved, so it does not — Settings tells the student to change the number instead. A `students.retryRegistration` (or scheduling `registerContact` on an unchanged phone) is the honest fix, and is the only Core ask left from Slice 1 item 5.
- face.md Milestone 3 and vision §8/§12 now point at workspace.md.
