"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { UserButton } from "@clerk/nextjs"
import { useDialKit } from "dialkit"
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

const SIDEBAR_MOTION = {
  expandedWidth: 224,
  collapsedWidth: 52,
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
    <div className="sidebar-copy mx-2 flex h-6 shrink-0 items-center px-2">
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

  const dials = useDialKit(
    "Sidebar",
    {
      /** height of every nav / course / chat row */
      rowHeight: [32, 26, 44] as [number, number, number],
      /** gap between rows inside one group */
      rowGap: [1, 0, 10] as [number, number, number],
      /** breathing room around a group divider */
      sectionGap: [10, 2, 28] as [number, number, number],
    },
    /* Persist only in dev: DialKit hides its panel in production but still
     * reads its localStorage entry, so a tuned value would silently override
     * the shipped defaults. */
    { id: "sidebar", persist: process.env.NODE_ENV !== "production" }
  )

  return (
    <aside
      data-sidebar-collapsed={collapsed}
      aria-label="Workspace navigation"
      className={`relative flex h-full shrink-0 overflow-hidden transition-[width] ${className}`}
      style={
        {
          width: collapsed
            ? SIDEBAR_MOTION.collapsedWidth
            : SIDEBAR_MOTION.expandedWidth,
          transitionDuration: `${SIDEBAR_MOTION.duration}ms`,
          transitionTimingFunction: SIDEBAR_MOTION.easing,
          "--sidebar-copy-duration": `${SIDEBAR_MOTION.copyDuration}ms`,
          "--sidebar-copy-offset": `${SIDEBAR_MOTION.copyOffset}px`,
          "--sidebar-easing": SIDEBAR_MOTION.easing,
        } as React.CSSProperties
      }
    >
      <div className="flex min-h-0 w-[224px] shrink-0 flex-col">
        {/* header: the workspace, or — in course mode — the course and the way
         * back out. One row, one slot, two meanings. */}
        <div className="relative mb-2.5 h-10 shrink-0">
          {courseId ? (
            <CourseHeader courseId={courseId} />
          ) : (
            <div className="sidebar-workspace-control absolute top-1 left-2 flex h-8 w-[164px] items-center rounded-[8px] px-2">
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
            className="sidebar-collapse-control absolute top-1 right-2 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <PanelLeft size={18} />
          </button>
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-hidden={!collapsed}
            tabIndex={collapsed ? 0 : -1}
            onClick={() => setCollapsed(false)}
            className="sidebar-expand-control absolute top-0.5 left-2 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <PanelLeft size={18} className="rotate-180" />
          </button>
        </div>

        {courseId ? (
          <CourseNav courseId={courseId} dials={dials} />
        ) : (
          <GlobalNav dials={dials} />
        )}

        {/* footer: account + theme — the same in both modes */}
        <div className="mx-2 mt-3 flex h-9 w-[208px] shrink-0 items-center gap-2 border-t border-line pt-3">
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

type Dials = { rowHeight: number; rowGap: number; sectionGap: number }

/* ── global mode ────────────────────────────────────────────────────────── */

function GlobalNav({ dials }: { dials: Dials }) {
  const pathname = usePathname()
  const courses = useCourses()

  return (
    <>
      <GlideGroup gap={dials.rowGap}>
        {PRIMARY.map((item) => {
          const Icon = item.icon
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
          return (
            <RailLink
              key={item.href}
              href={item.href}
              label={item.label}
              active={active}
              height={dials.rowHeight}
              icon={<Icon size={18} />}
            />
          )
        })}
      </GlideGroup>

      <div
        className="sidebar-copy mx-2 h-px shrink-0 bg-line"
        style={{ marginBlock: dials.sectionGap }}
      />

      <SectionLabel label="COURSES" />

      {/* one entry per course — clicking one *enters* it (course mode) */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingTop: dials.rowGap }}
      >
        <GlideGroup gap={dials.rowGap}>
          {courses?.map((course) => (
            <RailLink
              key={course._id}
              href={`/courses/${course._id}`}
              label={course.code}
              monogram={course.code.slice(0, 1)}
              accent={course.accent}
              height={dials.rowHeight}
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
 * The back affordance is the **chevron only**: its hit area and hover state are
 * exactly the 20px slot the "s" glyph occupies in global mode. The course code
 * beside it is a plain label — a whole row that lights up on hover reads like a
 * course switcher, which is not what it does.
 */
function CourseHeader({ courseId }: { courseId: string }) {
  const courses = useCourses()
  const course = courses?.find((c) => c._id === courseId)

  return (
    <div className="sidebar-workspace-control absolute top-1 left-2 flex h-8 w-[164px] items-center rounded-[8px] px-2">
      <Link
        href="/"
        aria-label="All courses"
        title="All courses"
        className="sidebar-logo flex size-5 shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-150 hover:bg-hover-2 hover:text-ink"
      >
        <ChevronLeft size={18} />
      </Link>
      <span className="sidebar-copy ml-1.5 min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
        {course?.code ?? "Course"}
      </span>
    </div>
  )
}

function CourseNav({ courseId, dials }: { courseId: string; dials: Dials }) {
  const pathname = usePathname()
  const router = useRouter()
  const chats = useCourseChats(courseId)

  const base = `/courses/${courseId}`

  return (
    <>
      <GlideGroup gap={dials.rowGap}>
        <RailLink
          href={base}
          label="Overview"
          active={pathname === base}
          height={dials.rowHeight}
          icon={<SquareChartGantt size={18} />}
        />
        <RailLink
          href={`${base}/library`}
          label="Library"
          active={pathname.startsWith(`${base}/library`)}
          height={dials.rowHeight}
          icon={<FolderOpen size={18} />}
        />
      </GlideGroup>

      <div
        className="sidebar-copy mx-2 h-px shrink-0 bg-line"
        style={{ marginBlock: dials.sectionGap }}
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

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        style={{ paddingTop: dials.rowGap }}
      >
        <GlideGroup gap={dials.rowGap}>
          {chats?.map((chat) => (
            <ChatLink
              key={chat._id}
              href={`${base}/chats/${chat._id}`}
              title={chat.title}
              height={dials.rowHeight}
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
    </>
  )
}
