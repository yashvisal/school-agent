"use client"

import { useSyncExternalStore } from "react"
import { useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"
import * as fixtures from "./fixtures"
import type {
  Change,
  Course,
  Deadline,
  Source,
  StudentSignal,
  Task,
  Viewer,
} from "./types"

/**
 * The single seam between Face and Core.
 *
 * `useViewer` is already a real Convex subscription. The rest return fixtures
 * today but are *shaped* like Convex subscriptions — `undefined` while loading,
 * then data, never null — so swapping each one to `useQuery` is a one-line
 * change and no panel has to move. Every panel goes through these; nothing
 * imports `fixtures.ts` directly.
 *
 * See `lib/data/README.md` for the queries Core needs to add.
 */

const NO_SUBSCRIBE = () => () => {}

/**
 * Mimics a Convex subscription: `undefined` on the server render (a real
 * subscription has no data yet), then the data once hydrated. Deliberately not
 * a timer or a frame callback — those never fire in a backgrounded tab, and a
 * panel that is stuck "loading" is worse than one that is instantly full.
 */
function useFixture<T>(value: T): T | undefined {
  const hydrated = useSyncExternalStore(
    NO_SUBSCRIBE,
    () => true,
    () => false
  )
  return hydrated ? value : undefined
}

/** Real. The Clerk ↔ Convex identity, or `null` when signed out. */
export function useViewer(): Viewer | undefined {
  return useQuery(api.auth.viewer)
}

// TODO(core): swap for useQuery(api.courses.list) — Core adds the query
export function useCourses(): Course[] | undefined {
  return useFixture(fixtures.courses)
}

// TODO(core): swap for useQuery(api.deadlines.list, { from, to, courseId }) — Core adds the query
export function useDeadlines(): Deadline[] | undefined {
  return useFixture(fixtures.deadlines)
}

// TODO(core): swap for useQuery(api.tasks.list, { from, to, courseId }) — Core adds the query
export function useTasks(): Task[] | undefined {
  return useFixture(fixtures.tasks)
}

// TODO(core): swap for useQuery(api.changes.feed, { status, limit }) — Core adds the query
export function useChanges(): Change[] | undefined {
  return useFixture(fixtures.changes)
}

// TODO(core): swap for useQuery(api.sources.list) — Core adds the query
export function useSources(): Source[] | undefined {
  return useFixture(fixtures.sources)
}

// TODO(core): swap for useQuery(api.signals.recent, { courseId, limit }) — Core adds the query
export function useStudentSignals(): StudentSignal[] | undefined {
  return useFixture(fixtures.studentSignals)
}

/* ── derived helpers (never stored — vision §9 facts vs. inference) ─────── */

export function useCourse(courseId: string): Course | undefined | null {
  const courses = useCourses()
  if (courses === undefined) return undefined
  return courses.find((c) => c._id === courseId) ?? null
}
