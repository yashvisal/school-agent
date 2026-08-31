/**
 * Spike B #2 — a replayed eve stream.
 *
 * The AI Gateway account is blocked (`customer_verification_required`), so no
 * real model turn can run. These are the message *snapshots* a real turn would
 * produce, one frame per render, walking the exact `dynamic-tool` state machine
 * documented in `agent/workspace/README.md`:
 *
 *   input-streaming → input-available → approval-requested
 *                   → approval-responded → output-available
 *
 * They are typed against eve's real `EveMessage`, so if eve's projection drifts
 * on upgrade, `pnpm typecheck` fails here first — which is the point.
 *
 * Used by `scripts/spike-b-stream-check.mts` (assertions) and by the rail's
 * dev-only `?replay=1` mode (the same rendering path, no model).
 */

import type { EveMessage } from "eve/react"

const USER_ID = "msg_replay_user"
const ASSISTANT_ID = "msg_replay_assistant"
const CALL_LIST = "call_list_workspace_1"
const CALL_PROPOSE = "call_propose_change_1"
const REQUEST_ID = "req_replay_approval_1"

const REASONING =
  "The syllabus in the workspace is v2, dated after the Canvas import. " +
  "state.md still has the v1 date, so the fact needs a fix — not an answer."

const ANSWER =
  "Your syllabus (v2, uploaded Sep 2) says Problem set 4 is due Oct 12. " +
  "state.md still carries Oct 9 from the original Canvas import, so the two " +
  "disagree. I can't change a fact myself — here's the fix for you to approve."

const CHANGE_INPUT = {
  kind: "deadline_moved",
  title: "Problem set 4",
  before: "Oct 9, 11:59pm",
  after: "Oct 12, 11:59pm",
  reason: "Syllabus v2 (p. 3) moves PS4 to Oct 12; state.md still has Oct 9.",
} as const

/* Partial JSON exactly as it arrives mid-stream — deliberately unparseable. */
const PARTIAL_INPUT_TEXT = '{"kind":"deadline_moved","title":"Problem se'

const userMessage: EveMessage = {
  id: USER_ID,
  role: "user",
  metadata: { status: "submitted" },
  parts: [
    {
      type: "text",
      text: "The syllabus PDF says PS4 is due the 12th but my list says the 9th. Which is right?",
    },
  ],
}

function assistant(parts: EveMessage["parts"], done = false): EveMessage {
  return {
    id: ASSISTANT_ID,
    role: "assistant",
    metadata: { status: done ? "complete" : "streaming", turnId: "wrun_replay" },
    parts,
  }
}

const listCallRunning: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_LIST,
  toolName: "list_workspace",
  state: "input-available",
  input: {},
  toolMetadata: { eve: { kind: "tool-call", name: "list_workspace" } },
}

const listCallDone: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_LIST,
  toolName: "list_workspace",
  state: "output-available",
  input: {},
  output: { files: ["SESSION.md", "state.md", "syllabus-v2.md"] },
  toolMetadata: { eve: { kind: "tool-call", name: "list_workspace" } },
}

const reasoningStreaming: EveMessage["parts"][number] = {
  type: "reasoning",
  text: "The syllabus in the workspace is v2, dated after the",
  state: "streaming",
}

const reasoningDone: EveMessage["parts"][number] = {
  type: "reasoning",
  text: REASONING,
  state: "done",
}

const answerStreaming: EveMessage["parts"][number] = {
  type: "text",
  text: "Your syllabus (v2, uploaded Sep 2) says Problem set 4 is due Oct 12.",
  state: "streaming",
}

const answerDone: EveMessage["parts"][number] = {
  type: "text",
  text: ANSWER,
  state: "done",
}

const proposeStreaming: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_PROPOSE,
  toolName: "propose_change",
  state: "input-streaming",
  input: undefined,
  inputText: PARTIAL_INPUT_TEXT,
  toolMetadata: { eve: { kind: "tool-call", name: "propose_change" } },
}

const proposeReady: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_PROPOSE,
  toolName: "propose_change",
  state: "input-available",
  input: CHANGE_INPUT,
  toolMetadata: { eve: { kind: "tool-call", name: "propose_change" } },
}

const proposeAwaiting: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_PROPOSE,
  toolName: "propose_change",
  state: "approval-requested",
  input: CHANGE_INPUT,
  approval: { id: "apr_replay_1" },
  toolMetadata: {
    eve: {
      kind: "tool-call",
      name: "propose_change",
      inputRequest: {
        kind: "tool-approval",
        requestId: REQUEST_ID,
        display: "confirmation",
        prompt: "Propose a change to a deadline fact for this course?",
        options: [
          { id: "cancel", label: "Reject" },
          { id: "approve", label: "Approve", style: "primary" },
        ],
      },
    },
  },
}

const proposeResponded: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_PROPOSE,
  toolName: "propose_change",
  state: "approval-responded",
  input: CHANGE_INPUT,
  approval: { id: "apr_replay_1", approved: true },
  toolMetadata: {
    eve: {
      kind: "tool-call",
      name: "propose_change",
      inputResponse: { requestId: REQUEST_ID, optionId: "approve" },
    },
  },
}

const proposeDone: EveMessage["parts"][number] = {
  type: "dynamic-tool",
  toolCallId: CALL_PROPOSE,
  toolName: "propose_change",
  state: "output-available",
  input: CHANGE_INPUT,
  approval: { id: "apr_replay_1", approved: true },
  output: {
    ok: true,
    change: {
      ...CHANGE_INPUT,
      tier: "needs_approval",
      status: "pending",
    },
  },
  toolMetadata: { eve: { kind: "tool-call", name: "propose_change" } },
}

/** One named frame of the replay: what `data.messages` looks like at that tick. */
export interface ReplayFrame {
  readonly label: string
  readonly messages: readonly EveMessage[]
}

export const REPLAY_FRAMES: readonly ReplayFrame[] = [
  {
    label: "user asked",
    messages: [userMessage],
  },
  {
    label: "reasoning streaming",
    messages: [userMessage, assistant([{ type: "step-start" }, reasoningStreaming])],
  },
  {
    label: "tool call in flight",
    messages: [
      userMessage,
      assistant([{ type: "step-start" }, reasoningDone, listCallRunning]),
    ],
  },
  {
    label: "tool result, answer streaming",
    messages: [
      userMessage,
      assistant([
        { type: "step-start" },
        reasoningDone,
        listCallDone,
        answerStreaming,
      ]),
    ],
  },
  {
    label: "propose_change input streaming (partial JSON)",
    messages: [
      userMessage,
      assistant([
        { type: "step-start" },
        reasoningDone,
        listCallDone,
        answerDone,
        proposeStreaming,
      ]),
    ],
  },
  {
    label: "propose_change input available",
    messages: [
      userMessage,
      assistant([
        { type: "step-start" },
        reasoningDone,
        listCallDone,
        answerDone,
        proposeReady,
      ]),
    ],
  },
  {
    label: "approval requested — turn parked",
    messages: [
      userMessage,
      assistant([
        { type: "step-start" },
        reasoningDone,
        listCallDone,
        answerDone,
        proposeAwaiting,
      ]),
    ],
  },
  {
    label: "approve sent",
    messages: [
      userMessage,
      assistant([
        { type: "step-start" },
        reasoningDone,
        listCallDone,
        answerDone,
        proposeResponded,
      ]),
    ],
  },
  {
    label: "output available — pending in Core",
    messages: [
      userMessage,
      assistant(
        [
          { type: "step-start" },
          reasoningDone,
          listCallDone,
          answerDone,
          proposeDone,
        ],
        true
      ),
    ],
  },
]

/** The frame with the open approval — the one the founder needs to see. */
export const APPROVAL_FRAME_INDEX = 6
