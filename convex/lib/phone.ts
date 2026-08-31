/**
 * Phone normalization — one definition, used by every read *and* write path.
 *
 * Voice resolves an inbound iMessage number to its student through `by_phone`,
 * which is an exact-match index: a number stored as a human typed it never
 * matches the E.164 form Photon hands over. Normalizing on both sides is what
 * makes the lookup total.
 */

/**
 * E.164-ish: digits with a leading `+`. Photon hands us `+15551234567`; a human
 * typing into onboarding may not. A 10-digit number is assumed to be US/NANP.
 * Anything with no digits at all is left alone rather than invented into a
 * number that looks real.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "")
  if (!digits) return raw.trim()
  return `+${digits.length === 10 ? `1${digits}` : digits}`
}
