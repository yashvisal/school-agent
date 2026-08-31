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
const url = `${base.replace(/\/$/, "")}/eve/agents/voice/eve/v1/trigger`
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
const date = arg("date")
if (date) body.date = date

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
