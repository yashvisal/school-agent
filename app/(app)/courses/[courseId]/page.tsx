import { CourseWorkspaceView } from "@/components/panels/course-workspace-view"

/** Next 16: `params` is a Promise and must be awaited. */
export default async function CourseWorkspacePage({
  params,
}: {
  params: Promise<{ courseId: string }>
}) {
  const { courseId } = await params
  return <CourseWorkspaceView courseId={courseId} />
}
