"use client"

import * as React from "react"
import { useMutation } from "convex/react"
import { useDialKit } from "dialkit"

import { Button } from "@/components/harness/atoms/Button"
import { EmptyState, LoadingRows, SectionHeader, ToolChip } from "@/components/panels/chrome"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { agoLabel, dueLabel, percent } from "@/lib/format"
import type { Change, Course } from "@/lib/data/types"

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
 */

const ISO_FIELDS = new Set(["dueAt", "plannedFor"])

function fieldValue(field: string, value: string | null): string {
  if (value === null) return "—"
  return ISO_FIELDS.has(field) ? dueLabel(value) : value
}

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

function PendingRow({
  change,
  course,
  onResolve,
}: {
  change: Change
  course?: Course
  onResolve: (id: string, action: "approved" | "fix") => void
}) {
  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center gap-2 border-b border-line">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-orange"
        />
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

      <div className="primitive-card-footer flex min-h-11 items-center gap-2 border-t border-line">
        <ToolChip>{change.toolLabel}</ToolChip>
        {change.confidence !== undefined && (
          <span className="text-[11.5px] tabular-nums text-ink-3">
            {percent(change.confidence)} confident
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="quiet"
            onClick={() => onResolve(change._id, "fix")}
            title="Correct the fact — flows through changes as a manual origin"
          >
            Fix
          </Button>
          <Button
            size="xs"
            variant="primary"
            onClick={() => onResolve(change._id, "approved")}
          >
            Approve
          </Button>
        </span>
      </div>
    </div>
  )
}

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

export function ChangeFeed({
  changes,
  courses,
}: {
  changes: Change[] | undefined
  courses: Course[] | undefined
}) {
  const dials = useDialKit("Change feed", {
    /** row height of the quiet "already applied" rows */
    appliedRowHeight: [40, 28, 64] as [number, number, number],
    /** how many applied rows before "show all" */
    appliedVisible: [4, 2, 12, 1] as [number, number, number, number],
  })

  const approve = useMutation(api.changes.approve)
  const [resolved, setResolved] = React.useState<Record<string, string>>({})
  const [showAll, setShowAll] = React.useState(false)

  const byId = React.useMemo(
    () => new Map((courses ?? []).map((c) => [c._id, c])),
    [courses]
  )

  if (changes === undefined) {
    return (
      <section className="flex flex-col gap-2">
        <SectionHeader title="Changes" />
        <LoadingRows rows={3} />
      </section>
    )
  }

  /* Only an approval takes a row out of `pending`. "Fix" opens an inline
   * correction that doesn't exist yet, so hiding the row on that click would
   * claim work nobody did — it stays until the correction is actually made. */
  const pending = changes.filter(
    (c) => c.status === "pending" && resolved[c._id] !== "approved"
  )
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
          {pending.map((change) => (
            <PendingRow
              key={change._id}
              change={change}
              course={change.courseId ? byId.get(change.courseId) : undefined}
              onResolve={(id, action) => {
                // The local record is optimistic feedback; the subscription
                // flips the row for real once Core applies it. A failed
                // approve un-hides the row rather than claiming it landed.
                setResolved((r) => ({ ...r, [id]: action }))
                if (action === "approved") {
                  approve({ changeId: id as Id<"changes">, via: "web" }).catch(
                    (error) => {
                      console.error("changes.approve failed", error)
                      setResolved((r) =>
                        Object.fromEntries(
                          Object.entries(r).filter(([key]) => key !== id)
                        )
                      )
                    }
                  )
                }
                // "Fix" (api.changes.propose, origin "manual") still needs its
                // inline correction UI; the row deliberately stays visible.
              }}
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
