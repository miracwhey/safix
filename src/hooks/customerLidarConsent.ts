/**
 * Spatial V1.6 · Phase 2 · Customer LiDAR DSGVO consent helpers
 *
 * Tiny session-free module so consent state can be read/written by both the
 * capture hook (which pulls `supabase` for auth) and the consent sheet
 * (purely presentational) without dragging supabase-auth into component
 * test fixtures. See feedback_spatial_barrel_no_session_imports for the
 * underlying issue.
 */

import { logError } from '../lib/observability'

/** localStorage key for the one-time DSGVO consent (PRIV-D1).
 *  Versioned (v1) so a future privacy-text revision can re-prompt. */
export const CUSTOMER_LIDAR_DSGVO_CONSENT_KEY =
  'spatial-customer-dsgvo-consent-v1'

/** Read the persisted consent flag. Returns false when storage is unavailable
 *  (private mode, capacitor cold boot) — better to re-prompt than skip. */
export function hasCustomerLidarConsent(): boolean {
  try {
    return globalThis.localStorage?.getItem(CUSTOMER_LIDAR_DSGVO_CONSENT_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the consent flag. Best-effort: a quota-miss or disabled storage is
 *  logged but does NOT block the capture flow — the next session re-prompts. */
export function recordCustomerLidarConsent(): void {
  try {
    globalThis.localStorage?.setItem(CUSTOMER_LIDAR_DSGVO_CONSENT_KEY, '1')
  } catch (err) {
    logError('spatial.customer_lidar.consent_persist_failed', err)
  }
}
