"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { UserButton } from "@clerk/nextjs"
import {
  CalendarDays,
  ChevronLeft,
  FolderOpen,
  LayoutDashboard,
  PanelLeft,
  Plug,
  Plus,
  Settings,
  SquareChartGantt,
} from "lucide-react"

import GlideMenu from "@/components/harness/primitives/GlideMenu"
import { ThemeToggle } from "@/components/shell/theme-toggle"
import { newChatId } from "@/lib/workspace/chat-tabs"
import { useCourseChats, useCourses } from "@/lib/data/hooks"

/**
 * The product sidebar — **the primary navigation primitive** (vision §8), in
 * two modes:
 *
 *  - **Global** (`/`, `/semester`, `/connectors`, `/settings`) — workspace
 *    header, Dashboard · Semester · Connectors · Settings, then the courses.
 *    No global Library: the Library is per-course.
 *  - **Course** (`/courses/[id]/…`) — the *same* chrome with course-scoped
 *    contents: the header row becomes the course identity and the way back out,
 *    then Overview · Library, then this course's chats.
 *
 * The mode is derived from `usePathname`, never held in state: a sidebar that
 * can disagree with the URL is a sidebar that will.
 *
 * Built from the harness `SidebarNav` arrangement: one persistent 224px tree
 * clipped by a 52px shell, a gliding hover highlight, and rail glyphs that stay
 * centred in both states (the `sidebar-*` CSS lives in `app/globals.css`).
 */

/* Row geometry, in px. Every row — header, nav, course, chat — and both
 * sidebar toggles read these, so a change here moves the whole column at
 * once and nothing can drift a pixel from its neighbours. */
const SIDEBAR_ROWS = {
  /** height of every row, header included */
  rowHeight: 32,
  /** gap between rows inside one group */
  rowGap: 1,
  /** breathing room around a group divider */
  sectionGap: 10,
  /** the 8px between the column edge and a row, and the 8px a row pads
   * inside itself — identical on both sides and in both states */
  inset: 8,
  /** the 20px icon slot at the head of every row */
  iconSlot: 20,
}

/* Collapsed, a row is just its padding and its icon slot, so the rail is
 * that plus the column inset on each side: 8 + 8 + 20 + 8 + 8 = 52. The icon
 * therefore sits at the same x in both states and never slides when the
 * labels go — collapsing only removes what is to the right of it. */
const SIDEBAR_COLLAPSED_ROW = SIDEBAR_ROWS.inset * 2 + SIDEBAR_ROWS.iconSlot
const SIDEBAR_COLLAPSED_WIDTH = SIDEBAR_COLLAPSED_ROW + SIDEBAR_ROWS.inset * 2

const SIDEBAR_EXPANDED_WIDTH = 224

/* The header is one row wide minus the collapse toggle beside it: the toggle
 * shares the row's height and right inset, and a 2px seam keeps the two
 * hover boxes readable as two controls. 224 - 8 - 28 - 2 - 8 = 178. */
const SIDEBAR_TOGGLE_WIDTH = 28
const SIDEBAR_HEADER_WIDTH =
  SIDEBAR_EXPANDED_WIDTH - SIDEBAR_ROWS.inset * 2 - SIDEBAR_TOGGLE_WIDTH - 2

const SIDEBAR_MOTION = {
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
}

const PRIMARY = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/semester", label: "Semester", icon: CalendarDays },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
] as const

function RailLink({
  href,
  label,
  active,
  icon,
  monogram,
  accent,
  height,
}: {
  href: string
  label: string
  active: boolean
  icon?: React.ReactNode
  monogram?: string
  accent?: string
  height: number
}) {
  return (
    <Link
      data-row
      href={href}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`sidebar-row relative z-10 mx-2 flex items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
        active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""
      }`}
      style={{ height }}
    >
      <span
        className={`flex size-5 shrink-0 items-center justify-center ${
          active ? "text-ink" : "text-ink-2"
        }`}
      >
        {monogram ? (
          <span
            className="flex size-4 items-center justify-center rounded-[5px] text-[9px] font-semibold text-white"
            style={{ background: accent }}
          >
            {monogram}
          </span>
        ) : (
          icon
        )}
      </span>
      <span
        className={`sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium ${
          active ? "text-ink" : "text-ink-2"
        }`}
      >
        {label}
      </span>
    </Link>
  )
}

/**
 * A chat row. Title only, one line — a date and a message count on every row
 * turn the list into a table, and the list is the *shortest* thing in the
 * sidebar precisely so opening a chat stays a glance, not a read.
 */
function ChatLink({
  href,
  title,
  active,
  height,
}: {
  href: string
  title: string
  active: boolean
  height: number
}) {
  return (
    <Link
      data-row
      href={href}
      title={title}
      aria-current={active ? "page" : undefined}
      className={`sidebar-row relative z-10 mx-2 flex items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
        active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""
      }`}
      style={{ height }}
    >
      <span
        className={`sidebar-copy min-w-0 flex-1 truncate text-[13px] ${
          active ? "font-medium text-ink" : "text-ink-2"
        }`}
      >
        {title}
      </span>
    </Link>
  )
}

function GlideGroup({
  children,
  gap,
}: {
  children: React.ReactNode
  gap: number
}) {
  return (
    <GlideMenu
      rowSelector="[data-row]"
      highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2"
      className="group/glide flex flex-col"
      style={{ gap }}
    >
      {children}
    </GlideMenu>
  )
}

/** The uppercase group label (`COURSES`, `CHATS`), with an optional action. */
function SectionLabel({
  label,
  action,
}: {
  label: string
  action?: React.ReactNode
}) {
  return (
    <div className="sidebar-collapse-hide sidebar-copy mx-2 flex h-6 shrink-0 items-center px-2">
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium tracking-[0.04em] text-ink-3">
        {label}
      </span>
      {action}
    </div>
  )
}

export function AppSidebar({ className = "" }: { className?: string }) {
  const [collapsed, setCollapsed] = React.useState(false)
  const pathname = usePathname()
  /* Course mode is a fact about the URL. Deriving it here (rather than holding
   * it) is what makes the swap immediate on navigation and impossible to
   * desync. */
  const courseId = /^\/courses\/([^/]+)/.exec(pathname)?.[1]

  return (
    <aside
      data-sidebar-collapsed={collapsed}
      aria-label="Workspace navigation"
      className={`relative flex h-full shrink-0 overflow-hidden transition-[width] ${className}`}
      style={
        {
          width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
          transitionDuration: `${SIDEBAR_MOTION.duration}ms`,
          transitionTimingFunction: SIDEBAR_MOTION.easing,
          "--sidebar-copy-duration": `${SIDEBAR_MOTION.copyDuration}ms`,
          "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
          "--sidebar-easing": SIDEBAR_MOTION.easing,
          /* what every row, rule and the footer shrink to when collapsed */
          "--sidebar-collapsed-row": `${SIDEBAR_COLLAPSED_ROW}px`,
        } as React.CSSProperties
      }
    >
      <div
        className="flex min-h-0 shrink-0 flex-col pb-2.5"
        style={{ width: SIDEBAR_EXPANDED_WIDTH }}
      >
        {/* header: the workspace, or — in course mode — the course and the way
         * back out. One row, one slot, two meanings. */}
        <div
          className="relative mb-2.5 shrink-0"
          style={{ height: SIDEBAR_ROWS.rowHeight + 8 }}
        >
          {courseId ? (
            <CourseHeader courseId={courseId} height={SIDEBAR_ROWS.rowHeight} />
          ) : (
            <div
              className="sidebar-workspace-control absolute top-1 left-2 flex items-center rounded-[8px] px-2"
              style={{
                width: SIDEBAR_HEADER_WIDTH,
                height: SIDEBAR_ROWS.rowHeight,
              }}
            >
              <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center">
                <span className="flex size-5 items-center justify-center rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
                  s
                </span>
              </span>
              <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                school-agent
              </span>
            </div>
          )}

          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={() => setCollapsed(true)}
            /* The same height as the header row beside it and the nav rows
             * beneath, so the two hover boxes read as one bar with a seam. */
            style={{
              width: SIDEBAR_TOGGLE_WIDTH,
              height: SIDEBAR_ROWS.rowHeight,
            }}
            className="sidebar-collapse-control absolute top-1 right-2 flex items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <PanelLeft size={18} />
          </button>
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-hidden={!collapsed}
            tabIndex={collapsed ? 0 : -1}
            onClick={() => setCollapsed(false)}
            /* Collapsed, this reads as the first row of the icon column: the
             * same box the nav rows collapse to, same inset, same 18px glyph —
             * so it lines up with Overview/Library beneath it. */
            style={{
              left: SIDEBAR_ROWS.inset,
              width: SIDEBAR_COLLAPSED_ROW,
              height: SIDEBAR_ROWS.rowHeight,
            }}
            className="sidebar-expand-control absolute top-1 flex items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <PanelLeft size={18} className="rotate-180" />
          </button>
        </div>

        {courseId ? <CourseNav courseId={courseId} /> : <GlobalNav />}

        {/* footer: account + theme — the same in both modes.
         * No fixed height: `h-9` left a 23px content box for a 28px avatar,
         * which overflowed the column and was sliced by the aside's clip. */}
        <div className="sidebar-footer mx-2 mt-3 flex shrink-0 items-center gap-2 border-t border-line px-1 pt-3">
          <span className="flex size-7 shrink-0 items-center justify-center">
            <UserButton />
          </span>
          <span className="sidebar-copy ml-auto flex items-center">
            <ThemeToggle />
          </span>
        </div>
      </div>
    </aside>
  )
}

/* ── global mode ────────────────────────────────────────────────────────── */

function GlobalNav() {
  const pathname = usePathname()
  const courses = useCourses()

  return (
    <>
      <GlideGroup gap={SIDEBAR_ROWS.rowGap}>
        {PRIMARY.map((item) => {
          const Icon = item.icon
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href)
          return (
            <RailLink
              key={item.href}
              href={item.href}
              label={item.label}
              active={active}
              height={SIDEBAR_ROWS.rowHeight}
              icon={<Icon size={18} />}
            />
          )
        })}
      </GlideGroup>

      <div
        className="sidebar-rule mx-2 h-px shrink-0 bg-line"
        style={{ marginBlock: SIDEBAR_ROWS.sectionGap }}
      />

      <SectionLabel label="COURSES" />

      {/* one entry per course — clicking one *enters* it (course mode) */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingTop: SIDEBAR_ROWS.rowGap }}
      >
        <GlideGroup gap={SIDEBAR_ROWS.rowGap}>
          {courses?.map((course) => (
            <RailLink
              key={course._id}
              href={`/courses/${course._id}`}
              label={course.code}
              monogram={course.code.slice(0, 1)}
              accent={course.accent}
              height={SIDEBAR_ROWS.rowHeight}
              active={pathname.startsWith(`/courses/${course._id}`)}
            />
          ))}
        </GlideGroup>
        {courses === undefined && (
          <div className="sidebar-copy mx-4 flex flex-col gap-1.5 py-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="h-4 rounded-[5px] bg-hover-2" />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ── course mode ────────────────────────────────────────────────────────── */

/**
 * The course identity row. Geometry is byte-for-byte the global workspace row —
 * same absolute box, same 20px icon slot, same label offset — so global ↔
 * course swaps *in place* and only the meaning of the two slots changes.
 *
 * The whole row is the back link and hovers like every other sidebar row
 * (Overview, Library, the course list): it *is* a nav row — "back to all
 * courses". A chevron-only halo was tried and can't work: a hover box needs
 * ~5px of air, the glyph lives in a 20px slot, and the label starts 6px to
 * its right, so the halo either hugs the icon or crowds the text.
 */
function CourseHeader({
  courseId,
  height,
}: {
  courseId: string
  height: number
}) {
  const courses = useCourses()
  const course = courses?.find((c) => c._id === courseId)

  return (
    <Link
      href="/"
      title="All courses"
      className="sidebar-workspace-control absolute top-1 left-2 flex items-center rounded-[8px] px-2 transition-[background-color] duration-150 hover:bg-hover-2"
      style={{ width: SIDEBAR_HEADER_WIDTH, height }}
    >
      <span className="sidebar-logo flex size-5 shrink-0 items-center justify-center text-ink-2">
        <ChevronLeft size={18} />
      </span>
      <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
        {course?.code ?? "Course"}
      </span>
    </Link>
  )
}

function CourseNav({ courseId }: { courseId: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const chats = useCourseChats(courseId)

  const base = `/courses/${courseId}`

  return (
    <>
      <GlideGroup gap={SIDEBAR_ROWS.rowGap}>
        <RailLink
          href={base}
          label="Overview"
          active={pathname === base}
          height={SIDEBAR_ROWS.rowHeight}
          icon={<SquareChartGantt size={18} />}
        />
        <RailLink
          href={`${base}/library`}
          label="Library"
          active={pathname.startsWith(`${base}/library`)}
          height={SIDEBAR_ROWS.rowHeight}
          icon={<FolderOpen size={18} />}
        />
      </GlideGroup>

      <div
        className="sidebar-rule mx-2 h-px shrink-0 bg-line"
        style={{ marginBlock: SIDEBAR_ROWS.sectionGap }}
      />

      <SectionLabel
        label="CHATS"
        action={
          <button
            type="button"
            aria-label="New chat"
            title="New chat"
            onClick={() => router.push(`${base}/chats/${newChatId()}`)}
            className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <Plus size={14} />
          </button>
        }
      />

      {/* the scroller stays (it is the flex-1 that holds the footer down);
       * only its contents go, since a chat row is a title and no glyph */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingTop: SIDEBAR_ROWS.rowGap }}
      >
        <div className="sidebar-collapse-hide">
          <GlideGroup gap={SIDEBAR_ROWS.rowGap}>
            {chats?.map((chat) => (
              <ChatLink
                key={chat._id}
                href={`${base}/chats/${chat._id}`}
                title={chat.title}
                height={SIDEBAR_ROWS.rowHeight}
                active={pathname === `${base}/chats/${chat._id}`}
              />
            ))}
          </GlideGroup>
          {chats?.length === 0 && (
            <p className="sidebar-copy mx-2 px-2 py-1 text-[12px] leading-relaxed text-ink-3">
              No chats in this course yet.
            </p>
          )}
        </div>
      </div>
    </>
  )
}
