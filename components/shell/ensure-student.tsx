"use client"

import * as React from "react"
import { useConvexAuth, useMutation } from "convex/react"

import { api } from "@/convex/_generated/api"
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
   * request on every cold load. Once per mount, deliberately — a failure is
   * reported and retried on the next load rather than in a loop. */
  const called = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    // `undefined` is "still loading" — only `null` means provably no row.
    if (!isAuthenticated || viewer !== null || called.current) return
    called.current = true
    ensure({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      .then(() => setError(null))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [isAuthenticated, viewer, ensure])

  if (!error) return null
  /* Silent failure here means every page looks like an empty semester, which
   * is indistinguishable from a new account with no sources. Say so. */
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-3 z-50 flex justify-center px-3"
    >
      <p className="pointer-events-auto max-w-md rounded-card bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-ink-2 shadow-card">
        Couldn&apos;t set up your account: {error}. Reload to try again — until
        it succeeds, every page will look empty.
      </p>
    </div>
  )
}
