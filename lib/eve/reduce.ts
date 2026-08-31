/**
 * Spike B #2 — the eve → harness reducer.
 *
 * `useEveAgent({ agent: "workspace" })` projects the NDJSON event stream into
 * `EveMessage[]` (eve's own shape, *not* AI SDK `UIMessage[]`). This module is
 * the whole mapping from that onto the forked harness's grammar, and it is a
 * **pure function** on purpose: the AI Gateway account is blocked
 * (`customer_verification_required`), so the only way to verify the glue today
 * is to replay recorded frames through it. See `lib/eve/fixtures.ts` and
 * `scripts/spike-b-stream-check.mts`.
 *
 * Nothing here touches React, Convex, or the DOM. Keep it that way — the rail
 * component decides how a `RailItem` looks, this decides what one *is*.
 */

import type {
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react"

/* ────────────────────────────────────────────────────────────
 * The change envelope
 * ──────────────────────────────────────────────────────────── */

/** `propose_change`'s input schema (agent/workspace/tools/propose_change.ts). */
export type ProposedChangeKind =
  | "deadline_moved"
  | "deadline_added"
  | "deadline_removed"

export interface ProposedChange {
  readonly kind: ProposedChangeKind
  readonly title: string
  readonly before?: string
  readonly after?: string
  readonly reason: string
}

/** One row of the diff table: a field, what it was, what it becomes. */
export interface DiffRow {
  readonly field: string
  readonly before: string | null
  readonly after: string | null
}

const CHANGE_KINDS = new Set<string>([
  "deadline_moved",
  "deadline_added",
  "deadline_removed",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Narrow an unknown tool input to the change envelope. `input` is `unknown` on
 * the part type by design (the tool schema lives in the agent, not here), so
 * this is the one place that validates it. A malformed envelope returns `null`
 * and the card degrades to the raw prompt — never a crash, never a wrong diff.
 */
export function readProposedChange(input: unknown): ProposedChange | null {
  if (!isRecord(input)) return null
  const { kind, title, before, after, reason } = input
  if (typeof kind !== "string" || !CHANGE_KINDS.has(kind)) return null
  if (typeof title !== "string" || title.length === 0) return null
  if (typeof reason !== "string" || reason.length === 0) return null
  return {
    kind: kind as ProposedChangeKind,
    title,
    reason,
    before: optionalString(before),
    after: optionalString(after),
  }
}

/**
 * The diff table for a change. Deadline changes carry one field today; the
 * shape is a list because grading-scheme and title fixes will carry more.
 */
export function diffRows(change: ProposedChange): readonly DiffRow[] {
  switch (change.kind) {
    case "deadline_added":
      return [{ field: "due", before: null, after: change.after ?? "—" }]
    case "deadline_removed":
      return [{ field: "due", before: change.before ?? "—", after: null }]
    case "deadline_moved":
      return [
        {
          field: "due",
          before: change.before ?? null,
          after: change.after ?? "—",
        },
      ]
  }
}

/* ────────────────────────────────────────────────────────────
 * Tool labels
 * ──────────────────────────────────────────────────────────── */

/**
 * Tool chips speak in Core actions, not function names (face.md
 * "Primitive → product mapping"). Gerund while it runs, past tense once done.
 */
const TOOL_LABELS: Record<
  string,
  { readonly running: string; readonly done: string }
> = {
  list_workspace: { running: "listing workspace", done: "listed workspace" },
  write_marker: { running: "writing marker", done: "wrote marker" },
  teardown: { running: "tearing down sandbox", done: "tore down sandbox" },
  propose_change: { running: "proposing change", done: "proposed change" },
}

export function toolLabel(toolName: string, done: boolean): string {
  const entry = TOOL_LABELS[toolName]
  if (entry) return done ? entry.done : entry.running
  const words = toolName.replace(/[_-]+/g, " ")
  return done ? words : `${words}…`
}

/* ────────────────────────────────────────────────────────────
 * Rail items
 * ──────────────────────────────────────────────────────────── */

export interface ApprovalOption {
  readonly id: string
  readonly label: string
  readonly style?: "danger" | "default" | "primary"
}

export type RailItem =
  /** What the student said. */
  | {
      readonly kind: "user"
      readonly id: string
      readonly text: string
      readonly failed: boolean
      readonly optimistic: boolean
    }
  /** `reasoning` part → ThinkingState grammar. */
  | {
      readonly kind: "thinking"
      readonly id: string
      readonly text: string
      readonly streaming: boolean
    }
  /** `text` part → StreamingText while streaming, plain prose once done. */
  | {
      readonly kind: "text"
      readonly id: string
      readonly text: string
      readonly streaming: boolean
    }
  /** A tool call in flight → tool chip. */
  | {
      readonly kind: "tool"
      readonly id: string
      readonly toolName: string
      readonly label: string
      /** `input-streaming` — the arguments are still arriving. */
      readonly preparing: boolean
    }
  /** A gated `propose_change` waiting on a person → approval card + diff. */
  | {
      readonly kind: "approval"
      readonly id: string
      readonly toolName: string
      readonly requestId: string
      readonly prompt: string
      readonly options: readonly ApprovalOption[]
      readonly allowFreeform: boolean
      /** `null` when the envelope didn't validate — render the raw prompt. */
      readonly change: ProposedChange | null
      readonly rows: readonly DiffRow[]
    }
  /** A finished call → collapsed row. */
  | {
      readonly kind: "result"
      readonly id: string
      readonly toolName: string
      readonly label: string
      readonly detail?: string
      readonly tone: "ok" | "error" | "denied"
    }

/** eve's own approval option ids. */
export const APPROVE_OPTION_ID = "approve"
export const REJECT_OPTION_ID = "cancel"

const DEFAULT_APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { id: REJECT_OPTION_ID, label: "Reject" },
  { id: APPROVE_OPTION_ID, label: "Approve", style: "primary" },
]

/**
 * eve labels its own decline option "Cancel", which in a change feed reads as
 * "close this card" rather than "this fact is wrong". Say what it does.
 */
const OPTION_LABELS: Record<string, string> = { [REJECT_OPTION_ID]: "Reject" }

function pendingRequest(
  part: EveDynamicToolPart
): EveMessageInputRequest | undefined {
  const request = part.toolMetadata?.eve?.inputRequest
  /* branch on `kind`, not on `toolName`: a `question` or `session-limit`
   * request is not an approval card even when it rides on a tool part. */
  if (!request || request.kind !== "tool-approval") return undefined
  return request
}

function summarizeChange(change: ProposedChange): string {
  switch (change.kind) {
    case "deadline_added":
      return `${change.title}: new deadline ${change.after ?? ""}`.trim()
    case "deadline_removed":
      return `${change.title}: deadline removed`
    case "deadline_moved":
      return `${change.title}: ${change.before ?? "?"} → ${change.after ?? "?"}`
  }
}

/** Human summary for a card header. Exported because the rail wants it too. */
export function changeSummary(
  change: ProposedChange | null,
  fallback: string
): string {
  return change ? summarizeChange(change) : fallback
}

function toolItem(id: string, part: EveDynamicToolPart): RailItem {
  const preparing = part.state === "input-streaming"
  return {
    kind: "tool",
    id,
    toolName: part.toolName,
    label: preparing ? "preparing…" : toolLabel(part.toolName, false),
    preparing,
  }
}

function resultItem(id: string, part: EveDynamicToolPart): RailItem {
  if (part.state === "output-error") {
    return {
      kind: "result",
      id,
      toolName: part.toolName,
      label: `${toolLabel(part.toolName, false)} failed`,
      detail: part.errorText,
      tone: "error",
    }
  }
  if (part.state === "output-denied") {
    return {
      kind: "result",
      id,
      toolName: part.toolName,
      label: `${toolLabel(part.toolName, true)} — rejected`,
      detail: part.approval.reason,
      tone: "denied",
    }
  }
  /* output-available */
  if (part.toolName === "propose_change") {
    const change = readProposedChange(part.input)
    return {
      kind: "result",
      id,
      toolName: part.toolName,
      label: "change proposed — pending in Core",
      detail: change ? summarizeChange(change) : undefined,
      tone: "ok",
    }
  }
  return {
    kind: "result",
    id,
    toolName: part.toolName,
    label: toolLabel(part.toolName, true),
    tone: "ok",
  }
}

function dynamicToolItem(id: string, part: EveDynamicToolPart): RailItem {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return toolItem(id, part)
    case "approval-requested": {
      const request = pendingRequest(part)
      const change = readProposedChange(part.input)
      if (!request) {
        /* an approval we can't answer yet — show it as work in flight rather
         * than a card with buttons that would post nowhere. */
        return toolItem(id, part)
      }
      return {
        kind: "approval",
        id,
        toolName: part.toolName,
        requestId: request.requestId,
        prompt: request.prompt,
        options:
          request.options && request.options.length > 0
            ? request.options.map((option) => ({
                id: option.id,
                label: OPTION_LABELS[option.id] ?? option.label,
                style: option.style,
              }))
            : DEFAULT_APPROVAL_OPTIONS,
        allowFreeform: request.allowFreeform === true,
        change,
        rows: change ? diffRows(change) : [],
      }
    }
    case "approval-responded":
      return {
        kind: "tool",
        id,
        toolName: part.toolName,
        label: `${toolLabel(part.toolName, false)} — sent`,
        preparing: false,
      }
    case "output-available":
    case "output-error":
    case "output-denied":
      return resultItem(id, part)
  }
}

function partItem(
  id: string,
  part: EveMessagePart,
  role: EveMessage["role"]
): RailItem | null {
  switch (part.type) {
    case "text":
      if (part.text.length === 0) return null
      if (role === "user") return null /* the message-level item covers it */
      return {
        kind: "text",
        id,
        text: part.text,
        streaming: part.state === "streaming",
      }
    case "reasoning":
      if (part.text.length === 0) return null
      return {
        kind: "thinking",
        id,
        text: part.text,
        streaming: part.state === "streaming",
      }
    case "dynamic-tool":
      return dynamicToolItem(id, part)
    case "file":
    case "step-start":
    case "authorization":
      /* Not load-bearing for Spike B: the workspace agent has no connections
       * (so no authorization prompts) and attachments arrive in M3. */
      return null
  }
}

/**
 * The reducer. Flattens `EveMessage[]` into the ordered list the rail renders.
 *
 * Every message is scanned, not just the last one: an approval stays open while
 * later turns append messages, so an approval card must be discoverable from
 * anywhere in the history (agent/workspace/README.md, "Approvals").
 */
export function reduceRail(
  messages: readonly EveMessage[]
): readonly RailItem[] {
  const items: RailItem[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.parts
        .filter(
          (part): part is Extract<EveMessagePart, { type: "text" }> =>
            part.type === "text"
        )
        .map((part) => part.text)
        .join("")
      if (text.length > 0) {
        items.push({
          kind: "user",
          id: message.id,
          text,
          failed: message.metadata?.status === "failed",
          optimistic: message.metadata?.optimistic === true,
        })
      }
      continue
    }
    message.parts.forEach((part, index) => {
      const item = partItem(`${message.id}:${index}`, part, message.role)
      if (item) items.push(item)
    })
  }
  return items
}

/** Open approvals anywhere in the history — what the composer must not race. */
export function openApprovals(
  items: readonly RailItem[]
): readonly Extract<RailItem, { kind: "approval" }>[] {
  return items.filter(
    (item): item is Extract<RailItem, { kind: "approval" }> =>
      item.kind === "approval"
  )
}
