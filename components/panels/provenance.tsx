"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import { agoLabel, percent } from "@/lib/format"
import type { Provenance } from "@/lib/data/types"

/**
 * Provenance on click for every fact (face.md "Design rules"): where it came
 * from, exactly which thing in the source said it, how confident the extractor
 * was, and when the snapshot was taken. Nothing derived is shown here — this
 * popover is the honesty surface for vision §9.
 */

const ORIGIN_LABEL: Record<Provenance["source"], string> = {
  canvas: "Canvas",
  ical: "Calendar feed",
  syllabus: "Syllabus",
  site: "Course site",
  chat: "The thread",
  manual: "You",
}

export function ProvenanceTrigger({
  provenance,
  facts,
  title,
  children,
  className = "",
}: {
  provenance: Provenance
  /** the raw stored fields, label → value, shown above the provenance */
  facts?: { label: string; value: string }[]
  title: string
  children: React.ReactNode
  className?: string
}) {
  const [box, setBox] = React.useState<{ x: number; y: number } | null>(null)
  const ref = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => {
    if (!box) return
    const close = (event: PointerEvent) => {
      const target = event.target as Element
      if (!target.closest("[data-provenance]") && !ref.current?.contains(target)) {
        setBox(null)
      }
    }
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBox(null)
    }
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", esc)
    return () => {
      document.removeEventListener("pointerdown", close)
      document.removeEventListener("keydown", esc)
    }
  }, [box])

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-expanded={box !== null}
        aria-label={`Facts and provenance for ${title}`}
        onClick={() => {
          if (box) return setBox(null)
          const rect = ref.current?.getBoundingClientRect()
          if (!rect) return
          setBox({
            x: Math.max(12, Math.min(rect.left, window.innerWidth - 312)),
            y: Math.min(rect.bottom + 6, window.innerHeight - 240),
          })
        }}
        className={className}
      >
        {children}
      </button>

      {box &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            data-provenance
            className="fixed z-50 w-75 overflow-y-auto rounded-window bg-surface shadow-overlay"
            style={{
              left: box.x,
              top: box.y,
              /* the 240px reserved above is a floor, not the real height —
               * scroll rather than clip when the content is taller. */
              maxHeight: `calc(100dvh - ${box.y}px - 12px)`,
              animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: "top left",
            }}
          >
            <div className="primitive-card-bar border-b border-line">
              <span className="text-[12.5px] font-medium text-ink">{title}</span>
            </div>

            {facts && facts.length > 0 && (
              <div className="flex flex-col gap-1 border-b border-line px-3 py-2.5">
                {facts.map((f) => (
                  <div key={f.label} className="flex items-baseline justify-between gap-3">
                    <span className="text-[12px] text-ink-3">{f.label}</span>
                    <span className="text-[12.5px] font-medium tabular-nums text-ink">
                      {f.value}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-1 px-3 py-2.5">
              <Row label="Source" value={ORIGIN_LABEL[provenance.source]} />
              <Row label="Reference" value={provenance.sourceRef} mono />
              <Row
                label="Confidence"
                value={
                  provenance.confidence >= 1
                    ? "stated, not inferred"
                    : percent(provenance.confidence)
                }
              />
              <Row label="Snapshot" value={provenance.snapshotId} mono />
              <Row label="Seen" value={agoLabel(provenance.observedAt)} />
            </div>
          </div>,
          document.body
        )}
    </>
  )
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-[12px] text-ink-3">{label}</span>
      <span
        className={`min-w-0 truncate text-right text-[12px] text-ink-2 ${
          mono ? "font-mono text-[11.5px]" : ""
        }`}
      >
        {value}
      </span>
    </div>
  )
}
