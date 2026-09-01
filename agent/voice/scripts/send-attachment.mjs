#!/usr/bin/env node
/**
 * Outbound attachments from a stateless context â€” Spike A items 2 and 3.
 *
 *   node agent/voice/scripts/send-attachment.mjs [--phone +1...] [--text-only]
 *
 * Bypasses eve entirely and talks to Photon through the Spectrum SDK, which is
 * the fallback voice.md names ("outbound from a stateless context"). It is also
 * the path a Convex action would take.
 *
 * Generates a 1-page PDF and a small PNG into `.spike/` and sends:
 *   1. a plain text message (deliverability: first message carries no media),
 *   2. the PDF,
 *   3. the PNG.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadEnv } from "./lib-env.mjs"

loadEnv()

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const phone = arg("phone", process.env.VOICE_DEV_PHONE)
if (!phone) {
  console.error("Set VOICE_DEV_PHONE in .env.local, or pass --phone +1...")
  process.exit(1)
}

const spikeDir = join(dirname(fileURLToPath(import.meta.url)), "..", ".spike")
mkdirSync(spikeDir, { recursive: true })

/** Hand-written single-page PDF â€” no dependency, ~700 bytes. */
function buildPdf(line) {
  const stream = `BT /F1 14 Tf 60 720 Td (${line.replace(/[()\\]/g, "")}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = []
  for (const [i, body] of objects.entries()) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, "latin1")
}

/** 8x8 solid PNG, base64 literal. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKUlEQVR42mNkYPhfz0AEYBxVSF+F" +
  "jIyM/xkYGP4zMjIyMDAwMDAwMAAAxxsF8lRfKJIAAAAASUVORK5CYII="

const pdfPath = join(spikeDir, "voice-spike.pdf")
const pngPath = join(spikeDir, "voice-spike.png")
writeFileSync(pdfPath, buildPdf(`school-agent Voice spike - outbound PDF - ${new Date().toISOString()}`))
writeFileSync(pngPath, Buffer.from(PNG_BASE64, "base64"))

const { Spectrum, attachment } = await import("spectrum-ts")
const { imessage } = await import("spectrum-ts/providers/imessage")

const app = await Spectrum({ providers: [imessage.config()] })
const im = imessage(app)
const space = await im.space.create(phone)
console.log(`space id (chat GUID): ${space.id}  type=${space.type}  line=${space.phone}`)
console.log(`eve threadId          : imessage:${space.id}~${space.phone}`)

let failures = 0
const send = async (label, content) => {
  const t0 = Date.now()
  try {
    const sent = await space.send(content)
    console.log(`  ok   ${label} -> id=${sent?.id ?? "(none)"} in ${Date.now() - t0}ms`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label} -> ${String(error)}`)
  }
}

await send("text", "Voice spike: outbound text from a stateless node script (no inbound first).")
if (!args.includes("--text-only")) {
  await send("pdf", attachment(pdfPath, { mimeType: "application/pdf", name: "voice-spike.pdf" }))
  await send("png", attachment(pngPath, { mimeType: "image/png", name: "voice-spike.png" }))
}

process.exit(failures > 0 ? 1 : 0)
