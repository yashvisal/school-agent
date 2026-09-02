"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { EmptyState, LoadingRows } from "@/components/panels/chrome"
import { agoLabel, dueLabel, minutesLabel, timeLabel } from "@/lib/format"
import {
  useCourses,
  useDeadlines,
  useSources,
  useStudentSignals,
  useTasks,
} from "@/lib/data/hooks"

/**
 * The adaptive rail. It flips role with the viewport (vision §8):
 *
 *  - **Context** — the sources behind what you're looking at, with provenance.
 *  - **Tasks** — this course's plan, read-only, from Core.
 *
 * There is no Chat slot: in course mode the conversation is the **viewport**
 * (vision §8 "Course mode"), so a rail tab for it would be a second place to
 * have the same conversation.
 *
 * Which slots exist is decided by the route rather than by a parallel route,
 * so pages stay plain components; `AppShell` renders this beside `children`.
 * Hidden below `lg`.
 */

type Slot = "Context" | "Tasks"

function RailHeader({
  slots,
  active,
  onSelect,
}: {
  slots: Slot[]
  active: Slot
  onSelect: (slot: Slot) => void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-line px-2">
      {slots.map((slot) => (
        <button
          key={slot}
          type="button"
          aria-pressed={slot === active}
          onClick={() => onSelect(slot)}
          className={`flex h-7 items-center rounded-[7px] px-2.5 text-[12.5px] font-medium transition-colors duration-100 ${
            slot === active
              ? "bg-hover-2 text-ink"
              : "text-ink-3 hover:bg-hover hover:text-ink-2"
          }`}
        >
          {slot}
        </button>
      ))}
    </div>
  )
}

function ContextPanel({ courseId }: { courseId?: string }) {
  const sources = useSources()
  const signals = useStudentSignals()
  const courses = useCourses()

  const course = courseId ? courses?.find((c) => c._id === courseId) : undefined
  const scopedSignals = courseId
    ? signals?.filter((s) => s.courseId === courseId)
    : signals

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-col gap-2">
        <span className="px-0.5 text-[12.5px] font-semibold text-ink">
          Where this comes from
        </span>
        {sources === undefined && <LoadingRows rows={3} />}
        {sources?.map((source) => (
          <div
            key={source._id}
            className="overflow-hidden rounded-card bg-surface shadow-card"
          >
            <div className="primitive-card-bar flex items-center gap-2 border-b border-line">
              <span
                aria-hidden
                className={`size-1.5 shrink-0 rounded-full ${
                  source.health === "healthy"
                    ? "bg-green"
                    : source.health === "failing"
                      ? "bg-red"
                      : source.health === "degraded"
                        ? "bg-orange"
                        : "bg-ink-3"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                {source.label}
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                {source.lastPolledAt ? agoLabel(source.lastPolledAt) : "one-time"}
              </span>
            </div>
            <p className="px-3 py-2 font-mono text-[11px] text-ink-2">
              {source.detail}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className="px-0.5 text-[12.5px] font-semibold text-ink">
          {course ? `What we've noticed in ${course.code}` : "What we've noticed"}
        </span>
        {scopedSignals === undefined ? (
          <LoadingRows rows={2} />
        ) : scopedSignals.length > 0 ? (
          scopedSignals.map((signal) => (
            <div
              key={signal._id}
              className="rounded-card bg-surface px-3 py-2.5 shadow-card"
            >
              <p className="text-[12.5px] leading-relaxed text-ink">
                {signal.text}
              </p>
              <p className="mt-1 text-[11.5px] text-ink-3">
                {signal.kind} · {signal.origin} · {agoLabel(signal.observedAt)}
              </p>
            </div>
          ))
        ) : (
          <EmptyState
            line="Nothing observed here yet."
            detail="Signals are stored as they were said or seen, never rolled into a score."
          />
        )}
      </div>
    </div>
  )
}

function TasksPanel({ courseId }: { courseId?: string }) {
  const tasks = useTasks()
  const deadlines = useDeadlines()
  const courses = useCourses()

  const courseById = React.useMemo(
    () => new Map((courses ?? []).map((c) => [c._id, c])),
    [courses]
  )
  const deadlineById = React.useMemo(
    () => new Map((deadlines ?? []).map((d) => [d._id, d])),
    [deadlines]
  )

  const scoped = React.useMemo(
    () =>
      tasks
        ?.filter((t) => (courseId ? t.courseId === courseId : true))
        // Core serves every status (Face windows client-side); only open work
        // belongs in the rail — `done` and `skipped` are history, not plan.
        .filter((t) => t.status !== "done" && t.status !== "skipped")
        .sort((a, b) => (a.plannedFor ?? "").localeCompare(b.plannedFor ?? "")),
    [tasks, courseId]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
      <span className="px-0.5 text-[12.5px] font-semibold text-ink">
        The plan — read only
      </span>
      {scoped === undefined ? (
        <LoadingRows rows={3} />
      ) : scoped.length > 0 ? (
        scoped.map((task) => {
          const deadline = task.deadlineId
            ? deadlineById.get(task.deadlineId)
            : undefined
          const course = task.courseId ? courseById.get(task.courseId) : undefined
          return (
            <div
              key={task._id}
              className="rounded-card bg-surface px-3 py-2.5 shadow-card"
            >
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink">
                  {task.title}
                </span>
                {task.plannedFor && (
                  <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                    {timeLabel(task.plannedFor)}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11.5px] text-ink-3">
                {course ? `${course.code} · ` : ""}
                {deadline ? `for ${dueLabel(deadline.dueAt)}` : "no deadline"}
                {task.estEffortMin
                  ? ` · ~${minutesLabel(task.estEffortMin)}`
                  : ""}
              </p>
            </div>
          )
        })
      ) : (
        <EmptyState
          line="Nothing open here."
          detail="Tasks arrive from the nightly plan. Changing them is a conversation in the thread, not a click here."
        />
      )}
    </div>
  )
}

export function AppRail() {
  const pathname = usePathname()
  const courseMatch = /^\/courses\/([^/]+)/.exec(pathname)
  const courseId = courseMatch?.[1]

  const slots: Slot[] = ["Context", "Tasks"]

  const [active, setActive] = React.useState<Slot>("Context")
  /* the rail flips role with the viewport: reset the slot when the course
   * changes (adjusted during render, not from an effect) */
  const [slotFor, setSlotFor] = React.useState(courseId)
  if (slotFor !== courseId) {
    setSlotFor(courseId)
    setActive("Context")
  }

  return (
    <>
      <RailHeader slots={slots} active={active} onSelect={setActive} />
      {active === "Tasks" ? (
        <TasksPanel courseId={courseId} />
      ) : (
        <ContextPanel courseId={courseId} />
      )}
    </>
  )
}
