import { v } from "convex/values"

import { query } from "./_generated/server"
import { getCurrentStudent } from "./lib/auth"
import { studentDocV } from "./lib/validators"

/**
 * The signed-in student's row, or null when signed out *or* not yet provisioned
 * (call `api.students.ensure` to create it). Doubles as the Clerk ↔ Convex auth
 * smoke test: a null here with a signed-in user means the JWT template or
 * `convex/auth.config.ts` is misconfigured.
 */
export const viewer = query({
  args: {},
  returns: v.union(v.null(), studentDocV),
  handler: async (ctx) => await getCurrentStudent(ctx),
})
