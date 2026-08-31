#!/usr/bin/env node
/**
 * Fire the external morning trigger — Spike A kill criterion 1.
 *
 *   node agent/voice/scripts/trigger.mjs [--phone +1...] [--kind morning|checkin] [--date YYYY-MM-DD]
 *
 * Stands in for the Convex cron that will POST this per student.
 */
import { loadEnv } from "./lib-env.mjs"

loadEnv()

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const base = arg("base", process.env.VOICE_BASE_URL ?? "http://localhost:3002")
const url = `${base.replace(/\/$/, "")}${arg("path", "/eve/agents/voice/eve/v1/trigger")}`
const secret = process.env.VOICE_TRIGGER_SECRET
if (!secret) {
  console.error("VOICE_TRIGGER_SECRET is not set in .env.local")
  process.exit(1)
}

const phone = arg("phone", process.env.VOICE_DEMO_PHONE)
if (!phone) {
  console.error("Set VOICE_DEMO_PHONE in .env.local, or pass --phone +1...")
  process.exit(1)
}

const body = {
  phone,
  operationId: arg("operationId", `op_${Date.now()}`),
  kind: arg("kind", "morning"),
}
// `date` is required and must be the STUDENT's local calendar day (the Convex
// cron computes this per student; here we stand in for it with the demo
// student's timezone from fixtures/student-demo.json).
const tz = "America/New_York"
body.date = arg("date", new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()))

const startedAt = Date.now()
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-voice-trigger-secret": secret },
  body: JSON.stringify(body),
})
const text = await res.text()
console.log(`POST ${url}`)
console.log(`  -> ${res.status} in ${Date.now() - startedAt}ms`)
console.log(`  ${text}`)
process.exit(res.ok ? 0 : 1)
