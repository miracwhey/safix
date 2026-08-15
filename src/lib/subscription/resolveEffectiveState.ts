/**
 * Effective State Resolver — Block 6
 *
 * Computes the effective subscription status from the persisted base status
 * and time fields. NEVER writes to the DB. This is the single canonical
 * resolver — all UI, guards, and entitlement logic MUST use its output.
 *
 * Time-based transitions:
 *   - trial_active with trial_ends_at in the past → 'expired'
 *   - canceled with current_period_end in the past → 'expired'
 */

import type { SubscriptionRow, EffectiveSubscriptionStatus } from './types'

export function resolveEffectiveState(
  row: SubscriptionRow,
  now: Date = new Date(),
): EffectiveSubscriptionStatus {
  const ts = now.getTime()

  switch (row.status) {
    case 'trial_available':
      return 'trial_available'

    case 'trial_active':
      if (row.trial_ends_at && new Date(row.trial_ends_at).getTime() <= ts) {
        return 'expired'
      }
      return 'trial_active'

    case 'active':
      return 'active'

    case 'grace': {
      const GRACE_MS = 16 * 24 * 60 * 60 * 1000
      if (row.grace_started_at && ts - new Date(row.grace_started_at).getTime() > GRACE_MS) {
        return 'expired'
      }
      return 'grace'
    }

    case 'canceled':
      if (row.current_period_end && new Date(row.current_period_end).getTime() <= ts) {
        return 'expired'
      }
      return 'canceled'

    case 'expired':
      return 'expired'
  }
}
