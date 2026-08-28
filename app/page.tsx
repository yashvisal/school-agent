"use client"

import { useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"

export default function Page() {
  const viewer = useQuery(api.auth.viewer)

  return (
    <div className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-4 text-sm leading-loose">
        <div>
          <h1 className="font-medium">school-agent</h1>
          <p className="text-muted-foreground">
            Clerk ↔ Convex auth smoke test. Sign in above; Convex should report
            your identity below.
          </p>
        </div>
        <pre className="rounded-md border bg-muted p-3 font-mono text-xs">
          {viewer === undefined
            ? "loading…"
            : viewer === null
              ? "signed out (Convex sees no identity)"
              : JSON.stringify(viewer, null, 2)}
        </pre>
        <div className="font-mono text-xs text-muted-foreground">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
      </div>
    </div>
  )
}
