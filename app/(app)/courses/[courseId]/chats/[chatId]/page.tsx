import { CourseChatView } from "@/components/panels/course-chat-view"

/** Next 16: `params` is a Promise and must be awaited. */
export default async function CourseChatPage({
  params,
}: {
  params: Promise<{ courseId: string; chatId: string }>
}) {
  const { courseId, chatId } = await params
  return <CourseChatView courseId={courseId} chatId={chatId} />
}
