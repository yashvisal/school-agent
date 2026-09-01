import { cronJobs } from "convex/server"

import { internal } from "./_generated/api"

/**
 * Scheduled work (core.md, "Nightly precompute"; vision §10 repo shape).
 *
 * Both jobs are hourly-or-faster and idempotent by design, so a missed or
 * duplicated tick is harmless:
 *
 * - The nightly pass fires every hour on the hour and picks out the students
 *   whose *local* clock just struck their nightly hour. One cron covers every
 *   timezone, because the timezone is per-student data rather than deployment
 *   config, and `planRuns.operationId` makes a double tick a no-op.
 * - Canvas has no push API, so polling is the only option; 30 minutes is the
 *   starting cadence from core.md ("start 30 min; back off").
 */
const crons = cronJobs()

crons.cron("nightly plan pass", "0 * * * *", internal.nightly.tick, {})

crons.interval("poll sources", { minutes: 30 }, internal.ingest.pollAll.pollAll, {})

// Inbound-message log TTL (VOICE_TOOLS.md §8b): dedupe rows age out after ~48h;
// the contact-warmed count lives on `students` and survives the prune.
crons.interval("prune inbound log", { hours: 6 }, internal.inbound.prune, {})

export default crons
