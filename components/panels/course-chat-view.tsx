"use client"

import * as React from "react"
import Link from "next/link"
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
 *
 * **Semantics.** These are not ARIA tabs: each one is a link to a URL, and a
 * `role="tab"` would make its close button presentational to assistive tech
 * (descendants of a tab are). So it's a `nav` of links with `aria-current`,
 * each paired with a sibling close button — which is what they actually are.
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
      /** a tab never gets narrower than this, so the strip stays readable */
      tabMinWidth: [104, 56, 240] as [number, number, number],
      /** …nor wider: past this the title truncates */
      tabMaxWidth: [200, 96, 360] as [number, number, number],
      /** width of the fade over an overflowing edge */
      fadeWidth: [24, 0, 64] as [number, number, number],
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

  /* Closing a tab removes the button the keyboard was standing on. Without
   * this, focus falls back to `<body>` and the person is dumped out of the
   * strip — worst for an *inactive* tab, where nothing navigates to cover it.
   * Park the id to focus, then focus it once React has rendered the new set. */
  const tabLinks = React.useRef(new Map<string, HTMLAnchorElement | null>())
  const focusAfterClose = React.useRef<string | null>(null)

  React.useEffect(() => {
    const id = focusAfterClose.current
    if (id === null) return
    focusAfterClose.current = null
    tabLinks.current.get(id)?.focus()
  })

  function close(id: string) {
    const next = closeTab(id)
    if (id !== chatId) {
      /* no navigation happens, so the focus move is entirely ours to make */
      focusAfterClose.current = next
      return
    }
    /* closing the active tab focuses its neighbour; closing the last one puts
     * you back on Overview rather than on an empty pane, where the router
     * moves focus to that page's `<h1>` */
    if (next) focusAfterClose.current = next
    router.push(next ? `${base}/chats/${next}` : base)
  }

  /* Which edges of the strip have more tabs behind them. Measured from the
   * scroll handler and a ResizeObserver — never set synchronously in an
   * effect, which would cascade a render every time the strip repaints. */
  const scroller = React.useRef<HTMLElement | null>(null)
  const [edges, setEdges] = React.useState({ left: false, right: false })

  const measure = React.useCallback(() => {
    const el = scroller.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right }
    )
  }, [])

  React.useEffect(() => {
    const el = scroller.current
    if (!el) return
    /* observing fires once on `observe`, so this also does the first
     * measurement — no synchronous setState in the effect body */
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
  }, [measure, openIds.length])

  return (
    <>
      <div
        className="flex shrink-0 items-center border-b border-line px-2"
        style={{ height: dials.stripHeight }}
      >
        {/* `min-w-0` is what keeps the strip's overflow inside the strip:
         * without it the flex item grows to its content and the whole viewport
         * gets a horizontal scrollbar. */}
        <div className="relative flex min-w-0 flex-1 items-center">
          <nav
            ref={scroller}
            onScroll={measure}
            aria-label="Open chats"
            className="no-scrollbar flex min-w-0 flex-1 flex-nowrap items-center overflow-x-auto overflow-y-hidden"
            style={{ gap: dials.tabGap, height: dials.tabHeight }}
          >
            {openIds.map((id) => {
              const active = id === chatId
              const title = titleOf(id)
              return (
                <span
                  key={id}
                  className={`flex h-full shrink-0 items-center gap-1 rounded-[8px] pr-1 pl-2.5 transition-colors duration-100 ${
                    active ? "bg-hover-2" : "hover:bg-hover"
                  }`}
                  style={{
                    minWidth: dials.tabMinWidth,
                    maxWidth: dials.tabMaxWidth,
                  }}
                >
                  <Link
                    ref={(node) => {
                      tabLinks.current.set(id, node)
                    }}
                    href={`${base}/chats/${id}`}
                    aria-current={active ? "page" : undefined}
                    title={title}
                    className={`min-w-0 flex-1 truncate text-[12.5px] font-medium ${
                      active ? "text-ink" : "text-ink-2"
                    }`}
                  >
                    {title}
                  </Link>
                  <button
                    type="button"
                    aria-label={`Close ${title}`}
                    onClick={() => close(id)}
                    className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
                  >
                    <X size={12} />
                  </button>
                </span>
              )
            })}
          </nav>

          {/* the strip's own edges, so a cut-off tab reads as "there's more"
           * rather than as a rendering bug */}
          {edges.left && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0"
              style={{
                width: dials.fadeWidth,
                background:
                  "linear-gradient(to right, var(--page), transparent)",
              }}
            />
          )}
          {edges.right && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0"
              style={{
                width: dials.fadeWidth,
                background:
                  "linear-gradient(to left, var(--page), transparent)",
              }}
            />
          )}
        </div>

        {/* outside the scroll area, so it is reachable at any scroll position */}
        <button
          type="button"
          aria-label="New chat"
          title="New chat"
          onClick={() => router.push(`${base}/chats/${newChatId()}`)}
          className="ml-1 flex shrink-0 items-center justify-center rounded-[8px] px-2 text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink"
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
