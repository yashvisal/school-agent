"use client"

import * as React from "react"

/**
 * Which chats are open as tabs in a course viewport.
 *
 * This is **UI state, not truth** (vision §10: nothing durable about a student
 * lives outside Convex). Which chats *exist* comes from `useCourseChats`; which
 * ones you happen to have open is a property of this browser tab, so it lives
 * in `sessionStorage`, keyed by course. Losing it costs a click.
 */

const KEY_PREFIX = "school-agent:chat-tabs:"

/** A chat id the student just created. Fixtures don't know it; that's fine. */
export function newChatId(): string {
  return `chat_new_${Date.now().toString(36)}`
}

/** New chats have no stored title until Core has a `chats` table. */
export function isNewChatId(chatId: string): boolean {
  return chatId.startsWith("chat_new_")
}

function parse(raw: string | null): string[] {
  if (!raw) return EMPTY
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY
    const ids = parsed.filter((id): id is string => typeof id === "string")
    return ids.length > 0 ? ids : EMPTY
  } catch {
    /* a corrupt store is not worth a broken viewport */
    return EMPTY
  }
}

function read(courseId: string): string[] {
  if (typeof window === "undefined") return EMPTY
  try {
    return parse(window.sessionStorage.getItem(KEY_PREFIX + courseId))
  } catch {
    return EMPTY
  }
}

function write(courseId: string, ids: string[]): void {
  try {
    window.sessionStorage.setItem(KEY_PREFIX + courseId, JSON.stringify(ids))
  } catch {
    /* private mode / quota — the tabs simply don't survive a reload */
  }
}

export type ChatTabs = {
  /** open tab ids, in the order they were opened */
  ids: string[]
  /** open `chatId` if it isn't already open (idempotent) */
  open: (chatId: string) => void
  /**
   * Close `chatId` and report where to go next: the neighbour to the right,
   * else the left, else `null` when nothing is left open.
   */
  close: (chatId: string) => string | null
}

/* sessionStorage is an external store, so it is read through
 * `useSyncExternalStore` rather than mirrored into state: no effect, no
 * cascading render, and the server snapshot is always empty. */

const EMPTY: string[] = []
const listeners = new Set<() => void>()
/** last parsed value per course, so `getSnapshot` stays referentially stable */
const cache = new Map<string, { raw: string | null; value: string[] }>()

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  /* another browser tab writing the same course */
  window.addEventListener("storage", onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onChange)
  }
}

function emit(): void {
  for (const listener of listeners) listener()
}

function snapshot(courseId: string): string[] {
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(KEY_PREFIX + courseId)
  } catch {
    return EMPTY
  }
  const cached = cache.get(courseId)
  if (cached && cached.raw === raw) return cached.value
  const value = parse(raw)
  cache.set(courseId, { raw, value })
  return value
}

export function useChatTabs(courseId: string): ChatTabs {
  const ids = React.useSyncExternalStore(
    subscribe,
    React.useCallback(() => snapshot(courseId), [courseId]),
    () => EMPTY
  )

  const open = React.useCallback(
    (chatId: string) => {
      const current = read(courseId)
      if (current.includes(chatId)) return
      write(courseId, [...current, chatId])
      emit()
    },
    [courseId]
  )

  const close = React.useCallback(
    (chatId: string): string | null => {
      const current = read(courseId)
      const index = current.indexOf(chatId)
      const next = current.filter((id) => id !== chatId)
      write(courseId, next)
      emit()
      if (next.length === 0) return null
      return next[Math.min(index, next.length - 1)] ?? null
    },
    [courseId]
  )

  return { ids, open, close }
}
