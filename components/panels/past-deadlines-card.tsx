"use client"

import * as React from "react"
import { useMutation } from "convex/react"

import { Button } from "@/components/harness/atoms/Button"
import { api } from "@/convex/_generated/api"
import { errorMessage } from "@/lib/errors"
import { usePastDeadlineReview, useViewer } from "@/lib/data/hooks"

/**
 * The one mid-semester question (vision §3.6, core.md "Mid-semester
 * onboarding"). A student joining in week 7 has a backlog of past-due work
 * that no source can settle — paper homework, in-class quizzes, half-used
 * Canvas courses — and planning around it as open work poisons every feasible
 * set. Asking one by one is the Notion-template death, so this is one card,
 * two buttons, resolved in bulk.
 *
 * It disappears the moment the count is zero, which is the subscription's job:
 * `resolvePastDeadlines` writes each row through `changes` and the query stops
 * returning them.
 */

/** `resolvePastDeadlines` takes at most 200 ids per call. */
const BATCH = 200

export function PastDeadlinesCard() {
  const viewer = useViewer()
  const review = usePastDeadlineReview()
  const resolve = useMutation(api.onboarding.resolvePastDeadlines)
  const [saving, setSaving] = React.useState<"done" | "missed" | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  if (!viewer || !review || review.count === 0) return null

  const settle = async (as: "done" | "missed") => {
    setSaving(as)
    setError(null)
    try {
      // A deep backlog is more than one call's worth; walk it rather than
      // silently settling the first 200 and leaving the card sitting there.
      for (let i = 0; i < review.deadlineIds.length; i += BATCH) {
        await resolve({
          studentId: viewer._id,
          deadlineIds: review.deadlineIds.slice(i, i + BATCH),
          as,
        })
      }
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card">
      <div className="flex flex-col gap-1 px-3.5 py-3">
        <p className="text-[13px] text-ink">
          {review.count} deadline{review.count === 1 ? "" : "s"} before today
          {review.count === 1 ? " has" : " have"} no submission on record.
          Assume {review.count === 1 ? "it's" : "they're"} done?
        </p>
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          Canvas already answered for anything submitted through it. These are
          the rest — paper homework, in-class work, courses that never used the
          LMS. Either answer keeps them out of the plan; only &ldquo;done&rdquo;
          records them as handed in.
        </p>
        {error && <p className="text-[12.5px] text-red">{error}</p>}
      </div>
      <div className="primitive-card-footer flex min-h-11 items-center gap-1.5 border-t border-line">
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="xs"
            variant="quiet"
            disabled={saving !== null}
            onClick={() => void settle("missed")}
          >
            {saving === "missed" ? "Marking…" : "Mark all missed"}
          </Button>
          <Button
            size="xs"
            variant="primary"
            disabled={saving !== null}
            onClick={() => void settle("done")}
          >
            {saving === "done" ? "Marking…" : "Mark all done"}
          </Button>
        </span>
      </div>
    </section>
  )
}
