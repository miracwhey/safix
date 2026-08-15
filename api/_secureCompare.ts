import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of two secret strings.
 *
 * Uses `crypto.timingSafeEqual` so a brute-force probe cannot recover the
 * expected secret byte-by-byte from response-timing differences. A length
 * mismatch returns early — this only reveals the length, an acceptable
 * trade-off for the fixed-length webhook/cron secrets compared here.
 */
export function secureCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
