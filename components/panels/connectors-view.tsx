"use client"

import * as React from "react"
import { useMutation } from "convex/react"

import { Button } from "@/components/harness/atoms/Button"
import { StatusPill } from "@/components/harness/atoms/StatusPill"
import { Switch } from "@/components/harness/atoms/Switch"
import {
  EmptyState,
  LoadingRows,
  SectionHeader,
  ViewportBody,
  ViewportHeader,
} from "@/components/panels/chrome"
import {
  Card,
  CardNote,
  Divider,
  FieldRow,
  SaveBar,
  SelectField,
  TextField,
} from "@/components/panels/form"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { agoLabel } from "@/lib/format"
import { errorMessage, errorStatus } from "@/lib/errors"
import { useCourses, useSources } from "@/lib/data/hooks"
import type { Course, Source, SourceHealth } from "@/lib/data/types"

/**
 * Connectors — set-and-forget with health status (vision §8), plus the two
 * things a student has to do by hand before anything can be planned: attach a
 * feed (Canvas token or an iCal URL) and upload the documents nobody polls (a
 * syllabus, a class schedule).
 *
 * The Canvas personal-access-token path is ToS-grey on institutional instances
 * and can break silently, which is exactly why `sources.health` is surfaced
 * here rather than buried (core.md "Test data & limitations").
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

/** The health message `sources.resync` writes synchronously, so the card can
 * show progress the moment the mutation lands (convex/ingest/sources.ts). */
const RESYNC_NOTE = "re-sync requested"

/* ── one source ─────────────────────────────────────────────────────────── */

function SourceCard({ source }: { source: Source }) {
  const resync = useMutation(api.ingest.sources.resync)
  const setEnabled = useMutation(api.ingest.sources.setEnabled)
  const [inFlight, setInFlight] = React.useState(false)
  /* What `lastPolledAt` was when Re-sync was tapped. The adapters bump it on
   * both the success and the failure path, so "it moved" is a real completion
   * event — no timer pretending to be one. */
  const [pending, setPending] = React.useState<{ polledAt: string | null } | null>(
    null
  )
  const [error, setError] = React.useState<string | null>(null)
  /* A `429` is not a failure of the source — it is this button being pressed
   * inside its own cooldown (5 minutes for an upload, whose re-extraction costs
   * a model call; 60s for a feed). Kept apart from `error` so the card does not
   * paint a healthy source as broken, and cleared by the next click that lands. */
  const [cooldown, setCooldown] = React.useState<string | null>(null)
  const health = HEALTH[source.health]

  const resyncing =
    inFlight ||
    (pending !== null &&
      source.lastPolledAt === pending.polledAt &&
      source.note === RESYNC_NOTE)

  /* `pending` is never cleared on success: once `lastPolledAt` has moved past
   * the value recorded at the click, the condition above is false forever, and
   * the next click overwrites it. */

  const onResync = async () => {
    setError(null)
    setCooldown(null)
    setInFlight(true)
    setPending({ polledAt: source.lastPolledAt })
    try {
      // The mutation's own health patch is committed by the time this resolves,
      // so `resyncing` never flickers off between the two.
      await resync({ sourceId: source._id as Id<"sources"> })
      setCooldown(null)
    } catch (cause) {
      // Core writes the cooldown sentence as UI copy ("re-sync was requested
      // 12s ago; try again in 48s"), so it is shown as written rather than
      // paraphrased into a countdown Face would have to keep in sync.
      if (errorStatus(cause) === 429) setCooldown(errorMessage(cause))
      else setError(errorMessage(cause))
      setPending(null)
    } finally {
      setInFlight(false)
    }
  }

  const onToggle = async (enabled: boolean) => {
    setError(null)
    try {
      await setEnabled({ sourceId: source._id as Id<"sources">, enabled })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center gap-2.5 border-b border-line">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {source.label}
        </span>
        {!source.enabled && <StatusPill tone="neutral">Disabled</StatusPill>}
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
        {error && <p className="text-[12.5px] leading-relaxed text-red">{error}</p>}
      </div>

      <div className="primitive-card-footer flex min-h-11 items-center gap-3 border-t border-line">
        <span className="flex items-center gap-2">
          <Switch
            checked={source.enabled}
            onChange={(next) => void onToggle(next)}
            label={`${source.enabled ? "Disable" : "Enable"} ${source.label}`}
          />
          <span className="text-[12px] text-ink-3">
            {source.enabled ? "Enabled" : "Disabled"}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          {cooldown && (
            <span role="status" className="text-[11.5px] text-ink-3">
              {cooldown}
            </span>
          )}
          <Button
            size="xs"
            variant="secondary"
            disabled={resyncing || !source.enabled}
            onClick={() => void onResync()}
            title={
              source.enabled
                ? "Run the poll (or re-extraction) this source would run on its own"
                : "Enable the source before re-syncing it"
            }
          >
            {resyncing ? "Re-syncing…" : "Re-sync"}
          </Button>
        </span>
      </div>
    </div>
  )
}

/* ── add a feed ─────────────────────────────────────────────────────────── */

function AddCanvas() {
  const add = useMutation(api.ingest.sources.add)
  const [baseUrl, setBaseUrl] = React.useState("")
  const [token, setToken] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const dirty = baseUrl.trim().length > 0 && token.trim().length > 0

  const onSave = async () => {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      await add({ kind: "canvas", config: { baseUrl: baseUrl.trim(), token: token.trim() } })
      // The token is never readable again — not even by us — so clear the field
      // rather than leaving a value on screen that no longer reflects storage.
      setToken("")
      setNote("Connected. The first poll runs on the next sweep, or hit Re-sync.")
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <FieldRow label="Canvas URL" hint="your school's instance" htmlFor="canvas-base-url">
        <TextField
          id="canvas-base-url"
          type="url"
          inputMode="url"
          placeholder="https://canvas.duke.edu"
          className="w-64"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </FieldRow>
      <Divider />
      <FieldRow label="Access token" htmlFor="canvas-token">
        <TextField
          id="canvas-token"
          type="password"
          autoComplete="off"
          placeholder="paste the token"
          className="w-64"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </FieldRow>
      <Divider />
      <CardNote>
        In Canvas: <strong>Account → Settings → Approved Integrations → New
        access token</strong>. Copy it here — it is stored on the server, used
        only to poll your own courses, and never shown to the browser again
        (the card above will just say &ldquo;Personal access token&rdquo;). Some
        schools disable personal tokens; if yours has, the source will report
        Failing with the reason.
      </CardNote>
      <Divider />
      <SaveBar
        dirty={dirty}
        saving={saving}
        error={error}
        note={note}
        label="Connect Canvas"
        onSave={() => void onSave()}
      />
    </Card>
  )
}

function AddIcal() {
  const add = useMutation(api.ingest.sources.add)
  const [url, setUrl] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const onSave = async () => {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      await add({ kind: "ical", config: { url: url.trim() } })
      setNote("Added. The feed is read on the next sweep, or hit Re-sync.")
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <FieldRow label="Feed URL" hint="the .ics link, not the web page" htmlFor="ical-url">
        <TextField
          id="ical-url"
          type="url"
          inputMode="url"
          placeholder="https://…/calendar.ics"
          className="w-64"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </FieldRow>
      <Divider />
      <CardNote>
        Canvas publishes one per course under <strong>Calendar → Calendar
        Feed</strong>; most LMSes have an equivalent. A feed carries dates and
        titles but no submission status, so it complements a Canvas token
        rather than replacing one.
      </CardNote>
      <Divider />
      <SaveBar
        dirty={url.trim().length > 0}
        saving={saving}
        error={error}
        note={note}
        label="Add feed"
        onSave={() => void onSave()}
      />
    </Card>
  )
}

/* ── uploads ────────────────────────────────────────────────────────────── */

type UploadRow = {
  id: string
  file: File
  /** "" is deliberate: `uploads.start` accepts a syllabus with no course and
   * the parse proposes one. */
  courseId: string
  status: "queued" | "uploading" | "parsing" | "error"
  sourceId?: string
  /**
   * What that source's `lastPolledAt` was BEFORE this upload started. A
   * schedule re-upload reuses the existing source row, which already carries a
   * poll from last time, so "has ever polled" would read Parsed the instant
   * the upload landed. Only a value later than this one is *this* extraction.
   */
  polledAtBefore?: string | null
  error?: string
}

/**
 * Files can be tens of megabytes over a bad connection, and a `fetch` with no
 * signal never gives up — uploads run one at a time, so a single stalled one
 * freezes every file behind it. A minute is generous for a syllabus and short
 * enough that a dead connection surfaces as an error the student can retry.
 */
const UPLOAD_TIMEOUT_MS = 60_000

let uploadSeq = 0

/**
 * `generateUploadUrl` → `POST` the bytes to Convex storage → `uploads.start`,
 * which registers the source and schedules the extraction. The row then says
 * "Parsing…" until the source it produced reports a poll — the same real
 * completion event Re-sync watches, not a timer.
 */
function UploadSection({
  kind,
  courses,
  sources,
}: {
  kind: "syllabus" | "schedule"
  courses: Course[] | undefined
  sources: Source[] | undefined
}) {
  const generateUploadUrl = useMutation(api.ingest.uploads.generateUploadUrl)
  const start = useMutation(api.ingest.uploads.start)
  const [rows, setRows] = React.useState<UploadRow[]>([])
  const [busy, setBusy] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const polledAtById = React.useMemo(
    () => new Map((sources ?? []).map((s) => [s._id, s.lastPolledAt])),
    [sources]
  )
  /* Read at the moment an upload begins, not at the render that selected it:
   * uploads are awaited one at a time and a poll can land in between. */
  const polledAtRef = React.useRef(polledAtById)
  React.useEffect(() => {
    polledAtRef.current = polledAtById
  }, [polledAtById])

  const patch = (id: string, next: Partial<UploadRow>) =>
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...next } : row))
    )

  const onPick = (files: FileList | null) => {
    if (!files) return
    const picked = Array.from(files).map((file) => ({
      id: `u${++uploadSeq}`,
      file,
      courseId: "",
      status: "queued" as const,
    }))
    // A schedule upload is one file: the class schedule, replacing whatever
    // was uploaded before.
    setRows((current) => (kind === "schedule" ? picked.slice(0, 1) : [...current, ...picked]))
  }

  const upload = async (row: UploadRow) => {
    patch(row.id, { status: "uploading", error: undefined })
    try {
      const url = await generateUploadUrl({})
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": row.file.type || "application/octet-stream" },
        body: row.file,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`storage returned ${response.status}`)
      }
      const { storageId } = (await response.json()) as { storageId: string }
      /* Snapshotted immediately before `start`, after the storage upload. Too
       * early (before the upload) and a poll of a reused source during the
       * upload makes its timestamp look like THIS extraction finishing —
       * "Parsed" too soon. Too late (after `start` resolves) and a poll in that
       * gap becomes the baseline this extraction can never beat — "Parsing…"
       * forever. The narrowest window is the one between here and `start`. */
      const polledAtBeforeUpload = polledAtRef.current
      const { sourceId } = await start({
        kind,
        storageId: storageId as Id<"_storage">,
        ...(kind === "syllabus" && row.courseId
          ? { courseId: row.courseId as Id<"courses"> }
          : {}),
        filename: row.file.name,
      })
      patch(row.id, {
        status: "parsing",
        sourceId,
        // `?? null` covers a brand-new source, which has no poll at all yet.
        polledAtBefore: polledAtBeforeUpload.get(sourceId) ?? null,
      })
    } catch (cause) {
      patch(row.id, { status: "error", error: errorMessage(cause) })
    }
  }

  const onUploadAll = async () => {
    setBusy(true)
    // Sequential on purpose: each upload schedules a model call, and firing six
    // at once is six concurrent extractions for no perceptible gain.
    for (const row of rows.filter((r) => r.status === "queued" || r.status === "error")) {
      await upload(row)
    }
    setBusy(false)
    if (inputRef.current) inputRef.current.value = ""
  }

  const queued = rows.filter((r) => r.status === "queued" || r.status === "error").length
  const activeCourses = (courses ?? []).filter((c) => c.status === "active")

  return (
    <Card>
      <FieldRow
        label={kind === "syllabus" ? "Syllabus files" : "Class schedule"}
        hint={
          kind === "syllabus"
            ? "PDF, Word or an exported page — one per course, or all at once"
            : "the one file with your weekly class times"
        }
        htmlFor={`upload-${kind}`}
      >
        <input
          id={`upload-${kind}`}
          ref={inputRef}
          type="file"
          multiple={kind === "syllabus"}
          onChange={(e) => onPick(e.target.files)}
          className="max-w-[14rem] text-[12px] text-ink-2 file:mr-2 file:h-7 file:rounded-full file:border-0 file:bg-inset file:px-2.5 file:text-[12px] file:text-ink file:shadow-hairline"
        />
      </FieldRow>

      {rows.length > 0 && (
        <>
          <Divider />
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex min-h-11 flex-wrap items-center gap-2 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                  {row.file.name}
                </span>
                {kind === "syllabus" && row.status === "queued" && (
                  <SelectField
                    aria-label={`Course for ${row.file.name}`}
                    value={row.courseId}
                    onChange={(e) => patch(row.id, { courseId: e.target.value })}
                  >
                    <option value="">Unassigned</option>
                    {activeCourses.map((c) => (
                      <option key={c._id} value={c._id}>
                        {c.code}
                      </option>
                    ))}
                  </SelectField>
                )}
                <UploadStatus
                  row={row}
                  parsed={
                    row.sourceId !== undefined &&
                    (polledAtById.get(row.sourceId) ?? null) !== null &&
                    polledAtById.get(row.sourceId) !== row.polledAtBefore
                  }
                />
              </li>
            ))}
          </ul>
          <Divider />
          <CardNote>
            {kind === "syllabus"
              ? "Leave a file unassigned if you don't have the course yet — the parse proposes one, and it shows up in your change feed with the deadlines it found."
              : "The parse becomes your hard class blocks: the planner never puts work on top of one."}
          </CardNote>
        </>
      )}

      <Divider />
      <SaveBar
        dirty={queued > 0}
        saving={busy}
        label={queued > 1 ? `Upload ${queued} files` : "Upload"}
        note={
          rows.length === 0
            ? "Nothing selected yet."
            : "Each upload becomes a source; its deadlines arrive as one card in the change feed."
        }
        onSave={() => void onUploadAll()}
      />
    </Card>
  )
}

function UploadStatus({ row, parsed }: { row: UploadRow; parsed: boolean }) {
  if (row.status === "error") {
    return (
      <span className="text-[12px] text-red">{row.error ?? "upload failed"}</span>
    )
  }
  if (row.status === "uploading") {
    return <span className="text-[12px] text-ink-3">Uploading…</span>
  }
  if (row.status === "parsing") {
    return parsed ? (
      <StatusPill tone="green">Parsed</StatusPill>
    ) : (
      <span className="text-[12px] text-ink-3">Parsing…</span>
    )
  }
  return <span className="text-[12px] text-ink-3">Ready</span>
}

/* ── the panel ──────────────────────────────────────────────────────────── */

export function ConnectorsView() {
  const sources = useSources()
  const courses = useCourses()
  /* `never_synced` is a one-time upload, not a problem — counting it would
   * contradict the neutral "One-time upload" pill on the card itself. */
  const unhealthy =
    sources?.filter((s) => s.health === "degraded" || s.health === "failing")
      .length ?? 0

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
          <SectionHeader
            title="Add a source"
            hint="a feed that keeps itself current"
          />
          <AddCanvas />
          <AddIcal />
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Upload documents"
            hint="the parts nobody publishes as a feed"
          />
          <UploadSection kind="syllabus" courses={courses} sources={sources} />
          <UploadSection kind="schedule" courses={courses} sources={sources} />
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
