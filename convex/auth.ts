import { v } from "convex/values"
import { query } from "./_generated/server"

/**
 * Smoke test for Clerk ↔ Convex auth: returns the identity Convex sees from the
 * Clerk "convex" JWT, or null when signed out. Replace with real student lookup
 * once the schema lands (plans/core.md).
 */
export const viewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      subject: v.string(),
      issuer: v.string(),
      name: v.optional(v.string()),
      email: v.optional(v.string()),
    })
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) return null
    return {
      subject: identity.subject,
      issuer: identity.issuer,
      name: identity.name,
      email: identity.email,
    }
  },
})
