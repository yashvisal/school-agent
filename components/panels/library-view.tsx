"use client"

import {
  EmptyState,
  LoadingRows,
  SectionHeader,
  ViewportBody,
  ViewportHeader,
} from "@/components/panels/chrome"
import { useCourses, useSources } from "@/lib/data/hooks"

/**
 * Library — a stub until Milestone 3. It is the Drive-like home for agent
 * artifacts plus everything the student brings in, foldered by course
 * (face.md M3). Empty state states what is true, not what to do.
 */
export function LibraryView() {
  const courses = useCourses()
  const sources = useSources()

  /* Count syllabi only from the syllabus source — courses are a different
   * entity and would state a number that isn't about files at all. */
  const syllabusCount = sources?.find((s) => s.kind === "syllabus")?.covers.length ?? 0

  return (
    <>
      <ViewportHeader title="Library" meta="Milestone 3" />
      <ViewportBody>
        <section className="flex flex-col gap-3">
          <SectionHeader title="Nothing here yet" />
          {sources === undefined ? (
            <LoadingRows rows={1} />
          ) : (
            <EmptyState
              line={
                syllabusCount === 1
                  ? "1 syllabus is already in the system — it became deadlines and a grading scheme, not a file."
                  : `${syllabusCount} syllabi are already in the system — they became deadlines and grading schemes, not files.`
              }
              detail="The Library fills up when the workspace agent starts building things: a primer before a quiz, a review outline for a pset, notes from a lesson. Course materials the agent pulls from Canvas land here too. Until there's an artifact worth keeping, there's nothing to file."
            />
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title="Courses it will be foldered by" count={courses?.length} />
          <div className="grid gap-2 sm:grid-cols-2">
            {courses?.map((course) => (
              <div
                key={course._id}
                className="flex items-center gap-2.5 rounded-card bg-surface px-3 py-2.5 shadow-card"
              >
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-[10px] font-semibold text-white"
                  style={{ background: course.accent }}
                >
                  {course.code.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {course.name}
                </span>
                <span className="shrink-0 text-[11.5px] text-ink-3">0 items</span>
              </div>
            ))}
          </div>
        </section>
      </ViewportBody>
    </>
  )
}
