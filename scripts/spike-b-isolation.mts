/**
 * Spike B #1 — per-session sandbox isolation (plans/face.md).
 *
 * Disqualifying question: can two durable sessions of the SAME eve agent see
 * each other's `/workspace` files? vision §10: "Isolation is non-negotiable."
 *
 * Two modes, same assertions:
 *
 *   probe  (default) — no model calls. `agent/workspace/hooks/spike-b-probe.ts`
 *          runs on `message.received`, reaches the live sandbox through
 *          `ctx.getSandbox()` (the same seam a tool uses) and appends NDJSON
 *          observations. Use this when the AI Gateway is unavailable, or to
 *          re-verify isolation for free.
 *
 *   agent  — drives the real tools (`write_marker`, `list_workspace`,
 *          `teardown`, `propose_change`) through the model. Needs a working
 *          AI_GATEWAY_API_KEY. Costs a few cents.
 *
 * Run:
 *   SPIKE_B_PROBE=1 pnpm dev -p 3004          # terminal 1 (probe mode)
 *   node scripts/spike-b-isolation.mts        # terminal 2
 *
 *   pnpm dev -p 3004                          # terminal 1 (agent mode)
 *   node scripts/spike-b-isolation.mts --mode=agent
 */
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "eve/client"
import type { ClientSession, MessageStreamEvent } from "eve/client"

const HOST = process.env.EVE_HOST ?? "http://localhost:3004/eve/agents/workspace"
const PROBE_OUT = process.env.SPIKE_B_PROBE_OUT ?? join(tmpdir(), "spike-b-probe.ndjson")
const MODE = process.argv.includes("--mode=agent") ? "agent" : "probe"

interface Check {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

const checks: Check[] = []
function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}\n        ${detail}`)
}

// --------------------------------------------------------------------------
// probe mode
// --------------------------------------------------------------------------

interface ProbeRecord {
  readonly sessionId: string
  readonly sandboxId?: string
  readonly actions?: readonly string[]
  readonly files?: readonly string[]
  readonly error?: string
}

function readProbe(): ProbeRecord[] {
  try {
    return readFileSync(PROBE_OUT, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ProbeRecord)
  } catch {
    return []
  }
}

async function waitForProbe(count: number, label: string): Promise<ProbeRecord[]> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const rows = readProbe()
    if (rows.length >= count) return rows
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for probe record ${count} (${label}) in ${PROBE_OUT}`)
}

/**
 * Sends a directive and waits for the probe to observe it. The probe runs on
 * `message.received`, i.e. before any model call, so we never wait for (or pay
 * for) a turn: cancel it as soon as the observation lands.
 */
async function probeTurn(
  session: ClientSession,
  directive: string,
  expectRecords: number,
): Promise<ProbeRecord[]> {
  void session.send(directive).catch((error: unknown) => {
    console.log(`        [send ${directive}] ${error instanceof Error ? error.message : String(error)}`)
  })
  const rows = await waitForProbe(expectRecords, directive)
  await session.cancel().catch(() => undefined)
  return rows
}

/**
 * Every session appends to the same NDJSON file, so select by identity rather
 * than by array position: an extra record would otherwise shift the indexes and
 * make an assertion inspect the wrong session's observation.
 */
function lastFor(
  rows: readonly ProbeRecord[],
  sessionId: string,
  action?: string,
): ProbeRecord | undefined {
  return rows
    .filter(
      (r) =>
        r.sessionId === sessionId &&
        (action === undefined || r.actions?.includes(action) === true),
    )
    .at(-1)
}

function filesFor(record: ProbeRecord | undefined): string[] {
  return [...(record?.files ?? [])]
}

async function runProbeMode(client: Client): Promise<void> {
  rmSync(PROBE_OUT, { force: true })
  console.log(`probe file: ${PROBE_OUT}\n`)

  // 0: session A marks + lists
  console.log("Session A — SPIKE_B_MARK (write marker, list workspace)")
  const a = await client.sessions.create({ message: "SPIKE_B_MARK" })
  const rows0 = await waitForProbe(1, "A mark")
  await a.session.cancel().catch(() => undefined)
  const a1 = rows0[0]!
  const sessionA = a1.sessionId
  const sandboxA = a1.sandboxId ?? "<none>"
  const markerA = `marker-${sessionA}.txt`
  const a1Files = filesFor(lastFor(rows0, sessionA, "mark"))

  check(
    "A1 probe reached a live sandbox",
    a1.error === undefined && sandboxA !== "<none>",
    `sandboxId=${sandboxA} error=${a1.error ?? "none"}`,
  )
  check(
    "A1 marker written and visible in session A",
    a1Files.includes(markerA),
    `${markerA} in [${a1Files.join(", ")}]`,
  )
  check(
    "A1 onSession hydrated SESSION.md",
    a1Files.includes("SESSION.md"),
    `files=[${a1Files.join(", ")}]`,
  )

  // 1: session B — a different durable session of the SAME agent
  console.log("\nSession B — SPIKE_B_LIST (fresh session, same agent)")
  const b = await client.sessions.create({ message: "SPIKE_B_LIST" })
  const rows1 = await waitForProbe(2, "B list")
  await b.session.cancel().catch(() => undefined)
  const b1 = rows1.find((r) => r.sessionId !== sessionA)
  if (!b1) throw new Error("session B produced no probe record")
  const sessionB = b1.sessionId
  const sandboxB = b1.sandboxId ?? "<none>"
  const b1Files = filesFor(b1)
  const leaked = b1Files.includes(markerA)

  check(
    "B1 cannot see session A's marker   [DISQUALIFYING]",
    !leaked,
    `${markerA} ${leaked ? "LEAKED into" : "absent from"} B: [${b1Files.join(", ")}]`,
  )
  check(
    "B1 sandbox id differs from A       [DISQUALIFYING]",
    sandboxB !== sandboxA && sandboxB !== "<none>",
    `A=${sandboxA}  B=${sandboxB}`,
  )
  check(
    "B1 got its own hydrated SESSION.md",
    b1Files.includes("SESSION.md"),
    `files=[${b1Files.join(", ")}]`,
  )

  // 2: session A, second turn — persistence within a durable session
  console.log("\nSession A — SPIKE_B_LIST (second turn: persistence)")
  const rows2 = await probeTurn(a.session, "SPIKE_B_LIST", 3)
  const a2 = lastFor(rows2, sessionA, "list")
  const a2Files = filesFor(a2)
  check(
    "A2 marker persists across turns in the same session",
    a2Files.includes(markerA),
    `${markerA} in [${a2Files.join(", ")}]`,
  )
  check(
    "A2 same sandbox id across turns",
    a2?.sandboxId === sandboxA,
    `${a2?.sandboxId ?? "<none>"} === ${sandboxA}`,
  )
  check(
    "A2 still cannot see anything of B's",
    !a2Files.includes(`marker-${sessionB}.txt`),
    `files=[${a2Files.join(", ")}]`,
  )

  // 3-4: session B — delete the sandbox, then re-open it
  console.log("\nSession B — SPIKE_B_MARK then SPIKE_B_DELETE (teardown)")
  await probeTurn(b.session, "SPIKE_B_MARK", 4)
  const markerB = `marker-${sessionB}.txt`
  const b2Files = filesFor(lastFor(readProbe(), sessionB, "mark"))
  check(
    "B2 marker written in B",
    b2Files.includes(markerB),
    `${markerB} in [${b2Files.join(", ")}]`,
  )

  const rows6 = await probeTurn(b.session, "SPIKE_B_DELETE", 6)
  const deleted = lastFor(rows6, sessionB, "delete")
  const reopened = lastFor(rows6, sessionB, "reopen-after-delete")
  const afterDelete = filesFor(reopened)
  check(
    "B3 sandbox.delete() succeeded",
    deleted?.error === undefined &&
      reopened !== undefined &&
      reopened.error === undefined,
    `${deleted?.actions?.join("+") ?? "?"} -> ${reopened?.actions?.join("+") ?? "?"}`,
  )
  check(
    "B3 delete discarded the workspace (marker gone)",
    !afterDelete.includes(markerB),
    `${markerB} in [${afterDelete.join(", ")}]`,
  )
  check(
    "B3 onSession reran on re-provision (SESSION.md rebuilt)",
    afterDelete.includes("SESSION.md"),
    `files=[${afterDelete.join(", ")}]`,
  )
  check(
    "B3 replacement sandbox still isolated from A",
    !afterDelete.includes(markerA),
    `${markerA} absent=${!afterDelete.includes(markerA)}`,
  )

  summary({ sandboxA, sandboxB, sessionA, sessionB, costUsd: 0 })
}

// --------------------------------------------------------------------------
// agent mode (model-driven; needs a funded AI Gateway account)
// --------------------------------------------------------------------------

interface ToolResult {
  readonly toolName: string
  readonly output: Record<string, unknown>
  readonly isError: boolean
}

function toolResults(events: readonly MessageStreamEvent[]): ToolResult[] {
  const out: ToolResult[] = []
  for (const event of events) {
    if (event.type !== "action.result") continue
    const result = event.data.result
    if (result.kind !== "tool-result") continue
    out.push({
      toolName: result.toolName,
      output:
        typeof result.output === "object" &&
        result.output !== null &&
        !Array.isArray(result.output)
          ? (result.output as Record<string, unknown>)
          : { value: result.output },
      isError: result.isError === true,
    })
  }
  return out
}

function last(results: readonly ToolResult[], toolName: string): ToolResult | undefined {
  return results.filter((r) => r.toolName === toolName).at(-1)
}

function filesOf(result: ToolResult | undefined): string[] {
  const files = result?.output.files
  return Array.isArray(files) ? files.map(String) : []
}

function sandboxIdOf(result: ToolResult | undefined): string {
  return typeof result?.output.sandboxId === "string" ? result.output.sandboxId : "<none>"
}

const allEvents: MessageStreamEvent[] = []

function usdSpent(events: readonly MessageStreamEvent[]): number {
  let total = 0
  for (const event of events) {
    if (event.type === "step.completed") total += event.data.usage?.costUsd ?? 0
  }
  return total
}

async function runAgentMode(client: Client): Promise<void> {
  console.log("Session A — write_marker then list_workspace")
  const created = await client.sessions.create({
    message:
      "Call write_marker with note 'session-A'. Then call list_workspace. Then reply with only the word done.",
  })
  const sessionA = created.session
  const a1 = await created.response.result()
  allEvents.push(...a1.events)
  const a1Tools = toolResults(a1.events)
  const markerA = last(a1Tools, "write_marker")
  const listA1 = last(a1Tools, "list_workspace")
  const sandboxA = sandboxIdOf(markerA) !== "<none>" ? sandboxIdOf(markerA) : sandboxIdOf(listA1)
  const markerPathA = String(markerA?.output.path ?? `marker-${sessionA.state.sessionId}.txt`)

  check(
    "A1 tools ran",
    markerA !== undefined && listA1 !== undefined && !markerA.isError && !listA1.isError,
    `write_marker=${markerA !== undefined} list_workspace=${listA1 !== undefined}`,
  )
  check(
    "A1 marker visible in session A",
    filesOf(listA1).includes(markerPathA),
    `${markerPathA} in [${filesOf(listA1).join(", ")}]`,
  )

  console.log("\nSession A — second turn, list_workspace again (persistence)")
  const a2 = await (
    await sessionA.send("Call list_workspace. Then reply with only the word done.")
  ).result()
  allEvents.push(...a2.events)
  const listA2 = last(toolResults(a2.events), "list_workspace")
  check(
    "A2 marker persists across turns in the same session",
    filesOf(listA2).includes(markerPathA),
    `${markerPathA} in [${filesOf(listA2).join(", ")}]`,
  )
  check(
    "A2 same sandbox id across turns",
    sandboxIdOf(listA2) === sandboxA,
    `${sandboxIdOf(listA2)} === ${sandboxA}`,
  )

  console.log("\nSession B — fresh session, list_workspace (isolation)")
  const createdB = await client.sessions.create({
    message: "Call list_workspace. Then reply with only the word done.",
  })
  const sessionB = createdB.session
  const b1 = await createdB.response.result()
  allEvents.push(...b1.events)
  const listB1 = last(toolResults(b1.events), "list_workspace")
  const sandboxB = sandboxIdOf(listB1)
  const leaked = filesOf(listB1).includes(markerPathA)

  check(
    "B1 cannot see session A's marker   [DISQUALIFYING]",
    !leaked,
    `${markerPathA} ${leaked ? "LEAKED into" : "absent from"} B: [${filesOf(listB1).join(", ")}]`,
  )
  check(
    "B1 sandbox id differs from A       [DISQUALIFYING]",
    sandboxB !== sandboxA && sandboxB !== "<none>",
    `A=${sandboxA}  B=${sandboxB}`,
  )

  console.log("\nSession B — write marker, delete sandbox, list again (teardown)")
  const b2 = await (
    await sessionB.send(
      "Call write_marker with note 'session-B'. Then call teardown with mode 'delete'. Then call list_workspace. Then reply with only the word done.",
    )
  ).result()
  allEvents.push(...b2.events)
  const b2Tools = toolResults(b2.events)
  const markerB = last(b2Tools, "write_marker")
  const teardownB = last(b2Tools, "teardown")
  const listB2 = last(b2Tools, "list_workspace")
  const markerPathB = String(markerB?.output.path ?? `marker-${sessionB.state.sessionId}.txt`)

  check(
    "B2 sandbox.delete() succeeded",
    teardownB !== undefined && !teardownB.isError,
    `teardown=${JSON.stringify(teardownB?.output ?? null)}`,
  )
  check(
    "B2 delete discarded the workspace (marker gone)",
    listB2 !== undefined && !filesOf(listB2).includes(markerPathB),
    `${markerPathB} in [${filesOf(listB2).join(", ")}]`,
  )
  check(
    "B2 onSession reran after delete (SESSION.md rebuilt)",
    filesOf(listB2).includes("SESSION.md"),
    `files=[${filesOf(listB2).join(", ")}]`,
  )

  console.log("\nSession A — propose_change parks for approval (HITL)")
  const a3 = await (
    await sessionA.send(
      "Call propose_change with kind 'deadline_moved', title 'PS4', before '2026-09-10', after '2026-09-12', reason 'syllabus says the 12th'.",
    )
  ).result()
  allEvents.push(...a3.events)
  const requested = a3.events.find((e) => e.type === "input.requested")
  const request = requested?.type === "input.requested" ? requested.data.requests.at(0) : undefined
  check(
    "A3 propose_change parked for human approval",
    request !== undefined && request.kind === "tool-approval",
    `kind=${request?.kind ?? "<none>"} requestId=${request?.requestId ?? "<none>"}`,
  )

  if (request !== undefined) {
    const approveId = request.options?.find((o) => o.id === "approve")?.id ?? "approve"
    const a4 = await (
      await sessionA.respond([{ requestId: request.requestId, optionId: approveId }])
    ).result()
    allEvents.push(...a4.events)
    const change = last(toolResults(a4.events), "propose_change")
    const envelope = change?.output.change as Record<string, unknown> | undefined
    check(
      "A4 approved propose_change returns the pending change envelope",
      change !== undefined &&
        !change.isError &&
        envelope?.tier === "needs_approval" &&
        envelope?.status === "pending",
      JSON.stringify(change?.output ?? null),
    )
  }

  summary({
    sandboxA,
    sandboxB,
    sessionA: sessionA.state.sessionId,
    sessionB: sessionB.state.sessionId,
    costUsd: usdSpent(allEvents),
  })
}

// --------------------------------------------------------------------------

function summary(info: {
  sandboxA: string
  sandboxB: string
  sessionA: string
  sessionB: string
  costUsd: number
}): void {
  const failed = checks.filter((c) => !c.pass)
  const rule = "=".repeat(64)
  console.log(`\n${rule}`)
  console.log(`SPIKE B #1 — PER-SESSION SANDBOX ISOLATION  (mode=${MODE})`)
  console.log(rule)
  for (const c of checks) console.log(`${(c.pass ? "PASS" : "FAIL").padEnd(6)}${c.name}`)
  console.log(rule)
  console.log(`session A : ${info.sessionA}`)
  console.log(`sandbox A : ${info.sandboxA}`)
  console.log(`session B : ${info.sessionB}`)
  console.log(`sandbox B : ${info.sandboxB}`)
  console.log(`gateway cost this run: $${info.costUsd.toFixed(6)}`)
  console.log(
    `\nVERDICT: ${
      failed.length === 0
        ? "ISOLATED PER SESSION — eve is viable for the workspace agent."
        : `${failed.length} FAILED — ${failed.map((c) => c.name).join("; ")}`
    }`,
  )
  process.exitCode = failed.length === 0 ? 0 : 1
}

async function main(): Promise<void> {
  const client = new Client({ host: HOST })
  const health = await client.health()
  console.log(`\neve health: ${health.status}  host=${HOST}  mode=${MODE}\n`)
  if (MODE === "agent") await runAgentMode(client)
  else await runProbeMode(client)
}

await main()
