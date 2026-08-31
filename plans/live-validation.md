# Live validation — the day a real Canvas token arrives

> Referenced from [core.md](./core.md), "Test data & limitations". Every adapter was built to
> Instructure's published spec with hand-authored fixtures and **zero live Canvas access**. This is
> the list of things a spec can't tell you. Expect a short fix-up cycle; the fetch layer
> (`convex/lib/canvas/client.ts`) is deliberately thin and injectable so fixes land there and not in
> normalization or the diff.

## Before you start

1. Get the token from the friend's account (Account → Settings → New Access Token). It is
   ToS-gray on institutional instances — say so out loud, and be ready for it to be revoked.
2. Set it on the deployment, never in code: `npx convex env set CANVAS_TEST_TOKEN "<token>"`.
3. Register the source with a real config instead of the fixture one:
   `{ baseUrl: "https://<school>.instructure.com", token: "<token>" }`.
4. **Snapshot everything before touching anything.** The first successful poll writes an immutable
   snapshot; export it (`npx convex export`) and scrub it into `fixtures/` only after a manual
   read-through. Real snapshots are real student data — they stay out of git (fixtures/README.md).

## The checklist

### 1. Pagination (`Link` header)

- [ ] Confirm `per_page=100` is actually honoured. The docs say there is an unspecified upper
      limit; if the instance caps lower, `fetchAll` still works but does more round trips.
- [ ] Confirm `rel="next"` is present on multi-page responses and **absent** on the last page.
      `nextPageUrl` refuses to follow a `next` that equals `current`; verify that guard is not
      masking a real second page.
- [ ] Check whether any endpoint paginates with `page=bookmark:...` rather than an integer.
      `fetchAll` follows the URL verbatim, so this should just work — confirm it does.
- [ ] `/api/v1/courses/:id/students/submissions` is the most likely to be big. Watch the page count.

### 2. Rate limits and throttling

- [ ] Log `X-Request-Cost` and `X-Rate-Limit-Remaining` for a full poll and record the totals here.
      That number decides the real polling cadence (core.md starts at 30 minutes).
- [ ] Confirm the throttled response is `429` (the docs also say "403 Forbidden (Rate Limit
      Exceeded)" in places). `requestOnce` retries both; verify which one actually arrives.
- [ ] Confirm `Retry-After` is or is not sent, and whether the exponential fallback is sane.
- [ ] Sanity-check the pre-emptive floor (`rateLimitFloor`, default 100). Too high and every poll
      sleeps; too low and a burst gets throttled.

### 3. Courses: unpublished, concluded, and the ones you did not expect

- [ ] Does `enrollment_state=active` return concluded courses at all? The fixture assumes some
      form of `workflow_state: "completed"` / `concluded: true` shows up.
- [ ] Is `concluded` actually returned, or is `include[]=concluded` required (or ignored)?
- [ ] Do unpublished courses appear for a student enrollment, or only for teachers? If they never
      appear, `courseStatusFor`'s `hidden` branch is dead code for students — leave it, but say so.
- [ ] Check `include[]=term` shape against `CanvasTerm`.
- [ ] Cross-listed / section-split courses: does one course appear twice under different ids? That
      would create duplicate courses, because dedupe is on `canvasCourseId`.

### 4. Assignments

- [ ] Are unpublished assignments returned to a student at all? `normalizeCanvas` skips
      `published === false`; verify that is not silently dropping something visible.
- [ ] `submission_types` for quizzes: confirm `["online_quiz"]` and check `is_quiz_assignment`.
- [ ] Confirm the exam heuristic against real group names. Duke courses often use "Tests",
      "Assessments", "Evaluation" — if so, widen `EXAM_RE` in `convex/lib/canvas/normalize.ts`.
- [ ] `due_at` with overrides: if the student has an accommodation or a section override,
      `due_at` may be the *base* date. Check `has_overrides` and `all_dates`; the student-visible
      date is the one that matters, and getting this wrong means planning against a wrong deadline.
- [ ] Assignments with `due_at: null` (the fixture has one). Confirm they exist in practice.
- [ ] `points_possible: null` on ungraded items.

### 5. Assignment groups and grading scheme

- [ ] Is `group_weight` populated, or 0 for a points-based course? `gradingSchemeFor` notes both.
- [ ] Is `rules` an object, a string, or absent? The docs show an object; some instances return
      the rules as a newline-delimited string on other endpoints.
- [ ] `drop_lowest` / `drop_highest` / `never_drop` — confirm the field names on the wire.

### 6. Submissions

- [ ] `GET /api/v1/courses/:id/students/submissions?student_ids[]=self` — confirm `self` works for
      a student token, and that it is not teacher-only (fall back to
      `/api/v1/courses/:id/assignments/:id/submissions/self` if so).
- [ ] `workflow_state` values seen in the wild: `unsubmitted`, `submitted`, `graded`,
      `pending_review`, `graded` with `excused`. Check `submissionStatusFor` covers them.
- [ ] `missing` / `late` / `excused` — confirm they are set by the instance's late policy, and
      that `missing` is not permanently false.
- [ ] Muted/unposted grades: does `score` come back before `posted_at`? If it does, the student
      would learn a grade before the instructor released it. **This is the one edge case worth
      being conservative about** — prefer `posted_at` over `graded_at`.
- [ ] Mid-semester onboarding (core.md): confirm past deadlines really do default to `submitted`
      where Canvas says so, rather than showing up as a wall of `missing`.

### 7. Files / modules / pages / announcements

- [ ] `/files` may be 403 for students on some courses. Confirm a failure there does not fail the
      whole poll (it currently would — consider per-endpoint tolerance).
- [ ] `/api/v1/announcements` requires `context_codes[]`; confirm the 14-day default window and
      whether `start_date` needs widening for onboarding.
- [ ] Pages: confirm `page_id` vs `url` as the stable id.

### 8. iCal feed

- [ ] Get the real feed URL (Calendar → Calendar Feed). Confirm the UID format is really
      `event-assignment-<id>` and `event-calendar-event-<id>`. **If it differs, the exact-join
      dedupe silently degrades to fuzzy matching and duplicates appear** — this is the highest-risk
      item on this page.
- [ ] Confirm `SUMMARY` really is `Name [COURSE_CODE]`, and that the code matches `courses.course_code`.
- [ ] Confirm `DTSTART` for assignments is a UTC `Z` datetime (the fixture assumes so) and that
      all-day items use `VALUE=DATE`.
- [ ] Check for `TZID` values that are not IANA zones (some exporters emit Windows zone names) —
      `parseIcalDate` degrades to floating/UTC and would be an hour or five wrong.
- [ ] Check for `RRULE` on class meetings. The parser does NOT expand recurrence; if class events
      are recurring, the schedule adapter needs it.
- [ ] Confirm the 1-minute `CONFLICT_TOLERANCE_MS` is right. If Canvas and its own feed routinely
      differ by a few minutes, every deadline becomes a pending conflict and the queue becomes the
      chore inbox core.md forbids.

### 9. Token health and failure modes

- [ ] Revoke the token and confirm the poll records `sources.health.status === "error"` with a
      readable message, rather than throwing into the void.
- [ ] Confirm an expired token returns 401 (not an HTML login page — `fetchAll` would then throw
      "returned non-JSON", which is at least honest).
- [ ] Confirm the poll is idempotent: two polls in a row must write exactly one snapshot.
- [ ] Confirm a partial failure (e.g. `/files` 403 mid-poll) leaves no half-written state. Today it
      throws before `ingestPayload`, so nothing is written — verify that is what happens.

### 10. Volume

- [ ] Count documents read and written by one `ingestPayload` on a real semester. The fixture
      writes ~70 documents; a real student with 6 courses and 200 assignments should still be far
      under the 8k-write / 16k-read transaction limits, but measure rather than assume.
- [ ] If a first-ever ingest for a heavy student approaches the limit, batch `applyProposals` via
      `ctx.scheduler` rather than raising anything.

## When you are done

- Update the fixtures where the spec and reality disagreed, and note the disagreement in
  `fixtures/README.md` so the next reader knows the fixture is now reality-derived.
- Update this file with what was actually true (delete the guesses, keep the answers).
- Record the observed request cost and pick the real polling cadence in `convex/crons.ts`.
