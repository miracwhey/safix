/**
 * Spatial Core · Scan FSM (TS mirror of the DB trigger)
 *
 * 1:1 mirror of `public.scan_status_transition_allowed` (migration
 * 20260518000005_scan_fsm_hardening.sql). The DB is the source of truth — this
 * mirror lets the InMemory repository enforce the same transitions during
 * tests and lets the Supabase repository fail fast before round-trip.
 *
 * **When you add a transition: update BOTH the migration's INSERT VALUES list
 * AND the `ALLOWED_SCAN_TRANSITIONS` set below.** The integration test in
 * `tests/lib/spatial/fsm.parity.test.ts` (Task 9) verifies the two stay in sync.
 *
 * Error model: throws an Error whose `code` is `'23514'` (Postgres
 * `check_violation`), so callers can `catch (err)` and route both the
 * client-side rejection and the round-trip Postgres rejection through the
 * same branch.
 */

import type { ScanStatus } from '../types'

/** Mirrors `INSERT INTO public.scan_status_transition_allowed VALUES (...)` 1:1. */
export const ALLOWED_SCAN_TRANSITIONS: ReadonlySet<`${ScanStatus}->${ScanStatus}`> = new Set([
  'draft->capturing',
  'capturing->captured',
  'capturing->draft',
  'captured->quality_checked',
  'captured->capturing',
  'quality_checked->needs_rescan',
  'quality_checked->needs_provider_review',
  'quality_checked->provider_verified',
  'needs_rescan->capturing',
  'needs_provider_review->provider_verified',
  'needs_provider_review->needs_rescan',
  'provider_verified->offer_ready',
  'provider_verified->locked_for_dispute',
  'offer_ready->locked_for_dispute',
  'offer_ready->archived',
  'locked_for_dispute->provider_verified',
  'locked_for_dispute->offer_ready',
  'locked_for_dispute->archived',
])

/** Postgres errcode `'23514'` = `check_violation`. Mirrors the DB RAISE. */
export const SCAN_FSM_ERRCODE = '23514'

export class ScanFsmViolation extends Error {
  /** Mirrors PostgrestError shape so a single `catch` covers both sources. */
  readonly code = SCAN_FSM_ERRCODE
  constructor(message: string) {
    super(message)
    this.name = 'ScanFsmViolation'
  }
}

/** Throws `ScanFsmViolation` if (from -> to) is not in the allowed set. */
export function assertScanTransition(from: ScanStatus, to: ScanStatus): void {
  if (from === to) return
  if (!ALLOWED_SCAN_TRANSITIONS.has(`${from}->${to}`)) {
    throw new ScanFsmViolation(`Illegal scan transition: ${from} -> ${to}`)
  }
}

/** Throws `ScanFsmViolation` if `status !== 'draft'` (new scans must start at draft). */
export function assertScanInsertStatus(status: ScanStatus): void {
  if (status !== 'draft') {
    throw new ScanFsmViolation(
      `Illegal scan INSERT: new scans must start at status=draft (got ${status})`,
    )
  }
}
