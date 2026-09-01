"use client"

import { useMemo } from "react"
import { useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import type {
  Change,
  ChangeField,
  ChangeOrigin,
  Course,
  Deadline,
  Provenance,
  Source,
  SourceHealth,
  StudentSignal,
  Task,
  Viewer,
} from "./types"

/**
 * The single seam between Face and Core — every hook is a real Convex
 * subscription (`undefined` while loading, then data), adapted to the Face
 * view-model in `types.ts`.
 *
 * The adapter exists because the view-model carries *presentation* that Core
 * deliberately does not store (vision §9): course accents, ISO date strings for
 * the formatters, the change feed's summary/diff-lines/tool-label, connector
 * labels and the flat health enum. Everything derived is derived HERE, per
 * render, recomputable — panels never see a Convex doc and never import
 * `fixtures.ts` (which now exists only for Storybook-style reference).
 */

/* ── shared mapping helpers ─────────────────────────────────────────────── */

const msToIso = (ms: number): string => new Date(ms).toISOString()

/** Display accents, cycled per course. A display choice, not a fact. */
const ACCENTS = ["var(--accent)", "var(--green)", "var(--orange)", "var(--red)"]

type ProvenanceDoc = Doc<"courses">["provenance"]

function mapProvenance(p: ProvenanceDoc): Provenance {
  return {
    source: p.source,
    sourceRef: p.sourceRef,
    confidence: p.confidence,
    snapshotId: p.snapshotId,
    // Core stores no per-fact observation timestamp yet (it lives on the
    // snapshot); the popover hides the "Seen" row when absent.
    observedAt: undefined,
  }
}

/* ── viewer ─────────────────────────────────────────────────────────────── */

/** Real. The Clerk ↔ Convex identity, or `null` when signed out. */
export function useViewer(): Viewer | undefined {
  return useQuery(api.auth.viewer)
}

/* ── courses ────────────────────────────────────────────────────────────── */

function mapCourse(doc: Doc<"courses">, index: number): Course {
  return {
    _id: doc._id,
    studentId: doc.studentId,
    name: doc.name,
    code: doc.code ?? doc.name,
    accent: ACCENTS[index % ACCENTS.length],
    sourceRefs: doc.sourceRefs,
    gradingScheme: (doc.gradingScheme?.categories ?? []).map((c) => ({
      name: c.name,
      // Core stores weights as percentages (Canvas group_weight; extraction
      // normalizes to percent). The Face view-model is a 0–1 fraction.
      weight: (c.weight ?? 0) / 100,
      dropRule:
        c.dropLowest !== undefined
          ? `lowest ${c.dropLowest} dropped`
          : undefined,
    })),
    status: doc.status,
    provenance: mapProvenance(doc.provenance),
  }
}

export function useCourses(): Course[] | undefined {
  const docs = useQuery(api.courses.list, {})
  return useMemo(() => docs?.map(mapCourse), [docs])
}

/* ── deadlines ──────────────────────────────────────────────────────────── */

export function useDeadlines(): Deadline[] | undefined {
  const docs = useQuery(api.deadlines.list, {})
  return useMemo(
    () =>
      docs
        // Undated work cannot be placed on a date-shaped view; it comes back
        // when there is a surface for it.
        ?.filter((d) => d.dueAt !== undefined)
        .map((d) => ({
          _id: d._id,
          courseId: d.courseId,
          title: d.title,
          kind: d.kind,
          dueAt: msToIso(d.dueAt!),
          pointsPossible: d.pointsPossible,
          category: d.category,
          submissionStatus: d.submissionStatus,
          description: d.description,
          provenance: mapProvenance(d.provenance),
          // Annotated server-side by `api.deadlines.list` (lib/data/README.md).
          pendingChangeId: d.pendingChangeId,
        })),
    [docs]
  )
}

/* ── tasks ──────────────────────────────────────────────────────────────── */

/**
 * Core stores the planned day (`plannedFor`, "YYYY-MM-DD") and the start
 * (`plannedStartMin`, minutes from local midnight) separately. The view-model
 * keeps one local-naive ISO datetime so `daysAway`/`timeLabel` read it in the
 * viewer's local time — correct for the student looking at their own plan.
 */
function plannedForIso(doc: Doc<"tasks">): string | undefined {
  if (!doc.plannedFor) return undefined
  const minutes = doc.plannedStartMin ?? 0
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0")
  const mm = String(minutes % 60).padStart(2, "0")
  return `${doc.plannedFor}T${hh}:${mm}:00`
}

export function useTasks(): Task[] | undefined {
  const docs = useQuery(api.tasks.list, {})
  return useMemo(
    () =>
      docs?.map((t) => ({
        _id: t._id,
        studentId: t.studentId,
        courseId: t.courseId,
        deadlineId: t.deadlineId,
        title: t.title,
        type: t.type,
        status: t.status,
        plannedFor: plannedForIso(t),
        estEffortMin: t.estEffortMin,
        actualEffortMin: t.actualEffortMin,
        createdBy: t.createdBy,
      })),
    [docs]
  )
}

/* ── changes ────────────────────────────────────────────────────────────── */

const TOOL_LABEL: Record<ChangeOrigin, string> = {
  canvas: "polled Canvas",
  ical: "read iCal feed",
  syllabus: "parsed syllabus",
  site: "crawled course site",
  chat: "confirmed in the thread",
  manual: "you fixed it",
  schedule: "parsed schedule",
}

const KIND_LABEL: Record<Doc<"changes">["kind"], string> = {
  deadline_added: "new deadline",
  deadline_moved: "due date moved",
  deadline_removed: "deadline removed",
  deadline_updated: "deadline updated",
  submitted: "marked submitted",
  grade_posted: "grade posted",
  course_added: "course added",
  course_updated: "course updated",
  task_created: "task created",
  task_updated: "task updated",
  availability_updated: "availability updated",
  chat_decision: "decided in chat",
  other: "updated",
}

const asBag = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** change-feed.tsx formats these field names with `dueLabel`, so ms → ISO. */
const MS_FIELDS = new Set(["dueAt", "resolvedAt", "createdAt"])

/** Bag keys that are bookkeeping or opaque references, not student-meaningful diff lines. */
const SKIP_FIELDS = new Set([
  "provenance",
  "externalIds",
  "courseId",
  "deadlineId",
  "taskId",
  "studentId",
])

function diffValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (MS_FIELDS.has(field) && typeof value === "number") return msToIso(value)
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

/** Before/after bags → the per-field diff lines the feed renders. */
function diffFields(beforeRaw: unknown, afterRaw: unknown): ChangeField[] {
  const before = asBag(beforeRaw)
  const after = asBag(afterRaw)
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const out: ChangeField[] = []
  for (const key of keys) {
    if (SKIP_FIELDS.has(key)) continue
    const b = diffValue(key, before[key])
    const a = diffValue(key, after[key])
    if (b !== a) out.push({ field: key, before: b, after: a })
  }
  return out
}

function changeSummary(doc: Doc<"changes">): string {
  if (doc.reason) return doc.reason
  const title = asBag(doc.after).title ?? asBag(doc.before).title
  const label = KIND_LABEL[doc.kind]
  return typeof title === "string" ? `${label}: ${title}` : label
}

function mapChange(doc: Doc<"changes">): Change {
  const afterProvenance = asBag(asBag(doc.after).provenance)
  const confidence =
    typeof afterProvenance.confidence === "number"
      ? afterProvenance.confidence
      : undefined
  return {
    _id: doc._id,
    studentId: doc.studentId,
    courseId: doc.courseId,
    deadlineId:
      doc.entity.table === "deadlines" ? doc.entity.id : undefined,
    kind: doc.kind,
    summary: changeSummary(doc),
    fields: diffFields(doc.before, doc.after),
    origin: doc.origin,
    tier: doc.tier,
    status: doc.status,
    toolLabel: TOOL_LABEL[doc.origin],
    confidence,
    snapshotIds: doc.snapshotIds,
    at: msToIso(doc.createdAt),
  }
}

export function useChanges(): Change[] | undefined {
  const docs = useQuery(api.changes.feed, {})
  return useMemo(() => docs?.map(mapChange), [docs])
}

/* ── sources ────────────────────────────────────────────────────────────── */

const SOURCE_LABEL: Record<Doc<"sources">["kind"], string> = {
  canvas: "Canvas",
  ical: "iCal feed",
  syllabus: "Syllabus",
  site: "Course site",
  schedule: "Class schedule",
  calendar: "Personal calendar",
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

function sourceDetail(doc: Doc<"sources">): string {
  const config = asBag(doc.config)
  if (config.mode === "fixture") return "fixture data (dev)"
  switch (doc.kind) {
    case "canvas":
      return [
        config.token === "[set]" ? "Personal access token" : "No token",
        hostOf(config.baseUrl),
      ]
        .filter(Boolean)
        .join(" · ")
    case "ical":
    case "calendar":
      return hostOf(config.url) ?? "feed URL"
    default:
      return doc.enabled ? "connected" : "disabled"
  }
}

function sourceHealth(doc: Doc<"sources">): SourceHealth {
  switch (doc.health.status) {
    case "ok":
      return "healthy"
    case "stale":
      return "degraded"
    case "error":
      return "failing"
    case "unknown":
      return doc.lastPolledAt !== undefined ? "degraded" : "never_synced"
  }
}

/** Which course codes a source currently feeds — joined from `sourceRefs`. */
function coversFor(doc: Doc<"sources">, courses: Course[] | undefined): string[] {
  if (!courses) return []
  switch (doc.kind) {
    case "canvas":
      return courses
        .filter((c) => c.sourceRefs.canvasCourseId !== undefined)
        .map((c) => c.code)
    case "ical":
      return courses
        .filter((c) => c.sourceRefs.icalUrl !== undefined)
        .map((c) => c.code)
    case "site":
      return courses
        .filter((c) => c.sourceRefs.siteUrl !== undefined)
        .map((c) => c.code)
    default:
      return []
  }
}

export function useSources(): Source[] | undefined {
  const docs = useQuery(api.ingest.sources.list, {})
  const courses = useCourses()
  return useMemo(
    () =>
      docs?.map((doc) => ({
        _id: doc._id,
        studentId: doc.studentId,
        kind: doc.kind,
        label: SOURCE_LABEL[doc.kind],
        detail: sourceDetail(doc),
        lastPolledAt:
          doc.lastPolledAt !== undefined ? msToIso(doc.lastPolledAt) : null,
        health: sourceHealth(doc),
        covers: coversFor(doc, courses),
        note: doc.health.message,
      })),
    [docs, courses]
  )
}

/* ── signals ────────────────────────────────────────────────────────────── */

export function useStudentSignals(): StudentSignal[] | undefined {
  const docs = useQuery(api.signals.recent, {})
  return useMemo(
    () =>
      docs?.map((s) => ({
        _id: s._id,
        studentId: s.studentId,
        kind: s.kind,
        text: s.text,
        courseId: s.refs.courseId,
        deadlineId: s.refs.deadlineId,
        taskId: s.refs.taskId,
        origin: s.origin,
        observedAt: msToIso(s.observedAt),
        provenance: mapProvenance(s.provenance),
      })),
    [docs]
  )
}

/* ── derived helpers (never stored — vision §9 facts vs. inference) ─────── */

export function useCourse(courseId: string): Course | undefined | null {
  const courses = useCourses()
  if (courses === undefined) return undefined
  return courses.find((c) => c._id === courseId) ?? null
}
