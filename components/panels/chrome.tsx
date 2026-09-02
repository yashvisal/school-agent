"use client"

import * as React from "react"

/**
 * Shared viewport chrome, in the harness's grammar: an 11px-tall hairline
 * header bar, a scrolling body, section headers at 12.5px, and cards that are
 * `rounded-card bg-surface shadow-card`.
 */

export function ViewportHeader({
  title,
  meta,
  actions,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
      {/* the page's heading, and the thing focus lands on after a route change
       * (`tabIndex={-1}` makes it programmatically focusable without putting
       * it in the tab order) */}
      <h1
        tabIndex={-1}
        className="text-[13.5px] font-semibold text-ink outline-none"
      >
        {title}
      </h1>
      {meta && <span className="text-[12.5px] text-ink-3">{meta}</span>}
      {actions && (
        <span className="ml-auto flex items-center gap-1.5">{actions}</span>
      )}
    </div>
  )
}

export function ViewportBody({
  children,
  className = "",
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`min-h-0 flex-1 overflow-y-auto ${className}`}>
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-8 px-5 py-6 sm:px-6">
        {children}
      </div>
    </div>
  )
}

export function SectionHeader({
  title,
  count,
  hint,
  actions,
}: {
  title: string
  count?: React.ReactNode
  hint?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <span className="text-[13px] font-semibold text-ink">{title}</span>
      {count !== undefined && (
        <span className="inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11.5px] font-medium text-ink-2 tabular-nums shadow-hairline">
          {count}
        </span>
      )}
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
      {actions && (
        <span className="ml-auto flex items-center gap-1.5">{actions}</span>
      )}
    </div>
  )
}

/**
 * Empty states carry insight, not instructions (face.md "Design rules").
 * `line` states what is true right now; `detail` says what that means.
 */
export function EmptyState({
  line,
  detail,
}: {
  line: string
  detail?: string
}) {
  return (
    <div className="rounded-card bg-surface px-3.5 py-3 shadow-card">
      <p className="text-[13px] text-ink">{line}</p>
      {detail && (
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          {detail}
        </p>
      )}
    </div>
  )
}

/** Quiet placeholder rows while a subscription is still `undefined`. */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-11 rounded-card bg-surface shadow-card"
          /* dim with `filter`, not `opacity`: `fade-in` animates opacity to 1
           * and `both` keeps that final keyframe, which would win here. */
          style={{
            animation: `fade-in 400ms ease-out ${i * 60}ms both`,
            filter: "opacity(0.6)",
          }}
        />
      ))}
    </div>
  )
}

/** A tool chip: the Core action a row came from ("polled Canvas"). */
export function ToolChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-5.5 shrink-0 items-center rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline">
      {children}
    </span>
  )
}
