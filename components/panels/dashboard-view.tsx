"use client"

import * as React from "react"

import { ChangeFeed } from "@/components/panels/change-feed"
import { DeadlinesTable } from "@/components/panels/deadlines-table"
import { ViewportBody, ViewportHeader } from "@/components/panels/chrome"
import { TodayPlan } from "@/components/panels/today-plan"
import { daysAway } from "@/lib/format"
import { useChanges, useCourses, useDeadlines, useTasks } from "@/lib/data/hooks"

/**
 * Dashboard — relevance-ordered, not a widget grid (face.md M1 #3):
 * what's happening now, what needs a decision, then what's coming.
 */
export function DashboardView() {
  const courses = useCourses()
  const deadlines = useDeadlines()
  const tasks = useTasks()
  const changes = useChanges()

  const upcoming = React.useMemo(() => {
    if (!deadlines) return undefined
    return deadlines
      .filter((d) => {
        const n = daysAway(d.dueAt)
        return n >= 0 && n <= 14 && d.submissionStatus !== "graded"
      })
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  }, [deadlines])

  const pendingCount = changes?.filter((c) => c.status === "pending").length ?? 0

  return (
    <>
      <ViewportHeader
        title="Dashboard"
        meta={
          pendingCount > 0
            ? `${pendingCount} waiting on you`
            : "nothing waiting on you"
        }
      />
      <ViewportBody>
        <TodayPlan tasks={tasks} deadlines={deadlines} courses={courses} />
        <ChangeFeed changes={changes} courses={courses} />
        <DeadlinesTable
          title="Next two weeks"
          deadlines={upcoming}
          courses={courses}
          changes={changes}
          emptyLine="Nothing is due in the next two weeks."
          emptyDetail="That's real, not missing data — every connector reported in today. The Semester view has the rest of the term."
        />
      </ViewportBody>
    </>
  )
}
