"use client"

import * as React from "react"

import { Button } from "@/components/harness/atoms/Button"

/**
 * The form grammar for Settings and Connectors, in the harness's existing
 * vocabulary — `rounded-card bg-surface shadow-card` cards, hairline dividers,
 * `bg-field` controls — factored out so the two panels that grew forms in the
 * same week do not each invent their own row height and input styling.
 *
 * Nothing here is a new visual primitive: every class is one the panels were
 * already using inline (`components/panels/settings-view.tsx` before this
 * change). The values are settled, so there are no dials on them.
 *
 * One geometry constant, used everywhere: controls are `h-8`, rows are
 * `min-h-11`, and inputs are 16px on mobile because below that Safari zooms the
 * viewport on focus and never zooms back out.
 */

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-card bg-surface px-3.5 shadow-card ${className}`}>
      {children}
    </div>
  )
}

export function Divider() {
  return <div className="h-px bg-line" />
}

/** Label on the left, a control on the right — the shape of every settings row. */
export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: React.ReactNode
  hint?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-2">
      <label htmlFor={htmlFor} className="flex min-w-0 flex-col">
        <span className="text-sm text-ink-2">{label}</span>
        {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
      </label>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  )
}

const controlClass =
  "h-8 rounded-control bg-field px-2.5 text-[16px] text-ink shadow-hairline outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)] sm:text-[13px]"

export function TextField({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${controlClass} ${className}`} />
}

export function SelectField({
  className = "",
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${controlClass} pr-1.5 ${className}`}>
      {children}
    </select>
  )
}

/**
 * The bottom of a form: the error Core returned (verbatim), then the action.
 * `dirty` drives `disabled` — a Save that is always enabled teaches the student
 * that pressing it means nothing.
 */
export function SaveBar({
  dirty,
  saving,
  error,
  note,
  label = "Save",
  onSave,
}: {
  dirty: boolean
  saving: boolean
  error?: string | null
  note?: React.ReactNode
  label?: string
  onSave: () => void
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 py-2">
      <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
        {error ? <span className="text-red">{error}</span> : note}
      </span>
      <Button
        size="xs"
        variant="primary"
        disabled={!dirty || saving}
        onClick={onSave}
      >
        {saving ? "Saving…" : label}
      </Button>
    </div>
  )
}

/** A quiet explanatory paragraph inside a card. */
export function CardNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-2.5 text-[12.5px] leading-relaxed text-ink-2">{children}</p>
  )
}

/**
 * Local draft state that re-syncs when the *server* value changes and only
 * then — so another section's save (which updates the whole viewer row) never
 * clobbers what the student is currently typing in this one.
 */
export function useDraft<T>(server: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [draft, setDraft] = React.useState<T>(server)
  const key = JSON.stringify(server ?? null)
  const seen = React.useRef(key)
  React.useEffect(() => {
    if (seen.current === key) return
    seen.current = key
    setDraft(server)
    // `server` is intentionally compared by value through `key`: it is a fresh
    // object on every render of a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return [draft, setDraft]
}
