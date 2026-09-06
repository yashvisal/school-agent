"use client"

import * as React from "react"
import { useConvexAuth, useMutation } from "convex/react"

import { Button } from "@/components/harness/atoms/Button"
import { api } from "@/convex/_generated/api"
import { errorMessage } from "@/lib/errors"
import { useViewer } from "@/lib/data/hooks"

/**
 * Provisioning — the one write the app makes on its own behalf.
 *
 * Every identity-scoped query returns `[]` and every upload mutation throws
 * `404: no student row` until `students.ensure` has run once for a Clerk
 * identity, and nothing else in the product calls it (roadmap: "Student
 * provisioning — missing"). So the shell calls it: signed in, Convex agrees we
 * are signed in, and `api.auth.viewer` came back `null` — that triple means a
 * real identity with no row, which is exactly the case `ensure` fixes.
 *
 * The browser's IANA zone is passed because it is the best guess anyone has at
 * first sign-in and `ensure` treats it as an upsert; Settings overrides it the
 * moment the student says otherwise.
 *
 * Renders nothing. It is mounted inside the signed-in branch of the shell so
 * its hooks only run for a signed-in user.
 */
export function EnsureStudent() {
  const { isAuthenticated } = useConvexAuth()
  const viewer = useViewer()
  const ensure = useMutation(api.students.ensure)
  /* A ref, not state: the guard must flip in the same tick the effect fires,
   * or a re-render between the call and its subscription update provisions
   * twice. `ensure` is idempotent, but a duplicate call is still a duplicate
   * request on every cold load. It is released again on failure so the button
   * below — and any later render — can genuinely try again; what it prevents
   * is a retry LOOP, not a retry. */
  const called = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)
  const [retrying, setRetrying] = React.useState(false)

  const provision = React.useCallback(async () => {
    called.current = true
    try {
      await ensure({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      setError(null)
    } catch (cause) {
      called.current = false
      setError(errorMessage(cause))
    }
  }, [ensure])

  React.useEffect(() => {
    // `undefined` is "still loading" — only `null` means provably no row.
    if (!isAuthenticated || viewer !== null || called.current) return
    void provision()
  }, [isAuthenticated, viewer, provision])

  const onRetry = async () => {
    setRetrying(true)
    await provision()
    setRetrying(false)
  }

  if (!error) return null
  /* Silent failure here means every page looks like an empty semester, which
   * is indistinguishable from a new account with no sources. Say so, and offer
   * the retry in place rather than making a reload the only way out. */
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center px-3"
    >
      <div className="pointer-events-auto flex max-w-md items-center gap-3 rounded-card bg-surface px-3 py-2 shadow-card">
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
          Couldn&apos;t set up your account: {error}. Until it succeeds, every
          page will look empty.
        </p>
        <Button
          size="xs"
          variant="secondary"
          disabled={retrying}
          onClick={() => void onRetry()}
        >
          {retrying ? "Trying…" : "Try again"}
        </Button>
      </div>
    </div>
  )
}
