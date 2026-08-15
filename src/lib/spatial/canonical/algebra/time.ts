/**
 * Spatial · Canonical · Algebra · Time helpers (XM-4 audit-fix)
 *
 * Bridge boundary between Block-A and canonical:
 *   - Block-A (`src/lib/spatial/types.ts`) timestamps use `number` (Unix ms).
 *   - Canonical (`ISO8601` brand in `types/scene-graph.ts`) timestamps use
 *     strings.
 *
 * These pure helpers are the only legal conversion point. The bridge layer
 * (Day 8 B13 · `scanToParametric.ts`) imports both directions to keep the
 * snake/camel + epoch/ISO conventions explicit.
 */

import type { ISO8601 } from '../types/scene-graph.ts'

/**
 * Convert a Unix-epoch millisecond timestamp to a canonical ISO-8601 string.
 *
 * Throws on non-finite input so a corrupt Block-A row never produces an
 * invalid ISO date silently.
 */
export function unixMsToIso(ms: number): ISO8601 {
  if (!Number.isFinite(ms)) {
    throw new Error(`unixMsToIso: expected a finite number, got ${ms}`)
  }
  return new Date(ms).toISOString() as ISO8601
}

/**
 * Convert a canonical ISO-8601 timestamp to a Unix-epoch millisecond number.
 *
 * Throws on unparseable strings (Date.parse returns NaN for those) so the
 * bridge can fail loud rather than persist a `NaN` epoch.
 */
export function isoToUnixMs(iso: ISO8601 | string): number {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) {
    throw new Error(`isoToUnixMs: invalid ISO-8601 timestamp: ${iso}`)
  }
  return t
}
