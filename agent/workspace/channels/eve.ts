import { localDev, vercelOidc } from "eve/channels/auth"
import { eveChannel } from "eve/channels/eve"

/**
 * Route auth for /eve/v1/*.
 *
 * Fail-closed today: `vercelOidc()` admits our own deployments and the local
 * CLI, `localDev()` admits `eve dev` / `next dev`. Neither admits a browser
 * user, so production browser traffic gets 401 — correct until Clerk is wired.
 *
 * TODO(face): add a Clerk session verifier as the first entry — verify the
 * `convex` JWT template against CLERK_JWT_ISSUER_DOMAIN and map the Clerk user
 * to the principal, so `ctx.session.auth.current` identifies the student that
 * `hydrateWorkspace` hydrates for. Until then the workspace agent is dev-only.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev()],
})
