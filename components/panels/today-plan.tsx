"use client"

import * as React from "react"
import { useDialKit } from "dialkit"

import TaskRows, { type TaskRow } from "@/components/harness/primitives/TaskRows"
import { EmptyState, LoadingRows, SectionHeader } from "@/components/panels/chrome"
import { daysAway, dueLabel, minutesLabel, timeLabel } from "@/lib/format"
import type { Course, Deadline, Task } from "@/lib/data/types"

/**
 * Today's plan, rendered with the harness `TaskRows` primitive. Read-only by
 * design: the plan is negotiated in the thread, never here (vision §8 scope
 * rule). Expanding a row shows why it is on the list — the deadline it serves,
 * what it is worth, and the effort estimate, labelled as the low-confidence
 * prior it is (core.md "Effort estimates").
 */

const STATUS: Record<Task["status"], TaskRow["status"]> = {
  done: "done",
  in_progress: "running",
  todo: "todo",
  skipped: "todo",
}

export function TodayPlan({
  tasks,
  deadlines,
  courses,
  title = "Today",
  courseId,
}: {
  tasks: Task[] | undefined
  deadlines: Deadline[] | undefined
  courses: Course[] | undefined
  title?: string
  /** scope to one course (the workspace Tasks rail) */
  courseId?: string
}) {
  const dials = useDialKit("Dashboard reveal", {
    /** per-row entrance stagger */
    stagger: [80, 0, 200] as [number, number, number],
    /** entrance duration */
    duration: [450, 120, 900] as [number, number, number],
  })

  const rows = React.useMemo<TaskRow[] | undefined>(() => {
    if (!tasks || !deadlines || !courses) return undefined
    const courseById = new Map(courses.map((c) => [c._id, c]))
    const deadlineById = new Map(deadlines.map((d) => [d._id, d]))

    return tasks
      .filter((t) => (courseId ? t.courseId === courseId : true))
      .filter((t) => t.plannedFor !== undefined && daysAway(t.plannedFor) === 0)
      .sort((a, b) => (a.plannedFor ?? "").localeCompare(b.plannedFor ?? ""))
      .map((task, i) => {
        const course = task.courseId ? courseById.get(task.courseId) : undefined
        const deadline = task.deadlineId
          ? deadlineById.get(task.deadlineId)
          : undefined
        const details = [
          deadline
            ? { label: deadline.title, meta: dueLabel(deadline.dueAt) }
            : { label: "No deadline attached", meta: "standalone" },
          deadline?.pointsPossible !== undefined
            ? {
                label: deadline.category ?? "Ungrouped",
                meta: `${deadline.pointsPossible} pts`,
              }
            : { label: "Not graded", meta: "—" },
          {
            label:
              task.type === "prepared"
                ? "Prepared for you"
                : "Estimated effort (low confidence)",
            meta: task.estEffortMin ? minutesLabel(task.estEffortMin) : "—",
          },
        ]
        return {
          key: task._id,
          label: task.title,
          amount: course?.code ?? "",
          status: STATUS[task.status],
          step: i + 1,
          pill: task.plannedFor ? timeLabel(task.plannedFor) : undefined,
          details,
        }
      })
  }, [tasks, deadlines, courses, courseId])

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title={title}
        count={rows?.length}
        hint={rows && rows.length > 0 ? "planned in the thread" : undefined}
      />
      {rows === undefined ? (
        <LoadingRows rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          line="Nothing is planned for today."
          detail="Tomorrow's plan is built overnight and arrives in the thread first thing. If that's wrong, say so there — the plan is negotiated in the thread, not here."
        />
      ) : (
        <TaskRows
          rows={rows}
          labels={{ completed: "Done", failed: "Missed" }}
          stagger={dials.stagger}
          duration={dials.duration}
          className="max-w-none"
        />
      )}
    </section>
  )
}
