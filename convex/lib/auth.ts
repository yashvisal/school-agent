import type { Doc, Id } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"

/**
 * Auth helpers. Identity always comes from `ctx.auth`, never from an argument —
 * a `studentId` arg is a *selector*, and `requireStudent` proves the caller owns it.
 *
 * Clerk's `identity.subject` is the Clerk user id (`user_…`), which is what we
 * store as `students.clerkId` (see `convex/auth.config.ts`, JWT template "convex").
 */

export async function requireIdentity(ctx: QueryCtx | MutationCtx) {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) throw new Error("401: not signed in")
  return identity
}

/** The signed-in student's row, or null if they haven't been provisioned yet. */
export async function getCurrentStudent(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"students"> | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (!identity) return null
  return await ctx.db
    .query("students")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique()
}

/**
 * Loads `studentId` and throws unless it belongs to the signed-in identity.
 * Every public query/mutation that takes a `studentId` must call this first.
 */
export async function requireStudent(
  ctx: QueryCtx | MutationCtx,
  studentId: Id<"students">
): Promise<Doc<"students">> {
  const identity = await requireIdentity(ctx)
  const student = await ctx.db.get("students", studentId)
  if (!student) throw new Error("404: student not found")
  if (student.clerkId !== identity.subject) throw new Error("403: forbidden")
  return student
}
