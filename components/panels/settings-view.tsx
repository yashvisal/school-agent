"use client"

import * as React from "react"
import { useUser } from "@clerk/nextjs"
import { useMutation } from "convex/react"

import { SegmentedControl } from "@/components/harness/atoms/SegmentedControl"
import { StatusPill } from "@/components/harness/atoms/StatusPill"
import { TextRow } from "@/components/harness/atoms/TextRow"
import {
  Card,
  CardNote,
  Divider,
  FieldRow,
  SaveBar,
  SelectField,
  TextField,
  useDraft,
} from "@/components/panels/form"
import { SectionHeader, ViewportBody, ViewportHeader } from "@/components/panels/chrome"
import { api } from "@/convex/_generated/api"
import { errorMessage } from "@/lib/errors"
import { useViewer } from "@/lib/data/hooks"
import type { Viewer } from "@/lib/data/types"

/**
 * Settings — the account and schedule the student owns, written through
 * `api.students.updatePrefs` (which proposes a `manual`-origin change and
 * approves it in the same mutation: the tap IS the approval, core.md
 * "Approval channels" rule 1). Nothing here is local state pretending to be
 * saved, and nothing here writes outside `changes`.
 *
 * One Save per section, each sending only the fields that actually moved:
 * `updatePrefs` returns `changed: []` and writes no change row when nothing
 * did, and a feed full of empty edits is worse than no feed.
 */

/* ── the value sets the form offers ─────────────────────────────────────── */

const CHECK_INS = [
  { value: "fewer", label: "Fewer" },
  { value: "normal", label: "Normal" },
  { value: "more", label: "More" },
] as const

type CheckIn = (typeof CHECK_INS)[number]["value"]
type CheckInLabel = (typeof CHECK_INS)[number]["label"]

const CHECK_IN_LABELS = CHECK_INS.map((c) => c.label) as readonly CheckInLabel[]
const CHECK_IN_BY_LABEL = new Map<CheckInLabel, CheckIn>(
  CHECK_INS.map((c) => [c.label, c.value])
)
const CHECK_IN_BY_VALUE = new Map<CheckIn, CheckInLabel>(
  CHECK_INS.map((c) => [c.value, c.label])
)

/**
 * The morning push runs at the student's local hour and plans *that* day
 * (core.md: `morningHourLocal`, default 7). Anything before 5am is the middle
 * of the night and anything after 10am is past the first class of the day, so
 * the select is the honest range rather than all 24.
 */
const MORNING_HOURS = [5, 6, 7, 8, 9, 10] as const
const DEFAULT_MORNING_HOUR = 7

/** The US zones a first pilot actually lives in; the detected one is added. */
const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
]

/** 0 = Sunday, matching `timeBlockV.dayOfWeek`. */
const DAYS = [
  { key: "Mon", dayOfWeek: 1 },
  { key: "Tue", dayOfWeek: 2 },
  { key: "Wed", dayOfWeek: 3 },
  { key: "Thu", dayOfWeek: 4 },
  { key: "Fri", dayOfWeek: 5 },
  { key: "Sat", dayOfWeek: 6 },
  { key: "Sun", dayOfWeek: 0 },
] as const

/**
 * One default block per toggled day. This is a *placeholder shape*, not the
 * editor: the real availability editor is a weekly grid the student drags
 * (face.md M2), and until it exists a day toggled on means "generally free in
 * the evening" on a weekday and "generally free in the daytime" at the weekend.
 * Saving from this form therefore REBUILDS `availability.weekly` from the
 * toggles — a richer grid set elsewhere would be flattened, which is acceptable
 * only because nothing else writes one yet.
 */
const WEEKDAY_BLOCK = { startMin: 18 * 60, endMin: 22 * 60 }
const WEEKEND_BLOCK = { startMin: 10 * 60, endMin: 18 * 60 }

const blockFor = (dayOfWeek: number) =>
  dayOfWeek === 0 || dayOfWeek === 6 ? WEEKEND_BLOCK : WEEKDAY_BLOCK

/* ── small formatters ───────────────────────────────────────────────────── */

function hourLabel(hour: number): string {
  const suffix = hour < 12 ? "am" : "pm"
  const h = hour % 12 === 0 ? 12 : hour % 12
  return `${h}:00${suffix}`
}

/** "New York" out of "America/New_York" — the zone id is still the value. */
const zoneLabel = (zone: string) => zone.split("/").pop()!.replace(/_/g, " ")

/**
 * E.164 is what Photon hands Core and what the trigger route demands, so the
 * form validates the same shape Core does rather than letting a friendly-looking
 * number fail server-side. A bare 10-digit US number is the one convenience:
 * everyone types it, and assuming +1 for it is unambiguous.
 */
const E164 = /^\+[1-9]\d{6,14}$/

function normalizePhoneInput(raw: string): string {
  const trimmed = raw.trim()
  const digits = trimmed.replace(/[^\d]/g, "")
  if (trimmed.startsWith("+")) return `+${digits}`
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`
  return digits ? `+${digits}` : ""
}

const PHONE_HELP =
  "Use the full number with a country code, like +19195550123 — that's the form the texting line needs."

/* ── the panel ──────────────────────────────────────────────────────────── */

export function SettingsView() {
  const viewer = useViewer()

  return (
    <>
      <ViewportHeader
        title="Settings"
        meta={viewer === undefined ? undefined : viewer === null ? "setting up…" : undefined}
      />
      <ViewportBody>
        <ThreadSection viewer={viewer} />
        <AvailabilitySection viewer={viewer} />
        <TermSection viewer={viewer} />
        <AccountSection viewer={viewer} />
      </ViewportBody>
    </>
  )
}

/** Shared save plumbing: in-flight flag, the error Core returned, a result note. */
function useUpdatePrefs() {
  const updatePrefs = useMutation(api.students.updatePrefs)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const save = React.useCallback(
    async (
      args: Parameters<typeof updatePrefs>[0],
      onDone?: (changed: string[]) => string | null
    ) => {
      setSaving(true)
      setError(null)
      setNote(null)
      try {
        const result = await updatePrefs(args)
        setNote(
          onDone?.(result.changed) ??
            (result.changed.length === 0 ? "Nothing changed." : "Saved.")
        )
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setSaving(false)
      }
    },
    [updatePrefs]
  )

  return { save, saving, error, note, setError }
}

/* ── the thread: phone, check-ins, morning hour ─────────────────────────── */

function ThreadSection({ viewer }: { viewer: Viewer | undefined }) {
  const { save, saving, error, note, setError } = useUpdatePrefs()

  const [phone, setPhone] = useDraft(viewer?.phone ?? "")
  const [checkIn, setCheckIn] = useDraft<CheckIn>(
    viewer?.checkInPreference ?? "normal"
  )
  const [hour, setHour] = useDraft(viewer?.morningHourLocal ?? DEFAULT_MORNING_HOUR)

  const normalizedPhone = normalizePhoneInput(phone)
  const phoneMoved = normalizedPhone !== (viewer?.phone ?? "")
  const dirty =
    phoneMoved ||
    checkIn !== (viewer?.checkInPreference ?? "normal") ||
    hour !== (viewer?.morningHourLocal ?? DEFAULT_MORNING_HOUR)

  const onSave = () => {
    if (phoneMoved && !E164.test(normalizedPhone)) {
      setError(PHONE_HELP)
      return
    }
    void save({
      ...(phoneMoved ? { phone: normalizedPhone } : {}),
      ...(checkIn !== (viewer?.checkInPreference ?? "normal")
        ? { checkInPreference: checkIn }
        : {}),
      ...(hour !== (viewer?.morningHourLocal ?? DEFAULT_MORNING_HOUR)
        ? { morningHourLocal: hour }
        : {}),
    })
  }

  /* Re-saving the SAME number is a no-op in Core (`updatePrefs` returns early
   * when nothing moved, so nothing re-schedules `registerContact`). The retry
   * therefore has to be an actual edit — say so instead of offering a button
   * that quietly does nothing. Noted for Core in the PR. */
  const registration = viewer?.photonRegistration

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="The thread" hint="how the daily text behaves" />
      <Card>
        <FieldRow
          label="Phone"
          hint="where the morning text lands"
          htmlFor="settings-phone"
        >
          <TextField
            id="settings-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+19195550123"
            aria-label="Phone number"
            className="w-48 text-right"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </FieldRow>
        <RegistrationNote
          registration={registration}
          hasPhone={Boolean(viewer?.phone)}
          pendingEdit={phoneMoved}
        />
        <Divider />
        <FieldRow label="Check-ins" hint="how often Voice reaches out beyond the morning">
          <SegmentedControl
            options={CHECK_IN_LABELS}
            value={CHECK_IN_BY_VALUE.get(checkIn) ?? "Normal"}
            onChange={(label) => setCheckIn(CHECK_IN_BY_LABEL.get(label) ?? "normal")}
          />
        </FieldRow>
        <Divider />
        <FieldRow
          label="Morning text arrives at"
          hint="your local time — the plan is built for that same day"
          htmlFor="settings-morning-hour"
        >
          <SelectField
            id="settings-morning-hour"
            value={String(hour)}
            onChange={(e) => setHour(Number(e.target.value))}
          >
            {MORNING_HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
            {/* A value set elsewhere (a seed, a cron test) must still show. */}
            {!MORNING_HOURS.includes(hour as (typeof MORNING_HOURS)[number]) && (
              <option value={hour}>{hourLabel(hour)}</option>
            )}
          </SelectField>
        </FieldRow>
        <Divider />
        <SaveBar
          dirty={dirty}
          saving={saving}
          error={error}
          note={note}
          onSave={onSave}
        />
      </Card>
    </section>
  )
}

/**
 * A shared texting line can only message a number Photon knows, so saving a
 * phone schedules its registration and the outcome lands back on the student
 * row a moment later (lib/data/README.md "photonRegistration"). `skipped` means
 * this deployment has no Voice attached — say nothing rather than alarm.
 */
function RegistrationNote({
  registration,
  hasPhone,
  pendingEdit,
}: {
  registration: NonNullable<Viewer>["photonRegistration"] | undefined
  hasPhone: boolean
  pendingEdit: boolean
}) {
  if (!hasPhone && !registration) return null
  if (pendingEdit) {
    return (
      <p className="pb-2.5 text-[12.5px] leading-relaxed text-ink-3">
        Save to register this number with the texting line.
      </p>
    )
  }
  if (!registration) {
    return (
      <p className="pb-2.5 text-[12.5px] leading-relaxed text-ink-3">
        Registering…
      </p>
    )
  }
  if (registration.status === "skipped") return null
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2.5">
      {registration.status === "registered" ? (
        <>
          <StatusPill tone="green">Registered</StatusPill>
          <span className="text-[12.5px] text-ink-2">
            We can text this number.
          </span>
        </>
      ) : (
        <>
          <StatusPill tone="red">Not registered</StatusPill>
          <span className="text-[12.5px] leading-relaxed text-ink-2">
            Couldn&apos;t register: {registration.error ?? "unknown error"}.
            Correct the number and save again to retry.
          </span>
        </>
      )}
    </div>
  )
}

/* ── availability ───────────────────────────────────────────────────────── */

function AvailabilitySection({ viewer }: { viewer: Viewer | undefined }) {
  const { save, saving, error, note } = useUpdatePrefs()

  const serverDays = React.useMemo(() => {
    const weekly = viewer?.availability.weekly ?? []
    return DAYS.map((d) => weekly.some((b) => b.dayOfWeek === d.dayOfWeek))
  }, [viewer])

  const [days, setDays] = useDraft(serverDays)
  const dirty = days.some((on, i) => on !== serverDays[i])

  const onSave = () => {
    const weekly = DAYS.filter((_, i) => days[i]).map((d) => ({
      dayOfWeek: d.dayOfWeek,
      ...blockFor(d.dayOfWeek),
    }))
    void save({
      availability: {
        weekly,
        // Exceptions are per-date and come from the thread ("I'm away this
        // weekend"), not from this grid — carry them through untouched.
        exceptions: viewer?.availability.exceptions ?? [],
      },
    })
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Availability"
        hint="the days you're generally free to work"
      />
      <Card>
        <FieldRow
          label="Free days"
          hint="evenings on a weekday, daytime at the weekend"
        >
          <span className="flex flex-wrap items-center gap-1">
            {DAYS.map((day, i) => (
              <button
                key={day.key}
                type="button"
                aria-pressed={days[i]}
                onClick={() =>
                  setDays((current) =>
                    current.map((on, j) => (j === i ? !on : on))
                  )
                }
                className={`inline-flex h-7 w-9 items-center justify-center rounded-full text-[12px] font-medium transition-colors duration-100 ${
                  days[i]
                    ? "bg-ink text-canvas"
                    : "bg-inset text-ink-3 shadow-hairline hover:text-ink-2"
                }`}
              >
                {day.key}
              </button>
            ))}
          </span>
        </FieldRow>
        <Divider />
        <TextRow
          label="Class blocks"
          value={`${viewer?.classBlocks.length ?? 0} hard block${
            (viewer?.classBlocks.length ?? 0) === 1 ? "" : "s"
          }`}
          meta="from your schedule upload"
        />
        <Divider />
        <CardNote>
          Class blocks are boundaries, not preferences — the planner will never
          put work on top of one. Availability is the softer layer, and it gets
          corrected by what actually happens. A day toggled on becomes one
          block: 6–10pm on a weekday, 10am–6pm at the weekend. The editor that
          lets you draw the real week comes later.
        </CardNote>
        <Divider />
        <SaveBar
          dirty={dirty}
          saving={saving}
          error={error}
          note={note}
          onSave={onSave}
        />
      </Card>
    </section>
  )
}

/* ── term and timezone ──────────────────────────────────────────────────── */

function TermSection({ viewer }: { viewer: Viewer | undefined }) {
  const { save, saving, error, note } = useUpdatePrefs()

  const detected = React.useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  )
  const serverZone = viewer?.timezone ?? detected
  const zones = React.useMemo(() => {
    const set = new Set(COMMON_TIMEZONES)
    set.add(detected)
    set.add(serverZone)
    return [...set]
  }, [detected, serverZone])

  const [zone, setZone] = useDraft(serverZone)
  const [start, setStart] = useDraft(viewer?.semesterStart ?? "")
  const [end, setEnd] = useDraft(viewer?.semesterEnd ?? "")

  const dirty =
    zone !== serverZone ||
    start !== (viewer?.semesterStart ?? "") ||
    end !== (viewer?.semesterEnd ?? "")

  const onSave = () => {
    void save({
      ...(zone !== serverZone ? { timezone: zone } : {}),
      ...(start && start !== (viewer?.semesterStart ?? "")
        ? { semesterStart: start }
        : {}),
      ...(end && end !== (viewer?.semesterEnd ?? "") ? { semesterEnd: end } : {}),
    })
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Term"
        hint="the window everything is planned inside"
      />
      <Card>
        <FieldRow
          label="Timezone"
          hint={zone === detected ? "matches this browser" : `this browser says ${zoneLabel(detected)}`}
          htmlFor="settings-timezone"
        >
          <SelectField
            id="settings-timezone"
            value={zone}
            onChange={(e) => setZone(e.target.value)}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {zoneLabel(z)}
              </option>
            ))}
          </SelectField>
        </FieldRow>
        <Divider />
        <FieldRow label="Semester starts" htmlFor="settings-semester-start">
          <TextField
            id="settings-semester-start"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </FieldRow>
        <Divider />
        <FieldRow label="Semester ends" htmlFor="settings-semester-end">
          <TextField
            id="settings-semester-end"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </FieldRow>
        <Divider />
        <SaveBar
          dirty={dirty}
          saving={saving}
          error={error}
          note={note}
          onSave={onSave}
        />
      </Card>
    </section>
  )
}

/* ── account ────────────────────────────────────────────────────────────── */

function AccountSection({ viewer }: { viewer: Viewer | undefined }) {
  const { user, isLoaded } = useUser()

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="Account" hint="the identity everything is scoped to" />
      <Card>
        <TextRow
          label="Email"
          value={
            !isLoaded
              ? "…"
              : (user?.primaryEmailAddress?.emailAddress ?? "no email on file")
          }
        />
        <Divider />
        <TextRow
          label="Student"
          value={
            viewer === undefined
              ? "…"
              : viewer === null
                ? "not provisioned yet"
                : viewer._id
          }
        />
      </Card>
    </section>
  )
}
