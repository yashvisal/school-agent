"use client"

import * as React from "react"
import { useTheme } from "next-themes"

/**
 * The harness's sun/moon segmented pill, ported to next-themes.
 *
 * Upstream owned the theme itself (localStorage `bui-theme` + a class on
 * `<html>`); here `ThemeProvider` (`attribute="class"`) owns it, so this is a
 * pure control. The one upstream trick we keep is the transition freeze: every
 * token flips at once, so we add `.theme-switching` to `<html>` for two frames
 * and the swap is one clean repaint instead of hundreds of colour fades.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  /* `false` on the server snapshot, `true` once hydrated — the theme is only
   * knowable on the client, so render the thumb after mount to avoid a
   * hydration mismatch. */
  const mounted = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )

  const dark = mounted ? resolvedTheme === "dark" : null

  function apply(next: boolean) {
    if (next === dark) return
    const root = document.documentElement
    root.classList.add("theme-switching")
    setTheme(next ? "dark" : "light")
    requestAnimationFrame(() =>
      requestAnimationFrame(() => root.classList.remove("theme-switching"))
    )
  }

  return (
    <div
      className="relative inline-grid h-8 shrink-0 grid-cols-2 items-center rounded-full bg-field p-0.5"
      role="group"
      aria-label="Colour theme"
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0.5 w-7 rounded-full bg-surface shadow-btn transition-transform duration-200"
        style={{
          transform: dark ? "translateX(28px)" : "translateX(0)",
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
          opacity: dark === null ? 0 : 1,
        }}
      />
      <button
        type="button"
        aria-label="Light mode"
        aria-pressed={dark === false}
        onClick={() => apply(false)}
        className={`relative z-10 flex size-7 items-center justify-center rounded-full transition-colors duration-150 ${
          dark ? "text-ink-3 hover:text-ink-2" : "text-ink"
        }`}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Dark mode"
        aria-pressed={dark === true}
        onClick={() => apply(true)}
        className={`relative z-10 flex size-7 items-center justify-center rounded-full transition-colors duration-150 ${
          dark ? "text-ink" : "text-ink-3 hover:text-ink-2"
        }`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      </button>
    </div>
  )
}
