"use client"

import * as React from "react"
import { SignInButton, Show } from "@clerk/nextjs"
import { useDialKit } from "dialkit"

import { AppRail } from "@/components/shell/app-rail"
import { AppSidebar } from "@/components/shell/app-sidebar"
import { ThemeToggle } from "@/components/shell/theme-toggle"

/**
 * The shell, forked from the harness `IceCreamHarness` arrangement:
 * **nav sidebar | viewport | adaptive rail**, rounded panels floating on the
 * canvas, hairline borders, the same gutters and radii.
 *
 * Dropped from upstream: the tab bar and the chat-history sidebar list — both
 * are demo-chat concepts (vision §8: planning conversation lives in the thread).
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const dials = useDialKit(
    "Shell",
    {
      /** gutter between the canvas edge and the panels */
      gutter: [10, 0, 28] as [number, number, number],
      /** corner radius of the floating panels */
      panelRadius: [14, 0, 28] as [number, number, number],
      /** width of the adaptive rail */
      railWidth: [360, 260, 520] as [number, number, number],
    },
    /* Persist only in dev: DialKit hides its panel in production but still
     * reads `dialkit:shell` from localStorage, so a tuned value would silently
     * override the shipped shell defaults. */
    { id: "shell", persist: process.env.NODE_ENV !== "production" }
  )

  return (
    <>
      <Show when="signed-out">
        <SignedOutPrompt />
      </Show>
      <Show when="signed-in">
        <main
          className="flex h-[100dvh] bg-canvas text-ink lg:pl-0"
          style={{ padding: dials.gutter, gap: dials.gutter }}
        >
          <AppSidebar className="hidden lg:flex" />

          <div
            className="flex min-h-0 min-w-0 flex-1"
            style={{ gap: dials.gutter }}
          >
            <section
              className="flex min-w-0 flex-1 flex-col overflow-hidden border border-line bg-page"
              style={{ borderRadius: dials.panelRadius }}
            >
              {children}
            </section>

            <aside
              aria-label="Context"
              className="hidden shrink-0 flex-col overflow-hidden border border-line bg-page lg:flex"
              style={{
                width: dials.railWidth,
                borderRadius: dials.panelRadius,
              }}
            >
              <AppRail />
            </aside>
          </div>
        </main>
      </Show>
    </>
  )
}

function SignedOutPrompt() {
  return (
    <main className="flex h-[100dvh] items-center justify-center bg-canvas p-6 text-ink">
      <div className="w-full max-w-sm rounded-window bg-surface p-5 shadow-card">
        <div className="flex items-center gap-2">
          <span className="flex size-5 items-center justify-center rounded-[6px] bg-ink text-[10px] font-semibold text-surface">
            s
          </span>
          <span className="text-[13.5px] font-semibold text-ink">school-agent</span>
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-ink-2">
          Your plan, your deadlines and everything they came from are behind
          sign-in — nothing about a student is readable without it.
        </p>
        <div className="mt-4">
          <SignInButton>
            <button
              type="button"
              className="flex h-9 w-full items-center justify-center rounded-full bg-ink text-[13px] font-medium text-canvas transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98]"
            >
              Sign in
            </button>
          </SignInButton>
        </div>
      </div>
    </main>
  )
}
