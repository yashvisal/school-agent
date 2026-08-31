"use client"

/**
 * Artifact-scoped chat for a course workspace.
 *
 * TODO: **Spike B glue mounts here.** Another agent replaces this body with the
 * `useEveAgent()` stream from `eve/react` and a reducer that maps `EveMessage`
 * parts onto the harness primitives (`dynamic-tool` → tool chips / approval
 * cards / diff tables by `toolName`; `text`/`reasoning` → StreamingText /
 * ThinkingState). See face.md "Agent streaming into the harness" and Spike B.
 *
 * Keep the props minimal — `{ courseId }` is all the glue should need; the
 * session is one student × one course and is hydrated server-side.
 */
export function ChatRail({ courseId }: { courseId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 p-4">
      <div className="rounded-card bg-surface px-3.5 py-3 shadow-card">
        <p className="text-[13px] text-ink">
          Chat opens when there&apos;s something in the viewport to talk about.
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          This is workspace chat, not planning chat — &ldquo;explain problem 3&rdquo;,
          &ldquo;what does the syllabus say about late work&rdquo;. What to do and
          when stays in the thread.
        </p>
      </div>
      <span className="sr-only">course {courseId}</span>
    </div>
  )
}
