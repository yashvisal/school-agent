"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useDialKit } from "dialkit"
import { Plus, X } from "lucide-react"

import { ChatTranscript } from "@/components/workspace/chat-transcript"
import { isNewChatId, newChatId, useChatTabs } from "@/lib/workspace/chat-tabs"
import { useCourse, useCourseChats } from "@/lib/data/hooks"

/**
 * A chat in the course viewport, under a strip of open chats — the harness's
 * native shape (sidebar of chats, chat as the main pane), with browser-style
 * tabs so a student can hold two threads about the same course at once.
 *
 * The strip is **UI state** (`lib/workspace/chat-tabs.ts`, sessionStorage per
 * course); which chats exist is data. Nothing here is truth (vision §10).
 */
export function CourseChatView({
  courseId,
  chatId,
}: {
  courseId: string
  chatId: string
}) {
  const router = useRouter()
  const course = useCourse(courseId)
  const chats = useCourseChats(courseId)
  const { ids: openTabIds, open, close: closeTab } = useChatTabs(courseId)

  const dials = useDialKit(
    "Chat tabs",
    {
      /** height of the tab strip — matches the viewport header elsewhere */
      stripHeight: [44, 32, 60] as [number, number, number],
      /** height of a single tab */
      tabHeight: [30, 24, 44] as [number, number, number],
      /** gap between tabs */
      tabGap: [2, 0, 10] as [number, number, number],
      /** how wide a tab's title may get before it truncates */
      tabMaxWidth: [200, 96, 360] as [number, number, number],
    },
    { id: "chat-tabs", persist: process.env.NODE_ENV !== "production" }
  )

  const base = `/courses/${courseId}`

  /* Opening a chat from the sidebar opens a tab; opening one that is already
   * open just focuses it, which `open` gets for free by being idempotent. */
  React.useEffect(() => {
    open(chatId)
  }, [open, chatId])

  const titleOf = React.useCallback(
    (id: string): string => {
      const found = chats?.find((c) => c._id === id)
      if (found) return found.title
      return isNewChatId(id) ? "New chat" : "Chat"
    },
    [chats]
  )

  /* The active chat is always shown, even before its tab has been restored
   * from sessionStorage — the URL is the truth about what you're looking at. */
  const openIds = openTabIds.includes(chatId)
    ? openTabIds
    : [...openTabIds, chatId]

  function close(id: string) {
    const next = closeTab(id)
    if (id !== chatId) return
    /* closing the active tab focuses its neighbour; closing the last one puts
     * you back on Overview rather than on an empty pane */
    router.push(next ? `${base}/chats/${next}` : base)
  }

  return (
    <>
      <div
        className="flex shrink-0 items-center overflow-x-auto border-b border-line px-2"
        style={{ height: dials.stripHeight, gap: dials.tabGap }}
        role="tablist"
        aria-label="Open chats"
      >
        {openIds.map((id) => {
          const active = id === chatId
          return (
            <div
              key={id}
              role="tab"
              aria-selected={active}
              className={`group flex shrink-0 items-center gap-1.5 rounded-[8px] pr-1 pl-2.5 transition-colors duration-100 ${
                active ? "bg-hover-2" : "hover:bg-hover"
              }`}
              style={{ height: dials.tabHeight }}
            >
              <button
                type="button"
                onClick={() => router.push(`${base}/chats/${id}`)}
                title={titleOf(id)}
                className={`min-w-0 truncate text-left text-[12.5px] font-medium ${
                  active ? "text-ink" : "text-ink-2"
                }`}
                style={{ maxWidth: dials.tabMaxWidth }}
              >
                {titleOf(id)}
              </button>
              <button
                type="button"
                aria-label={`Close ${titleOf(id)}`}
                onClick={() => close(id)}
                className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}

        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={() => router.push(`${base}/chats/${newChatId()}`)}
          className="flex shrink-0 items-center justify-center rounded-[8px] px-2 text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
          style={{ height: dials.tabHeight }}
        >
          <Plus size={14} />
        </button>
      </div>

      <ChatTranscript
        courseId={courseId}
        chatId={chatId}
        courseCode={course?.code}
      />
    </>
  )
}
