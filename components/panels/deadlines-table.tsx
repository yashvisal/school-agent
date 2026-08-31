"use client"

import * as React from "react"

import { EmptyState, LoadingRows, SectionHeader } from "@/components/panels/chrome"
import { ProvenanceTrigger } from "@/components/panels/provenance"
import { dueLabel, relativeDays } from "@/lib/format"
import type { Change, Course, Deadline, DeadlineKind } from "@/lib/data/types"

/**
 * Upcoming deadlines in the harness's records/diff-table grammar: a hairline
 * card, `primitive-table-cell` padding, and rows tinted by the open change
 * touching them — green for added, orange for pending approval, red for
 * removed. (Upstream `DiffTable` / `RecordsTable` are hardwired to the
 * ice-cream demo's columns and stage animation, so this is built in their
 * grammar rather than by props.)
 *
 * Clicking a row opens facts + provenance. No drag: Semester is not a scheduler
 * (face.md M1 #4).
 */

const KIND_DOT: Record<DeadlineKind, string> = {
  exam: "bg-red",
  quiz: "bg-orange",
  project: "bg-accent",
  homework: "bg-green",
  reading: "bg-ink-3",
  other: "bg-line-strong",
}

export type DeadlineDiff = "added" | "moved" | "pending" | undefined

function diffFor(deadline: Deadline, changes: Change[] | undefined): DeadlineDiff {
  if (deadline.pendingChangeId) return "pending"
  const recent = changes?.find(
    (c) =>
      c.deadlineId === deadline._id &&
      c.status === "applied" &&
      (c.kind === "deadline_added" || c.kind === "deadline_moved")
  )
  if (!recent) return undefined
  return recent.kind === "deadline_added" ? "added" : "moved"
}

const DIFF_STYLE: Record<
  Exclude<DeadlineDiff, undefined>,
  { bg: string; label: string; tone: string }
> = {
  added: { bg: "var(--green-tint)", label: "new", tone: "text-green" },
  moved: { bg: "var(--orange-tint)", label: "moved", tone: "text-orange" },
  pending: {
    bg: "color-mix(in oklch, var(--orange-tint) 55%, transparent)",
    label: "may move",
    tone: "text-orange",
  },
}

export function DeadlinesTable({
  title,
  deadlines,
  courses,
  changes,
  emptyLine,
  emptyDetail,
}: {
  title: string
  deadlines: Deadline[] | undefined
  courses: Course[] | undefined
  changes: Change[] | undefined
  emptyLine: string
  emptyDetail?: string
}) {
  const courseById = React.useMemo(
    () => new Map((courses ?? []).map((c) => [c._id, c])),
    [courses]
  )

  if (deadlines === undefined || courses === undefined) {
    return (
      <section className="flex flex-col gap-3">
        <SectionHeader title={title} />
        <LoadingRows rows={4} />
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title={title}
        count={deadlines.length}
        hint={deadlines.length > 0 ? "click a row for facts and provenance" : undefined}
      />

      {deadlines.length === 0 ? (
        <EmptyState line={emptyLine} detail={emptyDetail} />
      ) : (
        <div className="overflow-hidden rounded-card bg-surface shadow-card">
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col className="w-[48%]" />
              <col className="w-[18%]" />
              <col className="w-[20%]" />
              <col className="w-[14%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-line">
                {["What", "Course", "Due", ""].map((h, i) => (
                  <th
                    key={h || i}
                    className="primitive-table-cell text-[12px] font-medium text-ink-3"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {deadlines.map((deadline) => {
                const course = courseById.get(deadline.courseId)
                const diff = diffFor(deadline, changes)
                const style = diff ? DIFF_STYLE[diff] : undefined
                return (
                  <tr
                    key={deadline._id}
                    className="border-b border-line transition-[background-color] duration-150 last:border-0 hover:brightness-[0.99]"
                    style={{ background: style?.bg }}
                  >
                    <td className="primitive-table-cell">
                      <ProvenanceTrigger
                        title={deadline.title}
                        provenance={deadline.provenance}
                        facts={[
                          { label: "Kind", value: deadline.kind },
                          { label: "Due", value: dueLabel(deadline.dueAt) },
                          ...(deadline.pointsPossible !== undefined
                            ? [
                                {
                                  label: "Points possible",
                                  value: String(deadline.pointsPossible),
                                },
                              ]
                            : []),
                          ...(deadline.category
                            ? [{ label: "Category", value: deadline.category }]
                            : []),
                          ...(deadline.submissionStatus
                            ? [
                                {
                                  label: "Submission",
                                  value: deadline.submissionStatus,
                                },
                              ]
                            : []),
                        ]}
                        className="flex w-full min-w-0 items-center gap-2 text-left"
                      >
                        <span
                          aria-hidden
                          className={`size-1.5 shrink-0 rounded-full ${KIND_DOT[deadline.kind]}`}
                        />
                        <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                          {deadline.title}
                        </span>
                      </ProvenanceTrigger>
                    </td>
                    <td className="primitive-table-cell">
                      <span className="text-[12.5px] text-ink-2">
                        {course?.code ?? "—"}
                      </span>
                    </td>
                    <td className="primitive-table-cell">
                      <span className="text-[12.5px] whitespace-nowrap text-ink-2 tabular-nums">
                        {dueLabel(deadline.dueAt)}
                      </span>
                    </td>
                    <td className="primitive-table-cell text-right">
                      {style ? (
                        <span
                          className={`text-[11.5px] font-medium ${style.tone}`}
                        >
                          {style.label}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-ink-3 tabular-nums">
                          {relativeDays(deadline.dueAt)}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
