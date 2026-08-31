import type { Infer } from "convex/values"

import type { Id } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import type { provenanceV, signalKindV, signalOriginV } from "./validators"

/**
 * The single write path into `studentSignals`.
 *
 * Both `internal.signals.record` (Face, the workspace agent) and
 * `internal.voice.recordSignal` (Voice) go through here, so the trim rule, the
 * `observedAt` default, and the provenance default cannot drift apart — they
 * already had (0.5 in one place, 0.6 in the other, CR 3892156309).
 *
 * What is stored is what was said. Nothing here aggregates, scores, or
 * interprets (vision §4b/§9).
 */

export type SignalRefs = {
  courseId?: Id<"courses">
  deadlineId?: Id<"deadlines">
  taskId?: Id<"tasks">
}

export type RecordSignalInput = {
  studentId: Id<"students">
  kind: Infer<typeof signalKindV>
  text: string
  refs?: SignalRefs
  origin: Infer<typeof signalOriginV>
  observedAt?: number
  provenance?: Infer<typeof provenanceV>
}

/**
 * A confidence is a probability or it is not a confidence — and it is a SOURCE
 * fact: when the caller did not assert one, none is stored (absent, never a
 * fabricated default that reads like a measurement).
 */
export function normalizeConfidence(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

export async function recordSignalInternal(
  ctx: MutationCtx,
  input: RecordSignalInput
): Promise<Id<"studentSignals">> {
  const text = input.text.trim()
  // A `400:` prefix so the HTTP layer answers 400 rather than 500 — an empty
  // text is a caller mistake, not a server fault (CR 3892156312).
  if (!text) throw new Error("400: signal text must not be empty")

  const observedAt =
    input.observedAt !== undefined && Number.isFinite(input.observedAt)
      ? input.observedAt
      : Date.now()

  return await ctx.db.insert("studentSignals", {
    studentId: input.studentId,
    kind: input.kind,
    text,
    refs: input.refs ?? {},
    origin: input.origin,
    observedAt,
    provenance: input.provenance ?? {
      source: input.origin === "chat" ? "chat" : "manual",
      sourceRef: input.origin,
    },
  })
}
