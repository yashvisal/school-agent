"use client"

import * as React from "react"

import { Button } from "@/components/harness/atoms/Button"
import { StatusPill } from "@/components/harness/atoms/StatusPill"
import {
  EmptyState,
  LoadingRows,
  SectionHeader,
  ViewportBody,
  ViewportHeader,
} from "@/components/panels/chrome"
import { agoLabel } from "@/lib/format"
import { useSources } from "@/lib/data/hooks"
import type { Source, SourceHealth } from "@/lib/data/types"

/**
 * Connectors — set-and-forget with health status (vision §8). The Canvas
 * personal-access-token path is ToS-grey on institutional instances and can
 * break silently, which is exactly why `sources.health` is surfaced here rather
 * than buried (core.md "Test data & limitations").
 */

const HEALTH: Record<
  SourceHealth,
  { tone: "green" | "orange" | "red" | "neutral"; label: string }
> = {
  healthy: { tone: "green", label: "Healthy" },
  degraded: { tone: "orange", label: "Needs attention" },
  failing: { tone: "red", label: "Failing" },
  never_synced: { tone: "neutral", label: "One-time upload" },
}

function SourceCard({ source }: { source: Source }) {
  const [resyncing, setResyncing] = React.useState(false)
  const health = HEALTH[source.health]

  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center gap-2.5 border-b border-line">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {source.label}
        </span>
        <StatusPill tone={health.tone}>{health.label}</StatusPill>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-2">
            {source.detail}
          </span>
          <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
            {source.lastPolledAt ? agoLabel(source.lastPolledAt) : "never polled"}
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          {source.covers.map((c) => (
            <span
              key={c}
              className="inline-flex h-5.5 items-center rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline"
            >
              {c}
            </span>
          ))}
        </div>

        {source.note && (
          <p className="text-[12.5px] leading-relaxed text-ink-2">{source.note}</p>
        )}
      </div>

      <div className="primitive-card-footer flex min-h-11 items-center justify-end border-t border-line">
        <Button
          size="xs"
          variant="secondary"
          disabled={resyncing}
          // TODO(core): api.sources.resync({ sourceId })
          onClick={() => setResyncing(true)}
        >
          {resyncing ? "Re-syncing…" : "Re-sync"}
        </Button>
      </div>
    </div>
  )
}

export function ConnectorsView() {
  const sources = useSources()
  const unhealthy = sources?.filter((s) => s.health !== "healthy").length ?? 0

  return (
    <>
      <ViewportHeader
        title="Connectors"
        meta={
          sources === undefined
            ? undefined
            : unhealthy === 0
              ? "all reporting"
              : `${unhealthy} need${unhealthy === 1 ? "s" : ""} a look`
        }
      />
      <ViewportBody>
        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Sources"
            count={sources?.length}
            hint="everything the plan is built from"
          />
          {sources === undefined ? (
            <LoadingRows rows={4} />
          ) : sources.length === 0 ? (
            <EmptyState
              line="No source is feeding the plan yet."
              detail="Without one there are no deadlines to plan against, so the morning text has nothing to say."
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {sources.map((source) => (
                <SourceCard key={source._id} source={source} />
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader title="Not connected yet" />
          <EmptyState
            line="Personal calendar and email-in are still on the roadmap."
            detail="A personal calendar turns availability from a static grid into reality (Milestone 2). Email-in is deferred — school mail is where deadlines actually change, but the OAuth is the hard part."
          />
        </section>
      </ViewportBody>
    </>
  )
}
