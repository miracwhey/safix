/**
 * Spatial · Canonical · Bridge · getCanonicalScene (Szenen-Produktion · B3)
 *
 * Thin, result-typed wrapper around the iOS-native `RoomPlan.getCanonicalScene`
 * plugin method. The native CanonicalConverter (Swift, iOS 17+) runs against
 * the `CapturedRoom` that `startScan` cached and returns the canonical
 * `parametric.json` document. This wrapper is the single TS caller of that
 * bridge — AD-1: the native converter is authoritative; the TS
 * `scanToParametric` bridge stays dormant.
 *
 * Cache-lifetime note (R2): the Swift plugin keeps the finished `CapturedRoom`
 * in a plugin-instance property (`lastCapturedRoom`, RoomPlanPlugin.swift) that
 * is overwritten only by the NEXT `startScan` — it is NOT evicted on a timer
 * or after a render. `getCanonicalScene` is therefore safe to call any time
 * after a capture resolves and before another scan starts; it fails with
 * `no_scan` only when no scan has completed in the current app process (e.g.
 * after an app relaunch).
 *
 * Every native reject is mapped to a typed {@link CanonicalSceneResult} so the
 * caller (`promoteScanToScene`) never sees a raw throw.
 */

import { RoomPlan } from '@fixup/capacitor-roomplan'
import type { GetCanonicalSceneArgs } from '@fixup/capacitor-roomplan'

/** Why a {@link getCanonicalSceneFromNative} call did not yield a document. */
export type CanonicalSceneFailure =
  /** No cached `CapturedRoom` — `startScan` has not completed this session. */
  | 'no_scan'
  /** The native converter threw, or a required arg was missing. */
  | 'convert_failed'
  /** Native converter absent — iOS < 17, non-iOS, or the web bundle. */
  | 'unavailable'

export type CanonicalSceneResult =
  | { ok: true; document: Record<string, unknown> }
  | { ok: false; reason: CanonicalSceneFailure; message: string }

/**
 * Run the iOS-native canonical converter against the most-recent scan. Pure
 * result-type API — never throws.
 */
export async function getCanonicalSceneFromNative(
  args: GetCanonicalSceneArgs,
): Promise<CanonicalSceneResult> {
  try {
    const { document } = await RoomPlan.getCanonicalScene(args)
    return { ok: true, document }
  } catch (e) {
    const code = (e as { code?: string }).code
    const message = e instanceof Error ? e.message : String(e)
    switch (code) {
      case 'CANONICAL_CONVERT_NO_SCAN':
        return { ok: false, reason: 'no_scan', message }
      // `UNAVAILABLE` is Capacitor `WebPlugin.unavailable()`'s reject code —
      // the web-stub path; `ROOMPLAN_V2_UNAVAILABLE` is the iOS < 17 native code.
      case 'ROOMPLAN_V2_UNAVAILABLE':
      case 'UNAVAILABLE':
        return { ok: false, reason: 'unavailable', message }
      default:
        // CANONICAL_CONVERT_FAILED + any unexpected reject.
        return { ok: false, reason: 'convert_failed', message }
    }
  }
}
