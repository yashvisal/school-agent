/**
 * Spike B #2 — reducer check over a replayed eve stream (plans/face.md).
 *
 * The AI Gateway account is blocked (`customer_verification_required`), so a
 * live turn cannot run. The glue is therefore built as a pure function
 * (`lib/eve/reduce.ts`) over `EveMessage[]` and verified by replaying the
 * frames in `lib/eve/fixtures.ts` through it — the same code path the browser
 * uses. When the gateway is funded, the live path needs no change.
 *
 * There is no test runner in this repo (see package.json scripts), so this is a
 * plain script. Node >= 22.18 strips the types natively:
 *
 *   node scripts/spike-b-stream-check.mts
 */
import { REPLAY_FRAMES, APPROVAL_FRAME_INDEX } from "../lib/eve/fixtures.ts"
import {
  APPROVE_OPTION_ID,
  REJECT_OPTION_ID,
  openApprovals,
  reduceRail,
  type RailItem,
} from "../lib/eve/reduce.ts"

interface Check {
  readonly frame: string
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

const checks: Check[] = []
let currentFrame = ""

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ frame: currentFrame, name, pass, detail })
}

function kinds(items: readonly RailItem[]): string {
  return items.map((item) => item.kind).join(" → ")
}

function find<K extends RailItem["kind"]>(
  items: readonly RailItem[],
  kind: K
): Extract<RailItem, { kind: K }> | undefined {
  return items.find((item): item is Extract<RailItem, { kind: K }> => item.kind === kind)
}

const frames = REPLAY_FRAMES.map((frame) => ({
  ...frame,
  items: reduceRail(frame.messages),
}))

// ── frame 0: the user message ───────────────────────────────────────────────
currentFrame = frames[0].label
{
  const items = frames[0].items
  const user = find(items, "user")
  check("one user item, nothing else", items.length === 1 && !!user, kinds(items))
  check(
    "user text preserved",
    user?.text.startsWith("The syllabus PDF says PS4") === true,
    user?.text ?? "(none)"
  )
}

// ── frame 1: reasoning streaming ────────────────────────────────────────────
currentFrame = frames[1].label
{
  const thinking = find(frames[1].items, "thinking")
  check("reasoning → thinking item", !!thinking, kinds(frames[1].items))
  check("marked streaming", thinking?.streaming === true, String(thinking?.streaming))
  check(
    "step-start produces nothing",
    !frames[1].items.some((i) => i.kind === "tool" || i.kind === "result"),
    kinds(frames[1].items)
  )
}

// ── frame 2: tool call in flight ────────────────────────────────────────────
currentFrame = frames[2].label
{
  const tool = find(frames[2].items, "tool")
  check("input-available → tool chip", !!tool, kinds(frames[2].items))
  check("chip label is a Core action", tool?.label === "listing workspace", tool?.label ?? "")
  check("not marked preparing", tool?.preparing === false, String(tool?.preparing))
  check("thinking settled to done", find(frames[2].items, "thinking")?.streaming === false, "")
}

// ── frame 3: tool result + streaming answer ─────────────────────────────────
currentFrame = frames[3].label
{
  const items = frames[3].items
  const result = find(items, "result")
  const text = find(items, "text")
  check("output-available → result row", result?.label === "listed workspace", result?.label ?? "")
  check("result tone ok", result?.tone === "ok", result?.tone ?? "")
  check("assistant text item streaming", text?.streaming === true, String(text?.streaming))
  check("order: thinking → result → text", kinds(items) === "user → thinking → result → text", kinds(items))
}

// ── frame 4: partial JSON input ─────────────────────────────────────────────
currentFrame = frames[4].label
{
  const tools = frames[4].items.filter((i) => i.kind === "tool")
  const preparing = tools.find((t) => t.toolName === "propose_change")
  check("input-streaming → chip, not a card", !!preparing, kinds(frames[4].items))
  check("chip reads \"preparing…\"", preparing?.label === "preparing…", preparing?.label ?? "")
  check(
    "no approval card while input is partial",
    openApprovals(frames[4].items).length === 0,
    `${openApprovals(frames[4].items).length} open`
  )
  check("no crash on unparseable inputText", true, "reducer never parses inputText")
}

// ── frame 5: input available, still no approval ─────────────────────────────
currentFrame = frames[5].label
{
  const tool = frames[5].items.filter((i) => i.kind === "tool").at(-1)
  check("still a chip", tool?.label === "proposing change", tool?.label ?? "")
  check("no card yet", openApprovals(frames[5].items).length === 0, kinds(frames[5].items))
}

// ── frame 6: the approval card ──────────────────────────────────────────────
currentFrame = frames[APPROVAL_FRAME_INDEX].label
{
  const items = frames[APPROVAL_FRAME_INDEX].items
  const open = openApprovals(items)
  const approval = open[0]
  check("exactly one open approval", open.length === 1, `${open.length}`)
  check(
    "requestId is what respond() needs",
    approval?.requestId === "req_replay_approval_1",
    approval?.requestId ?? ""
  )
  check(
    "approve/reject option ids present",
    approval?.options.some((o) => o.id === APPROVE_OPTION_ID) === true &&
      approval?.options.some((o) => o.id === REJECT_OPTION_ID) === true,
    approval?.options.map((o) => `${o.id}:${o.label}`).join(", ") ?? ""
  )
  check(
    "change envelope validated",
    approval?.change?.kind === "deadline_moved" && approval.change.title === "Problem set 4",
    JSON.stringify(approval?.change)
  )
  check(
    "diff table has one before→after row",
    approval?.rows.length === 1 &&
      approval.rows[0].before === "Oct 9, 11:59pm" &&
      approval.rows[0].after === "Oct 12, 11:59pm",
    JSON.stringify(approval?.rows)
  )
  check("reason carried for the card", (approval?.change?.reason.length ?? 0) > 0, approval?.change?.reason ?? "")
  check(
    "answer text still rendered above the card",
    items.some((i) => i.kind === "text" && !i.streaming),
    kinds(items)
  )
}

// ── frame 7: approve sent ───────────────────────────────────────────────────
currentFrame = frames[7].label
{
  const items = frames[7].items
  check("card closes once responded", openApprovals(items).length === 0, kinds(items))
  const tool = items.filter((i) => i.kind === "tool").at(-1)
  check("shows as sent", tool?.label === "proposing change — sent", tool?.label ?? "")
}

// ── frame 8: output available ───────────────────────────────────────────────
currentFrame = frames[8].label
{
  const items = frames[8].items
  const results = items.filter((i) => i.kind === "result")
  const proposed = results.find((r) => r.toolName === "propose_change")
  check(
    "collapsed \"pending in Core\" row",
    proposed?.label === "change proposed — pending in Core",
    proposed?.label ?? ""
  )
  check(
    "row carries the summary",
    proposed?.detail === "Problem set 4: Oct 9, 11:59pm → Oct 12, 11:59pm",
    proposed?.detail ?? ""
  )
  check("no approval left open", openApprovals(items).length === 0, kinds(items))
  check("full rail shape", kinds(items) === "user → thinking → result → text → result", kinds(items))
}

// ── cross-turn: an approval stays discoverable behind later messages ────────
currentFrame = "approval persists across turns"
{
  const parked = REPLAY_FRAMES[APPROVAL_FRAME_INDEX].messages
  const later = [
    ...parked,
    { id: "msg_later_user", role: "user" as const, parts: [{ type: "text" as const, text: "actually, one more thing" }] },
    {
      id: "msg_later_assistant",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Still waiting on that change.", state: "done" as const }],
    },
  ]
  const items = reduceRail(later)
  check(
    "still found after two more messages",
    openApprovals(items).length === 1,
    `${openApprovals(items).length} open, ${items.length} items`
  )
}

// ── malformed envelope degrades, does not crash ─────────────────────────────
currentFrame = "malformed change envelope"
{
  const items = reduceRail([
    {
      id: "msg_bad",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call_bad",
          toolName: "propose_change",
          state: "approval-requested",
          input: { kind: "not_a_kind" },
          approval: { id: "apr_bad" },
          toolMetadata: {
            eve: {
              kind: "tool-call",
              name: "propose_change",
              inputRequest: {
                kind: "tool-approval",
                requestId: "req_bad",
                prompt: "Approve?",
              },
            },
          },
        },
      ],
    },
  ])
  const approval = openApprovals(items)[0]
  check("card still renders", !!approval, kinds(items))
  check("change is null, rows empty", approval?.change === null && approval.rows.length === 0, "")
  check(
    "falls back to eve's own options",
    approval?.options.length === 2,
    approval?.options.map((o) => o.id).join(",") ?? ""
  )
}

// ── report ──────────────────────────────────────────────────────────────────
let lastFrame = ""
for (const c of checks) {
  if (c.frame !== lastFrame) {
    lastFrame = c.frame
    console.log(`\n  ${c.frame}`)
  }
  console.log(
    `    ${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(46)} ${c.detail.slice(0, 70)}`
  )
}

const failed = checks.filter((c) => !c.pass)
console.log(
  `\n  ${checks.length - failed.length}/${checks.length} checks passed over ${REPLAY_FRAMES.length} replayed frames.\n`
)
if (failed.length > 0) process.exitCode = 1
