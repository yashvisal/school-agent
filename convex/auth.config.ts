import type { AuthConfig } from "convex/server"

// Clerk issuer (Frontend API URL). Set CLERK_JWT_ISSUER_DOMAIN on each Convex
// deployment (dev + prod) — see plans/vision.md §10 and docs.convex.dev/auth/clerk.
// applicationID must match the `aud` claim of Clerk's "convex" JWT template.
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig
