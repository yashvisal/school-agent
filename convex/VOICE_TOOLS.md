# Voice ↔ Core: the tool contract

> **This file is the seam.** Voice sees the plan only through `getFeasibleActions`,
> mutates only through `proposeChange`, and learns only through `recordSignal`
> (vision §10, core.md "What Core hands to Voice and Face"). Nothing else in Core
> is reachable from an agent. Change a route here and update this file in the same
> PR — `agent/voice/` is written against this document, not against the source.

Owned by **Core**. Consumed by **Voice** (`agent/voice/`). Implemented in
`convex/http.ts` (routing + auth) over `convex/voice.ts` (the tools themselves,
all `internal*`).

---

## 1. Endpoint, auth, and conventions

**Base URL** is the Convex deployment's **HTTP Actions** URL — the `.convex.site`
host, *not* the `.convex.cloud` one used by the client SDK:

```text
https://<deployment>.convex.site
```

It is available locally as `NEXT_PUBLIC_CONVEX_SITE_URL`, and from the CLI via
`npx convex env get CONVEX_SITE_URL`.

Every route:

| | |
|---|---|
| Method | `POST` (a `GET` returns 404 — the router is exact-match on method and path) |
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <CORE_AGENT_SECRET>` — **required on every request** |
| Response | JSON, always with an `ok` boolean |

`CORE_AGENT_SECRET` is a shared secret set per Convex deployment with
`npx convex env set CORE_AGENT_SECRET <value>`. It is compared in constant time.
A deployment where it is unset **fails closed**: every route answers `401`. Dev and
prod have different values; the secret never appears in the repo.

### Status codes

| Code | Meaning |
|---|---|
| `200` | Success. |
| `400` | Malformed JSON, a non-object body, a missing/ill-typed field, or an id that is not a valid Convex id for its table. |
| `401` | Missing, malformed, or wrong bearer token — or `CORE_AGENT_SECRET` unset on the deployment. |
| `404` | The route does not exist, or the subject (student) was not found. |
| `409` | The request is ambiguous and Core will not guess — e.g. two students share the inbound phone number. |
| `500` | An unexpected server error. The body is always exactly `{"ok": false, "error": "internal error"}` — details are logged server-side, never returned. Should not happen for a well-formed request; report it. |

Error bodies are always `{ "ok": false, "error": "<message>" }`.

Auth is checked **before** the body is parsed, so an unauthenticated request with
junk JSON is a `401`, never a `400`.

### Ids and dates

- Every `studentId`, `courseId`, `deadlineId`, `taskId` is an opaque Convex id
  string. Pass back exactly what Core gave you; never construct one.
- Every `date` is `"YYYY-MM-DD"` **in the student's timezone**, which
  `resolveStudent` and `getFeasibleActions` both return. Any other format is a
  `400`.
- Every timestamp (`dueAt`, `observedAt`, `at`, `computedAt`) is **milliseconds
  since epoch**.
- Every time-of-day (`startMin`, `endMin`) is **minutes from local midnight**
  (`540` = 9:00am, `1439` = 11:59pm).

---

## 2. `POST /voice/resolveStudent`

Maps an inbound iMessage number (or a Clerk user) to a student. This is normally
the first call of any conversation — everything else needs a `studentId`.

**Request** — exactly one of:

```json
{ "phone": "+15551234567" }
{ "clerkId": "user_2abc..." }
```

`phone` is normalized before lookup, so `+1 (555) 123-4567`, `555-123-4567`, and
`15551234567` all resolve to the same student.

**Response `200`**

```json
{
  "ok": true,
  "studentId": "j57a...",
  "timezone": "America/New_York",
  "status": "active"
}
```

`status` is `"active"` or `"paused"`. A paused student still resolves — Voice
decides what to do about it.

**Response `404`** — no student for that identifier. Never fall back to another
student.

**Response `409`** — more than one student carries that number. Core refuses to
pick one; the number is a data problem for a human to fix. Do not retry.

---

## 3. `POST /voice/getFeasibleActions` — *read the plan*

The only way Voice sees the world. Returns the feasible option set for one day,
each option annotated with plain-English facts.

**Request**

```json
{
  "studentId": "j57a...",
  "date": "2026-09-15",
  "now": 1789200000000
}
```

| Field | Required | Notes |
|---|---|---|
| `studentId` | yes | |
| `date` | yes | `"YYYY-MM-DD"` in the student's timezone. |
| `now` | no | Wall clock in ms. Defaults to the server's. Pass it when replaying or testing. |

**Response `200`**

```json
{
  "ok": true,
  "plan": {
    "planRunId": "k82b...",
    "computedAt": 1789192800000,
    "cached": true,
    "timezone": "America/New_York",
    "date": "2026-09-15",
    "windows": [
      { "startMin": 540, "endMin": 600, "durationMin": 60 },
      { "startMin": 675, "endMin": 1260, "durationMin": 585 }
    ],
    "options": [ /* see below */ ],
    "pending": [ /* see below */ ],
    "signalsDigest": {
      "availability": [], "pacing": [], "preference": [],
      "difficulty": [], "life_event": [], "other": []
    }
  }
}
```

### Caching and `planRunId`

If the nightly pass computed a plan for that day within the last **6 hours**, and
nothing has landed in `changes` since it was computed, that stored snapshot is
returned with `cached: true` and its `planRunId`.

Otherwise the plan is recomputed live and comes back with `cached: false` and
**no `planRunId` at all**. A live plan did not come from a stored run, so there is
no snapshot for it to cite: if `planRunId` is absent, do not name one.

A change *created* or *resolved* since the snapshot invalidates it — including one
you just applied yourself with `confirmedInline: true`. Calling
`getFeasibleActions` again straight after a `proposeChange` therefore gives you
the corrected day, not the stale one.

This matters for the nightly run: the trigger message carries a `planRunId`, and
calling `getFeasibleActions` for the same `date` returns that same snapshot — so
the morning text and every follow-up in the conversation describe one consistent
day rather than silently re-planning mid-thread.

### `windows`

The day's free intervals, already computed: the student's availability for that
weekday (or the `exceptions` entry for that exact date), **minus** class blocks,
**minus** anything already in the past if `date` is today. Overlaps are merged.

These are facts. Do not invent, extend, or merge windows.

### `options[]`

One entry per open deadline in the horizon (default 14 days) plus any open
free-standing task.

| Field | Type | Notes |
|---|---|---|
| `taskId` | id? | Present when a task already exists for this work. |
| `deadlineId` | id? | Absent for free-standing tasks. |
| `courseId`, `courseName` | id?/string? | |
| `title` | string | |
| `kind` | `homework \| project \| exam \| quiz \| reading \| other` | |
| `dueAt` | number? | ms. Absent for undated work. |
| `dueInDays` | number? | Whole days from `date`. `0` = due today. |
| `pointsPossible` | number? | |
| `category`, `categoryWeight` | string?/number? | Weight exactly as the syllabus stated it (`0.3` and `30` both mean 30%). |
| `estEffortMin` | number | |
| `estEffortConfidence` | `low \| medium \| high` | |
| `effortSource` | `prior \| signal` | `prior` = a crude per-kind default. |
| `fits` | `{ windowIndex, startMin, endMin }[]` | Slots on `date` this work could occupy. `windowIndex` indexes `windows`. |
| `remainingWindowsBeforeDue` | number | Free windows from `date` through the due date, inclusive. |
| `facts` | string[] | Plain English. **These are what you weigh.** |
| `pending` | string[]? | Unconfirmed changes touching this item. See §6. |
| `signals` | string[]? | Signal texts referencing this course/deadline/task. |
| `overdue` | true? | Past due and still not handed in. See below. |

### `overdue`

Work whose due time has passed and whose `submissionStatus` is still open is
emitted with `overdue: true`, `fits: []`, and `remainingWindowsBeforeDue: 0`, and
a fact of the form `"past due Fri Sep 11 12pm (3 days ago), not submitted"`. It is
in the set so you can *raise the miss* — silence about a missed deadline is worse
than the mention. There is nothing to schedule: the hard guarantee below still
holds, because there is no window after the due time and so no fit to offer.

Anything more than 14 days past due is dropped entirely, as is anything
submitted, graded, or excused.

**There is no score, rank, priority, or importance field, and there never will
be.** The deterministic layer says what is *possible*; choosing among the options
is the whole of your job (vision §10). The `facts` array is the input to that
judgement — e.g.:

```text
"Compsci 201 (CS201)"
"due Thu Sep 17 11:59pm (in 3 days)"
"worth 25 pts in Problem Sets (30% of grade)"
"effort ~2h (low-confidence prior)"
"fits 2 free windows today: 9am–11am, 2pm–4pm"
"3 free windows before it is due"
"last free window before due is Wed Sep 16 9am–8pm"
```

### Hard guarantees

Core enforces these, so you may state them to the student as fact:

1. No `fits` slot overlaps a class block.
2. No `fits` slot ends after `dueAt`.
3. Submitted, graded, excused, and removed work is never in `options`. Past-due
   *unsubmitted* work is, flagged `overdue` and with no fits.
4. Anything in `options` is planned on **applied** facts only — never on an
   unconfirmed pending value.

Conversely: **never propose a time that is not in `fits`.** If nothing fits, say
so; do not invent a window.

---

## 4. `POST /voice/proposeChange` — *write state*

The only mutation path. Everything lands in the `changes` table and is tiered
there; you never write a deadline, task, or course directly.

**Request**

```json
{
  "studentId": "j57a...",
  "change": {
    "kind": "deadline_moved",
    "entity": { "table": "deadlines", "id": "m91c..." },
    "before": { "dueAt": 1789200000000 },
    "after":  { "dueAt": 1789286400000 },
    "courseId": "n03d...",
    "reason": "student said the midterm moved to Friday",
    "conflict": false,
    "confirmedInline": true,
    "evidence": { "quotedReply": "yeah", "inboundMessageId": "msg_2f9c..." }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `kind` | yes | `deadline_added \| deadline_moved \| deadline_removed \| deadline_updated \| submitted \| grade_posted \| course_added \| course_updated \| task_created \| task_updated \| availability_updated \| chat_decision \| other` |
| `entity` | yes | `{ table: "deadlines" \| "courses" \| "tasks" \| "students", id?: string }`. Omit `id` when creating. |
| `after` | usually | The new values. Omit for `deadline_removed`. |
| `before` | no | The prior values, for the change feed. |
| `courseId` | no | Required for `deadline_added` if `after.courseId` is absent. |
| `reason` | no | Free text, shown in the change feed. Worth filling in. |
| `conflict` | no | Set `true` when what the student said contradicts a structured source. |
| `confirmedInline` | no | See below. |
| `evidence` | with `confirmedInline` | `{ quotedReply: string, inboundMessageId?: string }`. See below. |

**There is no `origin` field.** Everything Voice proposes is `chat` origin by
construction — it was interpreted from a message, and the route will reject a
payload that tries to say otherwise. Two consequences worth knowing:

- **A Voice change is never `tier: "auto"`.** It is `needs_approval`, always,
  and reaches student state only through `confirmedInline` or a web tap.
- **You cannot set `after.provenance`.** The source claim is replaced with
  `{ source: "chat", sourceRef: <changeId> }` on apply, so a fact you heard can
  never be recorded as a fact Canvas stated. The one thing you may assert is a
  numeric `confidence` in `[0, 1]` — your own extraction confidence; when you
  don't, the field is simply absent (never a fabricated default).

**Scope on `entity.table: "students"`:** a chat-origin change may write only
`classBlocks`, `availability`, `semesterStart`, `semesterEnd`, and
`nightlyHourLocal`. `phone`, `timezone`, `status`, and `clerkId` are identity and
routing; they are silently dropped from the patch. And `entity.id` must be the
same student as `studentId` — a change can only ever touch its own student, on
any table. Anything else is a `403`.

**Response `200`**

```json
{ "ok": true, "changeId": "p44e...", "status": "approved", "tier": "needs_approval" }
```

`status` is `applied | pending | approved`; `tier` is `auto | needs_approval`. The
example above is the response to the request above it: `confirmedInline: true`, so
it lands `approved` and is applied. Without it, the same request answers
`"status": "pending"`.

### `confirmedInline` — the rule that matters

An inline chat confirmation is a **first-class approval, equal to a web tap**
(core.md rule 1, vision §6.5).

- `confirmedInline: true` → `status: "approved"`, applied immediately, and it does
  **not** also sit in the web queue.
- omitted/`false` → `status: "pending"`. Nothing is written to student state until
  the student approves it somewhere.

Set it **only** when the student actually confirmed in that same exchange:

> "got it — midterm now Friday, right?" → "yeah" → `confirmedInline: true`

Do not set it because a statement sounded confident. An unconfirmed inference is
`pending`; that is the whole safety property.

**Evidence is required.** `confirmedInline: true` without `evidence.quotedReply`
is a `400` and nothing lands. Quote the student's confirming reply *verbatim*
("yeah", "yes friday works") and pass the Photon message id of that reply as
`inboundMessageId` when you have it (the channel surfaces it as `[msgId …]`).

**A supplied `inboundMessageId` is verified.** Core keeps an inbound message log
(written by `POST /voice/recordInbound` before every dispatched turn, §7b); an
id that does not match a logged message *from this student* is a fabricated
citation, and the whole change is a `400` — nothing lands. A quoted reply with
no id remains allowed and is accountability-only: it is stored on the change and
shown in the Dashboard feed as `confirmed in chat: "yeah"`, visible and
contestable by the student. Always pass the real id when the channel showed one.

A `conflict: true` change is never auto-applied. (Nothing from Voice ever is;
`conflict` matters for the adapters, and marking it tells the feed *why* the
change is waiting.)

---

## 5. `POST /voice/recordSignal` — *write what you learned*

Stores what the student said or did, **as said**. Never aggregate, score, or
interpret it into a number — the text is the record (vision §4b, §9).

**Request**

```json
{
  "studentId": "j57a...",
  "signal": {
    "kind": "pacing",
    "text": "said 2h, took 4h on CS pset 3",
    "refs": { "courseId": "n03d...", "deadlineId": "m91c..." },
    "observedAt": 1789200000000,
    "sessionId": "wrun_A",
    "confidence": 0.8
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `kind` | yes | `pacing \| availability \| preference \| difficulty \| life_event \| other` |
| `text` | yes | Non-empty. Quote the student where you can. |
| `refs` | no | Any of `courseId`, `deadlineId`, `taskId`. **Set `courseId` whenever you can** — see below. |
| `observedAt` | no | ms; defaults to now. |
| `sessionId` | no | Your eve session id. Stored as provenance. |
| `confidence` | no | `0..1`, how sure you are you read them right. Defaults `0.6`; out-of-range values fall back. |

**Response `200`** — `{ "ok": true, "signalId": "q55f..." }`

### Why `refs.courseId` matters

A `pacing` signal carrying a `courseId` **feeds back into the planner**: Core
parses durations out of the text and adjusts that course's effort estimates
(`effortSource` becomes `"signal"`, confidence rises to `medium`). Recognised
shapes:

| Text | Effect |
|---|---|
| `"said 2h, took 4h"` | multiplier ×2 on the prior |
| `"took 4h"`, `"spent 90 min"` | absolute duration |
| `"~3 hours"`, `"90 min"` | absolute duration |

Without a `courseId` the signal is still stored and still appears in
`signalsDigest`, but it cannot adjust anything. Other kinds never move the
estimate — they surface in the digest for you to weigh.

---

## 6. Pending changes — draining the queue in conversation

`plan.pending[]` lists every unconfirmed change that could affect the horizon:

```json
{
  "changeId": "p44e...",
  "kind": "deadline_moved",
  "summary": "due date may move to Fri Sep 18 11:59pm",
  "affectsDate": "2026-09-18"
}
```

The matching option also carries a human-readable
`pending: ["pending: due date may move to Fri Sep 18 11:59pm"]`.

The rules (core.md, "Approval channels and pending semantics"):

- **Rule 3 — the plan is computed on applied facts only.** An option touched by a
  pending change is annotated, never silently planned on the new value and never
  silently dropped.
- **Rule 4 — you drain the queue proactively.** When something pending would
  affect the plan, ask for a one-word confirmation in the morning text — that is
  the point of surfacing it. On a "yeah", call `proposeChange` with the same
  `entity`/`after` and `confirmedInline: true`.
- **Rule 5 — pending changes older than the horizon are expired** by the nightly
  pass, with a note in the feed. They are never applied.

The web approval queue exists only for what chat could not confirm in flow (bulk
syllabus parses at onboarding, schedule uploads, source conflicts).

---

## 7. `POST /voice/logUsage` — *mandatory on every LLM call*

Not a planning tool: bookkeeping. **Every** model call — classifier, composer,
subagent — writes one row. It is the only cost record that survives a change of
agent runtime (vision §10, cost posture), which is why it lives in Core and not in
eve.

**Request**

```json
{
  "studentId": "j57a...",
  "surface": "voice",
  "model": "anthropic/claude-opus-4-7",
  "promptTokens": 1200,
  "completionTokens": 180,
  "costUsd": 0.0234,
  "sessionId": "wrun_A",
  "at": 1789200000000
}
```

`model`, `promptTokens`, and `completionTokens` are required. `studentId` is
optional, so a call made before the student is resolved is still costed.
`surface` defaults to `"voice"` (`voice | workspace | ingestion | planner`).
Negative or non-finite token counts are floored to `0` rather than stored.

**Response `200`** — `{ "ok": true, "usageId": "r66g..." }`

---

## 7b. `POST /voice/recordInbound` — *dedupe, warming, and the evidence log*

Called by the Photon channel's `onMessage` **before dispatching a turn**
(`agent/voice/channels/photon.ts`). Photon delivers webhooks at least once (up
to 6 attempts, no ordering, no DLQ) and eve does not dedupe, so Core owns the
seen-set. Three jobs in one write:

1. **Dedupe.** The documented key is `{webhookId}:{message.id}`; eve does not
   surface the `X-Spectrum-Webhook-Id` header to `onMessage`, so the key
   degrades to `photon:<messageId>` — equivalent for a single registered
   webhook, since message ids are unique per message. `duplicate: true` means
   *do not dispatch* — return `null` from `onMessage`.
2. **Contact warming.** Each accepted (non-duplicate) inbound bumps
   `students.inboundCount`. Photon caps a line at 10 replies to a contact who
   has sent fewer than 3 messages, so the nightly trigger (§8) is gated on
   `inboundCount ≥ 3`.
3. **The evidence log.** Rows are what `evidence.inboundMessageId` (§4) is
   verified against.

Log rows are pruned after ~48h (the dedupe window Photon documents); the
`inboundCount` and any evidence copied onto a change survive the prune.

**Request**

```json
{
  "phone": "+15551234567",
  "messageId": "msg_2f9c...",
  "webhookId": "wh_...",
  "text": "yeah friday works"
}
```

`phone` and `messageId` are required. An unknown (or ambiguous) number is still
logged so its redeliveries dedupe; `studentId` is simply absent from the
response.

**Response `200`**

```json
{ "ok": true, "duplicate": false, "studentId": "j57a...", "warmed": true }
```

---

## 8. The nightly trigger

Every hour, Core's cron (`crons.ts` → `internal.nightly.tick`) finds each active
student whose **local** clock just struck their nightly hour (`nightlyHourLocal`,
default `4`) and who has no plan run for tomorrow yet — plus, for the six hours
after that, any student whose run for tomorrow `failed` or is stuck. For each, it
expires stale
pending changes, computes tomorrow's plan, stores it as a `planRuns` row, and then
starts a Voice session:

```http
POST {EVE_VOICE_URL}/eve/v1/session
Authorization: Bearer {EVE_VOICE_TOKEN}
Content-Type: application/json

{
  "message": "nightly_plan studentId=j57a... date=2026-09-15 planRunId=k82b...",
  "operationId": "nightly:j57a...:2026-09-15"
}
```

### The message

Deliberately a machine-readable trigger line, not prose. Core computes what is
possible; **composition is entirely yours.** Parse the three key=value pairs:

- `studentId` — for every subsequent tool call.
- `date` — the day being planned (tomorrow, in the student's timezone).
- `planRunId` — the stored snapshot. Call `getFeasibleActions` with the same
  `studentId` and `date` and you will get that exact snapshot back
  (`cached: true`, matching `planRunId`).

### `operationId` and create-once

`operationId` is `nightly:<studentId>:<date>` — stable per student-day. eve's
session route treats the same `operationId` under the same principal as
create-once: a retry returns the session it already made rather than dispatching
again. Core enforces the same invariant on its side (a run already `triggered` is
never re-POSTed), so **a student cannot receive two morning texts for one day**
even if the cron double-fires or the network drops a response.

Core reads `sessionId` from the 2xx response body and stores it on the run.

### `triggerStatus`

| Value | Meaning |
|---|---|
| `pending` | Plan stored, not yet sent. A run still `pending` an hour later is treated as stuck and retried. |
| `triggered` | eve accepted the session. Terminal — never re-sent. |
| `failed` | eve returned non-2xx, timed out (15s), or the request errored. Retried by a later tick, up to 6 hours after the student's nightly hour. |
| `skipped` | `EVE_VOICE_URL` or `EVE_VOICE_TOKEN` is unset on this deployment, or the student's timezone is unusable. Expected on dev deployments with no Voice attached; the plan is still computed and stored. Terminal for that student-day. |

### Manual trigger

```bash
npx convex run nightly:runNow '{"studentId": "j57a..."}'
npx convex run nightly:runNow '{"studentId": "j57a...", "date": "2026-09-15"}'
```

Defaults to tomorrow in the student's timezone. Idempotent on the same
student-day, so it will not re-send an already-triggered run.

---

## 9. Deployment environment

Set on the **Convex** deployment (`npx convex env set NAME value`), per
deployment — dev and prod do not share values:

| Var | Purpose |
|---|---|
| `CORE_AGENT_SECRET` | The bearer token every route above requires. Voice needs the same value in its own environment. |
| `EVE_VOICE_URL` | Base URL of the deployed Voice agent, e.g. `https://voice.example.com`. Unset → nightly runs are `skipped`. |
| `EVE_VOICE_TOKEN` | Bearer token for eve's session route. Required for `operationId` create-once — eve rejects `operationId` from anonymous callers. Unset while `EVE_VOICE_URL` is set → the run is `skipped` with that reason; Core never POSTs a trigger unauthenticated. |

---

## 10. Function reference

For anything inside Convex (Face, crons, tests). Voice itself uses only the HTTP
routes above.

| Reference | Kind | Purpose |
|---|---|---|
| `internal.voice.getFeasibleActions` | internalQuery | The plan, cache-aware. |
| `internal.voice.proposeChange` | internalMutation | Propose a change. |
| `internal.voice.recordSignal` | internalMutation | Record a signal. |
| `internal.voice.logUsage` | internalMutation | Log an LLM call. |
| `internal.voice.resolveStudent` | internalQuery | Phone/Clerk id → student. |
| `internal.planner.compute` | internalQuery | Plan for a date, uncached. |
| `api.planner.feasibleActions` | query | Same, for Face, behind `requireStudent`. |
| `internal.signals.record` | internalMutation | Signal write for non-Voice surfaces. |
| `api.signals.list` | query | Recent signals, for Face. |
| `internal.nightly.tick` | internalAction | Hourly cron entry point. |
| `internal.nightly.runForStudent` | internalAction | One student, one day. |
| `internal.nightly.runNow` | internalAction | Manual trigger. |
| `internal.changes.propose` | internalMutation | The changes pipeline itself. |
