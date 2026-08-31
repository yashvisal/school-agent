"use client"

import * as React from "react"

import { SegmentedControl } from "@/components/harness/atoms/SegmentedControl"
import { Switch } from "@/components/harness/atoms/Switch"
import { TextRow } from "@/components/harness/atoms/TextRow"
import { SectionHeader, ViewportBody, ViewportHeader } from "@/components/panels/chrome"
import { useViewer } from "@/lib/data/hooks"

/**
 * Settings — availability, phone, check-in preferences, account.
 *
 * The form is static until Core ships `students.updatePrefs`; the Account block
 * is live and is the Clerk ↔ Convex auth smoke test that used to live at `/`.
 */

const CHECK_INS = ["Fewer", "Normal", "More"] as const
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card bg-surface px-3.5 shadow-card">{children}</div>
  )
}

export function SettingsView() {
  const viewer = useViewer()
  const [checkIns, setCheckIns] = React.useState<(typeof CHECK_INS)[number]>("Normal")
  const [quietMornings, setQuietMornings] = React.useState(false)
  const [free, setFree] = React.useState<Record<string, boolean>>({
    Mon: true,
    Tue: true,
    Wed: true,
    Thu: false,
    Fri: true,
    Sat: false,
    Sun: true,
  })

  return (
    <>
      <ViewportHeader title="Settings" />
      <ViewportBody>
        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Availability"
            hint="evenings you're generally free to work"
          />
          <Card>
            <div className="flex min-h-11 items-center justify-between gap-4 py-2">
              <span className="text-sm text-ink-2">Weekday evenings</span>
              <span className="flex flex-wrap items-center gap-1">
                {DAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={free[day]}
                    // TODO(core): api.students.updatePrefs({ availability })
                    onClick={() => setFree((f) => ({ ...f, [day]: !f[day] }))}
                    className={`inline-flex h-7 w-9 items-center justify-center rounded-full text-[12px] font-medium transition-colors duration-100 ${
                      free[day]
                        ? "bg-ink text-canvas"
                        : "bg-inset text-ink-3 shadow-hairline hover:text-ink-2"
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </span>
            </div>
            <div className="h-px bg-line" />
            <TextRow
              label="Class blocks"
              value="12 hard blocks"
              meta="from your schedule upload"
            />
            <div className="h-px bg-line" />
            <p className="py-2.5 text-[12.5px] leading-relaxed text-ink-2">
              Class blocks are boundaries, not preferences — the planner will
              never put work on top of one. Availability is the softer layer, and
              it gets corrected by what actually happens.
            </p>
          </Card>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title="The thread" hint="how the daily text behaves" />
          <Card>
            <div className="flex min-h-11 items-center justify-between gap-4 py-2">
              <span className="text-sm text-ink-2">Phone</span>
              <input
                defaultValue="+1 (555) 018-2244"
                aria-label="Phone number"
                // TODO(core): api.students.updatePrefs({ phone })
                /* 16px on mobile: below that, Safari zooms the viewport on
                 * focus and never zooms back out. */
                className="h-8 w-48 rounded-control bg-field px-2.5 text-right text-[16px] text-ink shadow-hairline outline-none sm:text-[13px]"
              />
            </div>
            <div className="h-px bg-line" />
            <div className="flex min-h-11 items-center justify-between gap-4 py-2">
              <span className="text-sm text-ink-2">Check-ins</span>
              <SegmentedControl
                options={CHECK_INS}
                value={checkIns}
                onChange={setCheckIns}
              />
            </div>
            <div className="h-px bg-line" />
            <div className="flex min-h-11 items-center justify-between gap-4 py-2">
              <span className="flex flex-col">
                <span className="text-sm text-ink-2">Hold the morning plan</span>
                <span className="text-[12px] text-ink-3">
                  wait until you text first
                </span>
              </span>
              <Switch
                checked={quietMornings}
                onChange={setQuietMornings}
                label="Hold the morning plan"
              />
            </div>
          </Card>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title="Account" hint="Clerk identity, as Convex sees it" />
          <Card>
            <div className="py-3">
              <pre className="overflow-x-auto rounded-control bg-inset p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 shadow-hairline">
                {viewer === undefined
                  ? "loading…"
                  : viewer === null
                    ? "signed out (Convex sees no identity)"
                    : JSON.stringify(viewer, null, 2)}
              </pre>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
                This is the only live Convex query in the app today. Everything
                else on these pages reads fixtures through{" "}
                <code className="rounded-md bg-inset px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">
                  lib/data/hooks.ts
                </code>{" "}
                until Core ships the schema.
              </p>
            </div>
          </Card>
        </section>
      </ViewportBody>
    </>
  )
}
