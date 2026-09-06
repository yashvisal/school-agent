"use client"

import * as React from "react"
import { useMutation } from "convex/react"
import { useDialKit } from "dialkit"

import { Button } from "@/components/harness/atoms/Button"
import { SelectField, TextField } from "@/components/panels/form"
import { EmptyState, LoadingRows, SectionHeader, ToolChip } from "@/components/panels/chrome"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { agoLabel, dueLabel, percent } from "@/lib/format"
import { errorMessage } from "@/lib/errors"
import type { Change, ChangeOrigin, Course, Deadline, DeadlineKind } from "@/lib/data/types"

/**
 * The change feed — the harness approval card and tool chips, mapped onto Core
 * concepts (face.md "Primitive → product mapping").
 *
 * Two tiers, and the difference is the whole point (core.md "Approval channels"):
 * `auto`/`applied` rows from Canvas and iCal are **quiet** — they already
 * happened, they carry a tool chip saying how, and they are here so nothing is
 * a surprise. Only `needs_approval`/`pending` rows ask for anything, and this
 * must never become a chore inbox: chat drains it first, so what is left is
 * bulk parses and source conflicts.
 *
 * A bulk parse is ONE decision, not eighteen. Every change from one extraction
 * run shares a `batchId` (`${sourceId}:${snapshotId}`), so pending rows that
 * carry one collapse into a single card — "18 items from CHEM 202's syllabus" —
 * approved in one gesture with `api.changes.approveMany({ batchId })`.
 */

const ISO_FIELDS = new Set(["dueAt", "plannedFor"])

function fieldValue(field: string, value: string | null): string {
  if (value === null) return "—"
  return ISO_FIELDS.has(field) ? dueLabel(value) : value
}

/** What a batch came *out of*, in the student's words. */
const ORIGIN_DOCUMENT: Partial<Record<ChangeOrigin, string>> = {
  syllabus: "syllabus",
  site: "course site",
  schedule: "class schedule",
}
const ORIGIN_FEED: Partial<Record<ChangeOrigin, string>> = {
  canvas: "Canvas",
  ical: "your calendar feed",
  chat: "the thread",
  manual: "your own corrections",
}

const DEADLINE_KINDS: DeadlineKind[] = [
  "homework",
  "project",
  "exam",
  "quiz",
  "reading",
  "other",
]

function DiffLine({
  field,
  before,
  after,
}: {
  field: string
  before: string | null
  after: string | null
}) {
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="w-24 shrink-0 truncate text-ink-3">{field}</span>
      {before !== null && (
        <span className="rounded-[4px] bg-red-tint px-1 text-red line-through">
          {fieldValue(field, before)}
        </span>
      )}
      <span className="rounded-[4px] bg-green-tint px-1 text-green">
        {fieldValue(field, after)}
      </span>
    </div>
  )
}

/* ── the Fix editor ─────────────────────────────────────────────────────── */

/** Local-naive `YYYY-MM-DD` and `HH:MM` out of an ISO instant, for the inputs. */
function splitLocal(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}

/**
 * The correction, inline on the card the student is already looking at.
 *
 * Deliberately three fields — title, when, what kind of work it is — because
 * those are what a syllabus parse gets wrong, and because `proposeManual`
 * proposes AND approves in one mutation: a bigger form here would be an
 * unreviewed write surface. Everything else is fixed in the course overview.
 *
 * Only `deadline_moved`/`deadline_updated` are sent, chosen by what actually
 * moved — a change row that says "due date moved" when the title changed is a
 * lie in the feed forever.
 */
function FixEditor({
  change,
  deadline,
  onDone,
  onCancel,
}: {
  change: Change
  deadline: Deadline
  onDone: () => void
  onCancel: () => void
}) {
  const proposeManual = useMutation(api.changes.proposeManual)
  const initial = React.useMemo(() => splitLocal(deadline.dueAt), [deadline.dueAt])
  const [title, setTitle] = React.useState(deadline.title)
  const [date, setDate] = React.useState(initial.date)
  const [time, setTime] = React.useState(initial.time)
  const [kind, setKind] = React.useState<DeadlineKind>(deadline.kind)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const nextDueAt = new Date(`${date}T${time}`).getTime()
  const dueMoved =
    Number.isFinite(nextDueAt) && nextDueAt !== new Date(deadline.dueAt).getTime()
  const titleMoved = title.trim().length > 0 && title.trim() !== deadline.title
  const kindMoved = kind !== deadline.kind
  const dirty = dueMoved || titleMoved || kindMoved

  const submit = async (removing: boolean) => {
    if (!removing && !Number.isFinite(nextDueAt)) {
      setError("That date and time don't parse — check both fields.")
      return
    }
    setSaving(true)
    setError(null)
    try {
      await proposeManual({
        kind: removing
          ? "deadline_removed"
          : dueMoved && !titleMoved && !kindMoved
            ? "deadline_moved"
            : "deadline_updated",
        entity: { table: "deadlines", id: deadline._id },
        before: removing
          ? { status: "active" }
          : {
              ...(titleMoved ? { title: deadline.title } : {}),
              ...(dueMoved ? { dueAt: new Date(deadline.dueAt).getTime() } : {}),
              ...(kindMoved ? { kind: deadline.kind } : {}),
            },
        after: removing
          ? { status: "removed" }
          : {
              ...(titleMoved ? { title: title.trim() } : {}),
              ...(dueMoved ? { dueAt: nextDueAt } : {}),
              ...(kindMoved ? { kind } : {}),
            },
        ...(change.courseId || deadline.courseId
          ? { courseId: (change.courseId ?? deadline.courseId) as Id<"courses"> }
          : {}),
        reason: "corrected in the change feed",
        // The pending card this answers is rejected in the same transaction,
        // so the queue stops asking about a value the student just overrode.
        supersedesChangeId: change._id as Id<"changes">,
      })
      onDone()
    } catch (cause) {
      setError(errorMessage(cause))
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <TextField
          aria-label="Title"
          className="min-w-0 flex-1"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <SelectField
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as DeadlineKind)}
        >
          {DEADLINE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TextField
          aria-label="Due date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <TextField
          aria-label="Due time"
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
        />
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="xs" variant="quiet" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant="quiet"
            disabled={saving}
            onClick={() => void submit(true)}
            title="Record that this deadline isn't real"
          >
            Remove
          </Button>
          <Button
            size="xs"
            variant="primary"
            disabled={!dirty || saving}
            onClick={() => void submit(false)}
          >
            {saving ? "Saving…" : "Save fix"}
          </Button>
        </span>
      </div>
      {error && <p className="text-[12px] text-red">{error}</p>}
    </div>
  )
}

/* ── one pending change ─────────────────────────────────────────────────── */

function PendingRow({
  change,
  course,
  deadline,
  onApprove,
}: {
  change: Change
  course?: Course
  /** The row this change edits, when it already exists. */
  deadline?: Deadline
  onApprove: (id: string) => void
}) {
  const [fixing, setFixing] = React.useState(false)
  const fixable = change.entityTable === "deadlines" && deadline !== undefined

  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center gap-2 border-b border-line">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          {course ? `${course.code} · ` : ""}
          {change.summary}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-3">{agoLabel(change.at)}</span>
      </div>

      <div className="flex flex-col gap-1 px-3 py-2.5">
        {change.fields.map((f) => (
          <DiffLine key={f.field} field={f.field} before={f.before} after={f.after} />
        ))}
      </div>

      {fixing && fixable && (
        <FixEditor
          change={change}
          deadline={deadline}
          onDone={() => setFixing(false)}
          onCancel={() => setFixing(false)}
        />
      )}

      <div className="primitive-card-footer flex min-h-11 items-center gap-2 border-t border-line">
        <ToolChip>{change.toolLabel}</ToolChip>
        {change.confidence !== undefined && (
          <span className="text-[11.5px] tabular-nums text-ink-3">
            {percent(change.confidence)} confident
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {fixable ? (
            <Button
              size="xs"
              variant="quiet"
              aria-expanded={fixing}
              onClick={() => setFixing((f) => !f)}
              title="Correct the fact — flows through changes as a manual origin"
            >
              {fixing ? "Close" : "Fix"}
            </Button>
          ) : (
            /* A pending `deadline_added` names a row that doesn't exist yet, and
             * a course or task edit is a bigger form than a diff card should
             * carry. Say where the fix lives instead of a button that 404s. */
            <span className="text-[11.5px] text-ink-3">
              {change.entityTable === "deadlines"
                ? "approve it, then fix it in the course overview"
                : "fix in the course overview"}
            </span>
          )}
          <Button size="xs" variant="primary" onClick={() => onApprove(change._id)}>
            Approve
          </Button>
        </span>
      </div>
    </div>
  )
}

/* ── one extraction run ─────────────────────────────────────────────────── */

function batchLabel(changes: Change[], courses: Map<string, Course>): string {
  const origin = changes[0].origin
  const courseIds = new Set(changes.map((c) => c.courseId).filter(Boolean))
  const course =
    courseIds.size === 1 ? courses.get([...courseIds][0] as string) : undefined
  const document = ORIGIN_DOCUMENT[origin]
  const noun = document
    ? course
      ? `${course.code}'s ${document}`
      : `a ${document}`
    : (ORIGIN_FEED[origin] ?? "one source")
  return `${changes.length} items from ${noun}`
}

function BatchCard({
  batchId,
  changes,
  courses,
  deadlines,
  expandMs,
  onApprove,
}: {
  batchId: string
  changes: Change[]
  courses: Map<string, Course>
  deadlines: Map<string, Deadline>
  expandMs: number
  onApprove: (id: string) => void
}) {
  const approveMany = useMutation(api.changes.approveMany)
  const [open, setOpen] = React.useState(false)
  /* `finishing` is not a spinner waiting on a promise: the mutation already
   * returned. A batch bigger than one page hands the rest to a scheduled
   * continuation, and the card is only gone once the subscription has no
   * pending rows left for the run — which unmounts this component. So the
   * state is cleared by disappearing, not by a timer. */
  const [status, setStatus] = React.useState<"idle" | "approving" | "finishing">(
    "idle"
  )
  const [error, setError] = React.useState<string | null>(null)

  const onApproveAll = async () => {
    setStatus("approving")
    setError(null)
    try {
      // Batch mode, not a list of ids: Core approves every pending change the
      // caller still has from that run, so a card rendered a second ago and a
      // row that landed since are both covered.
      const result = await approveMany({ batchId, via: "web" })
      setStatus(result.continued ? "finishing" : "idle")
    } catch (cause) {
      setError(errorMessage(cause))
      setStatus("idle")
    }
  }

  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center gap-2 border-b border-line">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          {batchLabel(changes, courses)}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-3">
          {agoLabel(changes[0].at)}
        </span>
      </div>

      <div
        className="grid transition-[grid-template-rows] ease-out"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          transitionDuration: `${expandMs}ms`,
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-2 p-2.5">
            {changes.map((change) => (
              <PendingRow
                key={change._id}
                change={change}
                course={change.courseId ? courses.get(change.courseId) : undefined}
                deadline={
                  change.deadlineId ? deadlines.get(change.deadlineId) : undefined
                }
                onApprove={onApprove}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="primitive-card-footer flex min-h-11 items-center gap-2 border-t border-line">
        <ToolChip>{changes[0].toolLabel}</ToolChip>
        {error && <span className="text-[11.5px] text-red">{error}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="quiet"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Collapse" : `Review ${changes.length}`}
          </Button>
          <Button
            size="xs"
            variant="primary"
            disabled={status !== "idle"}
            onClick={() => void onApproveAll()}
          >
            {status === "approving"
              ? "Approving…"
              : status === "finishing"
                ? "Finishing up…"
                : "Approve all"}
          </Button>
        </span>
      </div>
    </div>
  )
}

/* ── applied rows ───────────────────────────────────────────────────────── */

function AppliedRow({
  change,
  course,
  density,
}: {
  change: Change
  course?: Course
  density: number
}) {
  return (
    <div
      className="flex items-center gap-2.5 border-b border-line px-3 last:border-0"
      style={{ minHeight: density }}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-line-strong" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
        {course && <span className="text-ink">{course.code} </span>}
        {change.summary}
      </span>
      <ToolChip>{change.toolLabel}</ToolChip>
      <span className="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-ink-3">
        {agoLabel(change.at)}
      </span>
    </div>
  )
}

/* ── the feed ───────────────────────────────────────────────────────────── */

export function ChangeFeed({
  changes,
  courses,
  deadlines,
}: {
  changes: Change[] | undefined
  courses: Course[] | undefined
  /** Used to prefill the Fix editor; without it Fix falls back to its note. */
  deadlines?: Deadline[]
}) {
  const dials = useDialKit("Change feed", {
    /** row height of the quiet "already applied" rows */
    appliedRowHeight: [40, 28, 64] as [number, number, number],
    /** how many applied rows before "show all" */
    appliedVisible: [4, 2, 12, 1] as [number, number, number, number],
    /** how long a batch card takes to open its rows */
    batchExpand: [220, 80, 500] as [number, number, number],
  })

  const approve = useMutation(api.changes.approve)
  const [resolved, setResolved] = React.useState<Record<string, string>>({})
  const [showAll, setShowAll] = React.useState(false)

  const byId = React.useMemo(
    () => new Map((courses ?? []).map((c) => [c._id, c])),
    [courses]
  )
  const deadlineById = React.useMemo(
    () => new Map((deadlines ?? []).map((d) => [d._id, d])),
    [deadlines]
  )

  const onApprove = React.useCallback(
    (id: string) => {
      // The local record is optimistic feedback; the subscription flips the row
      // for real once Core applies it. A failed approve un-hides the row rather
      // than claiming it landed.
      setResolved((r) => ({ ...r, [id]: "approved" }))
      approve({ changeId: id as Id<"changes">, via: "web" }).catch((error) => {
        console.error("changes.approve failed", error)
        setResolved((r) =>
          Object.fromEntries(Object.entries(r).filter(([key]) => key !== id))
        )
      })
    },
    [approve]
  )

  if (changes === undefined) {
    return (
      <section className="flex flex-col gap-2">
        <SectionHeader title="Changes" />
        <LoadingRows rows={3} />
      </section>
    )
  }

  /* Only an approval takes a row out of `pending`. A Fix rejects the card it
   * answers server-side, so the subscription removes that one on its own. */
  const pending = changes.filter(
    (c) => c.status === "pending" && resolved[c._id] !== "approved"
  )

  /* Group by run. A batch of one is rendered as itself: a card that says
   * "1 item from a syllabus" is a worse version of the row it wraps. */
  const batches = new Map<string, Change[]>()
  const singles: Change[] = []
  for (const change of pending) {
    if (!change.batchId) {
      singles.push(change)
      continue
    }
    const group = batches.get(change.batchId)
    if (group) group.push(change)
    else batches.set(change.batchId, [change])
  }
  for (const [batchId, group] of batches) {
    if (group.length === 1) {
      singles.push(group[0])
      batches.delete(batchId)
    }
  }

  /* An approval must leave a trace, not just vanish: while the mutation is in
   * flight, keep the locally-approved change visible at the top of "applied".
   * Only while its durable status is still `pending` — once the subscription
   * reflects the approval, the second filter carries the row, and keeping the
   * optimistic copy too would show it twice. */
  const applied = [
    ...changes.filter(
      (c) => resolved[c._id] === "approved" && c.status === "pending"
    ),
    ...changes.filter((c) => c.status === "applied" || c.status === "approved"),
  ]
  const visibleApplied = showAll
    ? applied
    : applied.slice(0, Math.round(dials.appliedVisible))

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Changes"
        count={pending.length > 0 ? pending.length : undefined}
        hint={
          pending.length > 0
            ? "chat couldn't confirm these in the moment"
            : undefined
        }
      />

      {pending.length === 0 ? (
        <EmptyState
          line="Nothing is waiting on you."
          detail={`${applied.length} change${
            applied.length === 1 ? "" : "s"
          } applied themselves from Canvas and your calendar feed. Anything the thread couldn't confirm in the moment would land here.`}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {[...batches].map(([batchId, group]) => (
            <BatchCard
              key={batchId}
              batchId={batchId}
              changes={group}
              courses={byId}
              deadlines={deadlineById}
              expandMs={dials.batchExpand}
              onApprove={onApprove}
            />
          ))}
          {singles.map((change) => (
            <PendingRow
              key={change._id}
              change={change}
              course={change.courseId ? byId.get(change.courseId) : undefined}
              deadline={
                change.deadlineId ? deadlineById.get(change.deadlineId) : undefined
              }
              onApprove={onApprove}
            />
          ))}
        </div>
      )}

      {applied.length > 0 && (
        <div className="overflow-hidden rounded-card bg-surface shadow-card">
          <div className="primitive-card-bar flex items-center gap-2 border-b border-line">
            <span className="text-[12px] font-medium text-ink-2">
              Applied without asking
            </span>
            <span className="ml-auto text-[11.5px] text-ink-3">
              structured sources — Canvas, calendar feeds
            </span>
          </div>
          {visibleApplied.map((change) => (
            <AppliedRow
              key={change._id}
              change={change}
              course={change.courseId ? byId.get(change.courseId) : undefined}
              density={dials.appliedRowHeight}
            />
          ))}
          {applied.length > visibleApplied.length && (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="flex h-9 w-full items-center justify-center border-t border-line text-[12px] text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink"
            >
              {applied.length - visibleApplied.length} more
            </button>
          )}
        </div>
      )}
    </section>
  )
}
