"use client"

import {
  EmptyState,
  LoadingRows,
  SectionHeader,
  ViewportBody,
  ViewportHeader,
} from "@/components/panels/chrome"
import { useCourse, useSources } from "@/lib/data/hooks"

/**
 * The course Library — **per course only**; there is no global Library tab
 * (vision §8). Drive-like: this course's files (uploads, Canvas captures) and,
 * from Milestone 3, the agent's artifacts and lessons.
 *
 * **Placeholder.** Core stores no files yet — nothing on this page is a real
 * listing, and it says so rather than showing an empty table that looks
 * broken. The counts it *does* state are true (they come from `sources`).
 */
export function CourseLibraryView({ courseId }: { courseId: string }) {
  const course = useCourse(courseId)
  const sources = useSources()

  /* Count syllabi only from the syllabus source — courses are a different
   * entity and would state a number that isn't about files at all. */
  const syllabusCount = sources?.find((s) => s.kind === "syllabus")?.covers.length ?? 0

  if (course === null) {
    return (
      <>
        <ViewportHeader title="Library" />
        <ViewportBody>
          <EmptyState
            line="No course with that id."
            detail="Courses come from Canvas and your syllabi — if one is missing, its source is probably failing. Check Connectors."
          />
        </ViewportBody>
      </>
    )
  }

  return (
    <>
      <ViewportHeader
        title={course ? `${course.name} — Library` : "Library"}
        meta={course ? `${course.code} · Milestone 3` : "Milestone 3"}
      />
      <ViewportBody>
        <section className="flex flex-col gap-3">
          <SectionHeader title="Nothing filed here yet" />
          {sources === undefined ? (
            <LoadingRows rows={1} />
          ) : (
            <EmptyState
              line={
                syllabusCount === 1
                  ? "1 syllabus is already in the system — it became deadlines and a grading scheme, not a file."
                  : `${syllabusCount} syllabi are already in the system — they became deadlines and grading schemes, not files.`
              }
              detail="This course's Library fills up when the workspace agent starts building things: a primer before a quiz, a review outline for a pset, notes from a lesson. Canvas files for the course land here too. Until there's an artifact worth keeping, there's nothing to file."
            />
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="What will live here"
            hint="not a listing — Core stores no files yet"
          />
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              {
                label: "Prepared for you",
                detail:
                  "primers, review outlines and lessons the workspace agent builds for a planned task",
              },
              {
                label: "From Canvas",
                detail:
                  "slides, handouts and readings captured from this course's files and pages",
              },
              {
                label: "Yours",
                detail:
                  "anything you upload or text in — notes, photos of the board, a PDF a friend sent",
              },
              {
                label: "Notes",
                detail:
                  "what a lesson leaves behind when you finish it (Milestone 3)",
              },
            ].map((row) => (
              <div
                key={row.label}
                className="flex flex-col gap-1 rounded-card bg-surface px-3.5 py-3 shadow-card"
              >
                <span className="text-[13px] font-medium text-ink">
                  {row.label}
                </span>
                <span className="text-[12px] leading-relaxed text-ink-2">
                  {row.detail}
                </span>
              </div>
            ))}
          </div>
        </section>
      </ViewportBody>
    </>
  )
}
