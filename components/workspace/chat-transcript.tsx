"use client"

import * as React from "react"
import { useDialKit } from "dialkit"
import { useEveAgent } from "eve/react"
import type { EveMessage } from "eve/react"

import { Button } from "@/components/harness/atoms/Button"
import { EmptyState, ToolChip } from "@/components/panels/chrome"
import { REPLAY_FRAMES } from "@/lib/eve/fixtures"
import {
  APPROVE_OPTION_ID,
  REJECT_OPTION_ID,
  changeSummary,
  openApprovals,
  reduceRail,
  type DiffRow,
  type RailItem,
} from "@/lib/eve/reduce"

/**
 * The course chat transcript — Spike B #2, now in the **viewport** rather than
 * the rail (vision §8 "Course mode": opening a chat puts the conversation in
 * the main pane; the rail carries Context and Tasks).
 *
 * The stream comes from `useEveAgent({ agent: "workspace" })` (eve's NDJSON
 * events, *not* the AI SDK `useChat` protocol), and `lib/eve/reduce.ts` maps
 * `EveMessage` parts onto the harness grammar: `reasoning` → a thinking row,
 * `text` → prose, `dynamic-tool` → tool chips, and a gated `propose_change` →
 * an approval card with a diff table wired to `respond()`.
 *
 * The live path is the default and has run end-to-end in `next dev` against
 * `anthropic/claude-haiku-4.5`. Production browser traffic still 401s until the
 * Clerk verifier lands in `agent/workspace/channels/eve.ts` (TODO(face) there).
 *
 * **Replay mode.** In dev, `?replay=1` walks `lib/eve/fixtures.ts` through the
 * *same* reducer and the *same* renderers, so the card and the diff are
 * demoable with the gateway down and cost nothing to look at.
 */

/* ────────────────────────────────────────────────────────────
 * Rows — the harness grammar, product content
 * ──────────────────────────────────────────────────────────── */

function UserRow({ text, failed }: { text: string; failed: boolean }) {
  return (
    <div className="flex justify-end">
      <p
        className={`max-w-[85%] rounded-card px-3.5 py-2.5 text-[13px] leading-relaxed ${
          failed ? "bg-red-tint text-red" : "bg-inset text-ink"
        }`}
      >
        {text}
        {failed && <span className="block text-[11.5px]">didn&apos;t send</span>}
      </p>
    </div>
  )
}

function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="flex items-start gap-2 px-0.5">
      <span
        aria-hidden
        className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-ink-3 ${
          streaming ? "motion-safe:animate-pulse" : ""
        }`}
      />
      <p className="text-[12px] leading-relaxed text-ink-3">{text}</p>
    </div>
  )
}

function TextRow({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <p className="px-0.5 text-[13.5px] leading-[21px] text-ink">
      {text}
      {streaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-ink-2 motion-safe:animate-pulse"
        />
      )}
    </p>
  )
}

function ToolRow({ label, preparing }: { label: string; preparing: boolean }) {
  return (
    <div className="flex items-center gap-2 px-0.5">
      <ToolChip>{label}</ToolChip>
      {preparing && (
        <span aria-hidden className="size-1.5 rounded-full bg-ink-3 motion-safe:animate-pulse" />
      )}
    </div>
  )
}

function ResultRow({
  label,
  detail,
  tone,
  density,
}: {
  label: string
  detail?: string
  tone: "ok" | "error" | "denied"
  density: number
}) {
  return (
    <div
      className="flex items-center gap-2 px-0.5"
      style={{ minHeight: density }}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${
          tone === "error" ? "bg-red" : tone === "denied" ? "bg-orange" : "bg-green"
        }`}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">{label}</span>
      {detail && (
        <span className="min-w-0 shrink truncate text-[11.5px] text-ink-3">{detail}</span>
      )}
    </div>
  )
}

/** The diff table, in the change feed's grammar (components/panels/change-feed). */
function DiffLine({ row }: { row: DiffRow }) {
  return (
    <div className="flex items-baseline gap-2 text-[12px]">
      <span className="w-12 shrink-0 truncate text-ink-3">{row.field}</span>
      {row.before !== null && (
        <span className="rounded-[4px] bg-red-tint px-1 text-red line-through">
          {row.before}
        </span>
      )}
      {row.after !== null && (
        <span className="rounded-[4px] bg-green-tint px-1 text-green">{row.after}</span>
      )}
    </div>
  )
}

function ApprovalRow({
  item,
  busy,
  onRespond,
}: {
  item: Extract<RailItem, { kind: "approval" }>
  busy: boolean
  onRespond: (requestId: string, optionId: string) => void
}) {
  /* Never let one option fill both roles: with a single non-canonical option
   * the old fallbacks resolved to the same id, so pressing "Reject" approved
   * the change. Fall back only when there really are two options. */
  const approve =
    item.options.find((o) => o.id === APPROVE_OPTION_ID) ??
    (item.options.length > 1 ? item.options.at(-1) : undefined)
  const reject =
    item.options.find((o) => o.id === REJECT_OPTION_ID) ??
    (item.options.length > 1 ? item.options.at(0) : undefined)
  /* One unlabelled option: render it alone, with the server's own label. */
  const single =
    approve === undefined && reject === undefined ? item.options.at(0) : undefined

  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center gap-2 border-b border-line">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          {changeSummary(item.change, item.prompt)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 px-3 py-2.5">
        {item.rows.map((row) => (
          <DiffLine key={row.field} row={row} />
        ))}
        <p className="text-[11.5px] leading-relaxed text-ink-2">
          {item.change ? item.change.reason : item.prompt}
        </p>
      </div>

      <div className="primitive-card-footer flex min-h-11 items-center gap-2 border-t border-line">
        <ToolChip>proposed change</ToolChip>
        <span className="ml-auto flex items-center gap-1.5">
          {reject && (
            <Button
              size="xs"
              variant="quiet"
              disabled={busy}
              onClick={() => onRespond(item.requestId, reject.id)}
            >
              {reject.label}
            </Button>
          )}
          {approve && (
            <Button
              size="xs"
              variant="primary"
              disabled={busy}
              onClick={() => onRespond(item.requestId, approve.id)}
            >
              {approve.label}
            </Button>
          )}
          {single && (
            <Button
              size="xs"
              variant="primary"
              disabled={busy}
              onClick={() => onRespond(item.requestId, single.id)}
            >
              {single.label}
            </Button>
          )}
        </span>
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────────────────────
 * Replay mode (dev only)
 * ──────────────────────────────────────────────────────────── */

/**
 * `prefers-reduced-motion`, read once for the rail. The reveal is an inline
 * `animation`, so Tailwind's `motion-safe:` variant can't reach it.
 */
const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

function subscribeToMotionPreference(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCE_MOTION_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

function useReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeToMotionPreference,
    () => window.matchMedia(REDUCE_MOTION_QUERY).matches,
    () => false
  )
}

function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange)
  return () => window.removeEventListener("popstate", onChange)
}

function replayRequested(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    new URLSearchParams(window.location.search).get("replay") === "1"
  )
}

/**
 * `?replay=1` is read from `location` rather than `useSearchParams` so this
 * component stays usable from any route without a Suspense boundary, and
 * through `useSyncExternalStore` so the server snapshot is always "off".
 */
function useReplayFrames(): readonly EveMessage[] | null {
  const on = React.useSyncExternalStore(
    subscribeToLocation,
    replayRequested,
    () => false
  )
  const [frame, setFrame] = React.useState(0)

  React.useEffect(() => {
    if (!on || frame >= REPLAY_FRAMES.length - 1) return
    const id = setTimeout(() => setFrame((f) => f + 1), 900)
    return () => clearTimeout(id)
  }, [on, frame])

  if (!on) return null
  return REPLAY_FRAMES[frame].messages
}

/* ────────────────────────────────────────────────────────────
 * The rail
 * ──────────────────────────────────────────────────────────── */

/**
 * One durable eve session per student × course × chat (face.md "Workspace
 * filesystem = materialized view"). The shell outlives navigation, so remount
 * on `courseId`/`chatId`: switching course *or* chat must never continue the
 * previous transcript.
 *
 * TODO(core): the durable form — server-side hydration handing this component
 * an `initialSession` (`sessionId` + `streamIndex`) with `resume: true`, keyed
 * by a real `chats` row — arrives with `hydrateWorkspace` in M3. Until then a
 * chat id selects a *fresh* eve session, so reopening a chat shows an empty
 * transcript: the sidebar list is real, the history behind it is not yet.
 */
export function ChatTranscript({
  courseId,
  chatId,
  courseCode,
}: {
  courseId: string
  chatId: string
  courseCode?: string
}) {
  return (
    <CourseChatTranscript
      key={`${courseId}:${chatId}`}
      courseId={courseId}
      chatId={chatId}
      courseCode={courseCode}
    />
  )
}

function CourseChatTranscript({
  courseId,
  chatId,
  courseCode,
}: {
  courseId: string
  chatId: string
  courseCode?: string
}) {
  const dials = useDialKit(
    "Chat",
    {
      /** how long a new rail item takes to settle in */
      revealMs: [220, 80, 600] as [number, number, number],
      /** delay between consecutive items in the same paint */
      staggerMs: [28, 0, 120] as [number, number, number],
      /** minimum height of a collapsed result row */
      rowHeight: [28, 20, 48] as [number, number, number],
      /** vertical gap between transcript items */
      gap: [16, 4, 36] as [number, number, number],
      /** width the transcript is held to, so lines stay readable */
      maxWidth: [820, 560, 1100] as [number, number, number],
      /** padding around the transcript and the composer */
      pad: [24, 8, 48] as [number, number, number],
    },
    /* `id`/`persist` are options, not dials — and persistence is dev-only so a
     * tuned value can never override the shipped defaults in production. */
    { id: "chat-view", persist: process.env.NODE_ENV !== "production" }
  )

  const agent = useEveAgent({ agent: "workspace" })
  const replayMessages = useReplayFrames()
  const replaying = replayMessages !== null

  const messages = replayMessages ?? agent.data.messages
  const items = React.useMemo(() => reduceRail(messages), [messages])
  const pending = React.useMemo(() => openApprovals(items), [items])

  const [draft, setDraft] = React.useState("")
  const [failure, setFailure] = React.useState<string | null>(null)
  const [responding, setResponding] = React.useState(false)
  const reduceMotion = useReducedMotion()
  const scroller = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [items])

  const busy = agent.status === "submitted" || agent.status === "streaming"
  const disabled = replaying || agent.status === "resuming"

  const send = React.useCallback(async () => {
    const text = draft.trim()
    if (text.length === 0 || disabled) return
    setDraft("")
    setFailure(null)
    try {
      /* steer rather than queue: a second question mid-turn replaces the
       * first, which is what a rail beside a document should do. */
      await agent.send(text, busy ? { turnPolicy: "steer" } : undefined)
    } catch (error) {
      /* give the question back — retyping it is the worst possible tax on a
       * failure the student didn't cause. */
      setDraft((current) => (current.length === 0 ? text : current))
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [agent, busy, disabled, draft])

  const respond = React.useCallback(
    async (requestId: string, optionId: string) => {
      if (replaying) return
      setFailure(null)
      setResponding(true)
      try {
        await agent.respond([{ requestId, optionId }])
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error))
      } finally {
        setResponding(false)
      }
    },
    [agent, replaying]
  )

  /* Honest failure: the gateway is blocked today, and a spinner would lie. */
  const errorText = failure ?? (agent.status === "error" ? agent.error?.message : undefined)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div
        className="mx-auto flex w-full flex-col"
        style={{
          gap: dials.gap,
          maxWidth: dials.maxWidth,
          padding: dials.pad,
        }}
      >
        {items.length === 0 && !errorText ? (
          <EmptyState
            line="Nothing said in this chat yet."
            detail="This is workspace chat, not planning chat — “explain problem 3”, “what does the syllabus say about late work”. What to do and when stays in the thread."
          />
        ) : (
          items.map((item, index) => (
            <div
              key={item.id}
              style={{
                animation: reduceMotion
                  ? undefined
                  : `fade-up ${dials.revealMs}ms cubic-bezier(0.23,1,0.32,1) ${
                      index * dials.staggerMs
                    }ms both`,
              }}
            >
              {item.kind === "user" && <UserRow text={item.text} failed={item.failed} />}
              {item.kind === "thinking" && (
                <ThinkingRow text={item.text} streaming={item.streaming} />
              )}
              {item.kind === "text" && (
                <TextRow text={item.text} streaming={item.streaming} />
              )}
              {item.kind === "tool" && (
                <ToolRow label={item.label} preparing={item.preparing} />
              )}
              {item.kind === "result" && (
                <ResultRow
                  label={item.label}
                  detail={item.detail}
                  tone={item.tone}
                  density={dials.rowHeight}
                />
              )}
              {item.kind === "approval" && (
                /* `responding`, not `busy`: an approval stays open across
                 * turns (agent/workspace/README.md), so an unrelated stream
                 * must not lock the person out of answering it. */
                <ApprovalRow item={item} busy={responding} onRespond={respond} />
              )}
            </div>
          ))
        )}

        {errorText && (
          <div className="rounded-card bg-red-tint px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-red">The turn didn&apos;t run.</p>
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-red">
              {errorText}
            </p>
          </div>
        )}
        </div>
      </div>

      {/* composer — PromptBar grammar, one input, no model picker */}
      <div
        className="shrink-0 border-t border-line"
        style={{ padding: dials.pad, paddingBlock: dials.pad * 0.6 }}
      >
        <div className="mx-auto w-full" style={{ maxWidth: dials.maxWidth }}>
        {replaying && (
          <p className="mb-2 text-[11.5px] text-ink-3">
            Replaying a recorded eve stream — no model is running.
          </p>
        )}
        {pending.length > 0 && !replaying && (
          <p className="mb-2 text-[11.5px] text-orange">
            {pending.length === 1
              ? "A change is waiting on you above."
              : `${pending.length} changes are waiting on you above.`}
          </p>
        )}
        <div className="flex items-end gap-2.5 rounded-card bg-surface px-3.5 py-2.5 shadow-card">
          <textarea
            rows={1}
            value={draft}
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder={
              disabled ? "Reconnecting…" : "Ask about this course's materials…"
            }
            aria-label="Message the workspace agent"
            className="max-h-32 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-[18px] text-ink outline-none placeholder:text-ink-3 disabled:opacity-60"
          />
          <Button
            size="xs"
            variant="primary"
            disabled={disabled || draft.trim().length === 0}
            onClick={() => void send()}
          >
            {busy ? "Steer" : "Send"}
          </Button>
        </div>
        {/* the scope rule, said out loud (vision §8) */}
        <p className="mt-2 text-[11.5px] text-ink-3">
          Scoped to {courseCode ?? "this course"}. For “what should I do
          today”, text the line.
        </p>
        </div>
      </div>

      <span className="sr-only">
        course {courseId} · chat {chatId}
      </span>
    </div>
  )
}
