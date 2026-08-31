"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { UserButton } from "@clerk/nextjs"
import {
  BookOpen,
  CalendarDays,
  LayoutDashboard,
  PanelLeft,
  Plug,
  Settings,
} from "lucide-react"

import GlideMenu from "@/components/harness/primitives/GlideMenu"
import { ThemeToggle } from "@/components/shell/theme-toggle"
import { useCourses } from "@/lib/data/hooks"

/**
 * The product sidebar, built from the harness `SidebarNav` arrangement: one
 * persistent 224px tree clipped by a 52px shell, a gliding hover highlight, and
 * rail glyphs that stay centred in both states (the `sidebar-*` CSS lives in
 * `app/globals.css`).
 *
 * Dropped from upstream: the recents / chat-history list and the workspace
 * switcher menu — both are demo-chat concepts. Planning conversation happens in
 * the thread (vision §8 scope rule), so there is no chat history to list here.
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
  { href: "/library", label: "Library", icon: BookOpen },
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
}: {
  href: string
  label: string
  active: boolean
  icon?: React.ReactNode
  monogram?: string
  accent?: string
}) {
  return (
    <Link
      data-row
      href={href}
      title={label}
      aria-current={active ? "page" : undefined}
      className={`sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] ${
        active ? "bg-hover-2 group-hover/glide:bg-transparent" : ""
      }`}
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

function GlideGroup({ children }: { children: React.ReactNode }) {
  return (
    <GlideMenu
      rowSelector="[data-row]"
      highlightClassName="sidebar-glide-highlight rounded-[7px] bg-hover-2"
      className="group/glide flex flex-col gap-px"
    >
      {children}
    </GlideMenu>
  )
}

export function AppSidebar({ className = "" }: { className?: string }) {
  const [collapsed, setCollapsed] = React.useState(false)
  const pathname = usePathname()
  const courses = useCourses()

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
        {/* workspace monogram + product name */}
        <div className="relative mb-2.5 h-10 shrink-0">
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

        <GlideGroup>
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
                icon={<Icon size={18} />}
              />
            )
          })}
        </GlideGroup>

        <div className="sidebar-copy mx-2 my-2.5 h-px shrink-0 bg-line" />

        {/* one entry per course */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GlideGroup>
            {courses?.map((course) => (
              <RailLink
                key={course._id}
                href={`/courses/${course._id}`}
                label={course.code}
                monogram={course.code.slice(0, 1)}
                accent={course.accent}
                active={pathname === `/courses/${course._id}`}
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

        {/* footer: account + theme */}
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
