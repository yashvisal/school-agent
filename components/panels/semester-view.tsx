"use client"

import * as React from "react"

import { SegmentedControl } from "@/components/harness/atoms/SegmentedControl"
import { DeadlinesTable } from "@/components/panels/deadlines-table"
import { ViewportBody, ViewportHeader } from "@/components/panels/chrome"
import { TodayPlan } from "@/components/panels/today-plan"
import { daysAway } from "@/lib/format"
import { useChanges, useCourses, useDeadlines, useTasks } from "@/lib/data/hooks"

/**
 * Semester — calendar-shaped, filterable by course, zoomable week/month/
 * semester, diffs highlighted. Click into anything for facts + provenance.
 * **Never drag-to-plan** (face.md M1 #4): this is a view of the plan, not a
 * scheduler. Replanning happens in the thread.
 */

const ZOOMS = ["Week", "Month", "Semester"] as const
type Zoom = (typeof ZOOMS)[number]

const HORIZON: Record<Zoom, number> = { Week: 7, Month: 31, Semester: 400 }

export function SemesterView() {
  const courses = useCourses()
  const deadlines = useDeadlines()
  const tasks = useTasks()
  const changes = useChanges()

  const [zoom, setZoom] = React.useState<Zoom>("Month")
  const [courseId, setCourseId] = React.useState<string | null>(null)

  const scoped = React.useMemo(() => {
    if (!deadlines) return undefined
    const horizon = HORIZON[zoom]
    return deadlines
      .filter((d) => {
        const n = daysAway(d.dueAt)
        return n >= 0 && n <= horizon
      })
      .filter((d) => (courseId ? d.courseId === courseId : true))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  }, [deadlines, zoom, courseId])

  return (
    <>
      <ViewportHeader
        title="Semester"
        meta={scoped ? `${scoped.length} deadlines` : undefined}
        actions={
          <SegmentedControl
            options={ZOOMS}
            value={zoom}
            onChange={(v) => setZoom(v)}
          />
        }
      />
      <ViewportBody>
        {/* course filter */}
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            label="All courses"
            active={courseId === null}
            onClick={() => setCourseId(null)}
          />
          {courses?.map((course) => (
            <FilterChip
              key={course._id}
              label={course.code}
              accent={course.accent}
              active={courseId === course._id}
              onClick={() =>
                setCourseId(courseId === course._id ? null : course._id)
              }
            />
          ))}
        </div>

        <DeadlinesTable
          title={zoom === "Week" ? "This week" : zoom === "Month" ? "This month" : "Rest of term"}
          deadlines={scoped}
          courses={courses}
          changes={changes}
          emptyLine={`Nothing due in this ${zoom.toLowerCase()}.`}
          emptyDetail="Widen the zoom or clear the course filter — the term's other deadlines are still there."
        />

        <TodayPlan
          title="Planned today"
          tasks={tasks}
          deadlines={deadlines}
          courses={courses}
          courseId={courseId ?? undefined}
        />
      </ViewportBody>
    </>
  )
}

function FilterChip({
  label,
  active,
  accent,
  onClick,
}: {
  label: string
  active: boolean
  accent?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium transition-colors duration-100 ${
        active
          ? "bg-ink text-canvas"
          : "bg-surface text-ink-2 shadow-btn hover:bg-hover"
      }`}
    >
      {accent && (
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ background: active ? "currentColor" : accent }}
        />
      )}
      {label}
    </button>
  )
}
