"use client"

import * as React from "react"

import { DeadlinesTable } from "@/components/panels/deadlines-table"
import {
  EmptyState,
  LoadingRows,
  SectionHeader,
  ViewportBody,
  ViewportHeader,
} from "@/components/panels/chrome"
import { ProvenanceTrigger } from "@/components/panels/provenance"
import { daysAway, percent } from "@/lib/format"
import { useChanges, useCourse, useCourses, useDeadlines } from "@/lib/data/hooks"

/**
 * Course workspace — **shell only** in Milestone 1 (face.md M1 #5): grading
 * scheme, upcoming, materials, artifacts. The workspace agent and the
 * artifact-scoped chat arrive in Milestone 3, when there is something to talk
 * about; we deliberately don't ship a chat rail with nothing to chat about, so
 * `ChatRail` is an honest placeholder.
 */
export function CourseWorkspaceView({ courseId }: { courseId: string }) {
  const course = useCourse(courseId)
  const courses = useCourses()
  const deadlines = useDeadlines()
  const changes = useChanges()

  const upcoming = React.useMemo(() => {
    if (!deadlines) return undefined
    return deadlines
      .filter((d) => d.courseId === courseId && daysAway(d.dueAt) >= 0)
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
  }, [deadlines, courseId])

  if (course === undefined) {
    return (
      <>
        <ViewportHeader title="Course" />
        <ViewportBody>
          <LoadingRows rows={5} />
        </ViewportBody>
      </>
    )
  }

  if (course === null) {
    return (
      <>
        <ViewportHeader title="Course" />
        <ViewportBody>
          <EmptyState
            line="No course with that id."
            detail="Courses come from Canvas and your syllabi — if one is missing, its source is probably failing. Check Connectors."
          />
        </ViewportBody>
      </>
    )
  }

  const totalWeight = course.gradingScheme.reduce((s, c) => s + c.weight, 0)

  return (
    <>
      <ViewportHeader title={course.name} meta={course.code} />
      <ViewportBody>
        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Grading scheme"
            hint="as the syllabus states it — never a computed grade"
          />
          <div className="overflow-hidden rounded-card bg-surface shadow-card">
            {course.gradingScheme.map((category) => (
              <div
                key={category.name}
                className="flex min-h-11 items-center gap-3 border-b border-line px-3 last:border-0"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {category.name}
                </span>
                {category.dropRule && (
                  <span className="shrink-0 text-[11.5px] text-ink-3">
                    {category.dropRule}
                  </span>
                )}
                <span className="w-24 shrink-0">
                  <span
                    aria-hidden
                    className="block h-1 rounded-full bg-inset"
                  >
                    <span
                      className="block h-1 rounded-full"
                      style={{
                        width: percent(category.weight),
                        background: course.accent,
                      }}
                    />
                  </span>
                </span>
                <span className="w-10 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-ink">
                  {percent(category.weight)}
                </span>
              </div>
            ))}
            <div className="primitive-card-footer flex min-h-11 items-center gap-2 border-t border-line">
              <ProvenanceTrigger
                title={`${course.code} grading scheme`}
                provenance={course.provenance}
                facts={[
                  { label: "Categories", value: String(course.gradingScheme.length) },
                  { label: "Weights sum to", value: percent(totalWeight) },
                ]}
                className="text-[11.5px] text-ink-3 underline decoration-transparent underline-offset-2 transition-colors duration-100 hover:text-ink-2 hover:decoration-current"
              >
                where this came from
              </ProvenanceTrigger>
              {Math.abs(totalWeight - 1) > 0.001 && (
                <span className="ml-auto text-[11.5px] text-orange">
                  weights sum to {percent(totalWeight)}
                </span>
              )}
            </div>
          </div>
        </section>

        <DeadlinesTable
          title="Upcoming"
          deadlines={upcoming}
          courses={courses}
          changes={changes}
          emptyLine={`Nothing left on the calendar for ${course.code}.`}
          emptyDetail="Everything this course has published is behind you. New items appear here within half an hour of landing in Canvas."
        />

        <section className="flex flex-col gap-3">
          <SectionHeader title="Materials" hint="Milestone 3" />
          <EmptyState
            line="Canvas files and pages for this course are being captured, but not opened yet."
            detail="They're stored raw and cheap now so the workspace agent has something to hydrate from later — reading them is what makes a prepared task more than a reminder."
          />
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title="Artifacts" hint="Milestone 3" />
          <EmptyState
            line="No artifacts yet."
            detail="An artifact is always the fulfilment of a planned task — a primer before a quiz, a review outline for a pset — built from this course's own materials. It appears when the plan asks for one."
          />
        </section>
      </ViewportBody>
    </>
  )
}
