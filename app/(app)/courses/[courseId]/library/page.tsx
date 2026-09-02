import { CourseLibraryView } from "@/components/panels/library-view"

/** Next 16: `params` is a Promise and must be awaited. */
export default async function CourseLibraryPage({
  params,
}: {
  params: Promise<{ courseId: string }>
}) {
  const { courseId } = await params
  return <CourseLibraryView courseId={courseId} />
}
