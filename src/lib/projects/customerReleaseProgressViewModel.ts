/**
 * Block 7.2.1a — Customer-side release progress view model.
 *
 * Pure derive function. Reads the new admin-confirm-gate stamps from
 * Block 7.2.1b plus the Acceptance record to project the customer's
 * "where is my project right now" UI state.
 *
 * State machine:
 *
 *   ┌── disputed ◄──── job.disputeStatus active
 *   │
 *   ├── released ──── acceptance.status === 'accepted'
 *   │                  (covers manual + auto-released by cron)
 *   │
 *   ├── acceptance_pending ──── acceptance.status === 'pending'
 *   │                            (admin has confirmed; the customer
 *   │                             has 72h to release or dispute)
 *   │
 *   ├── awaiting_admin_confirm ──── workMarkedCompleteAt set,
 *   │                                workConfirmedCompleteAt unset
 *   │                                (worker reported finished, owner
 *   │                                 has not yet confirmed)
 *   │
 *   ├── in_progress ──── job.status === 'in_progress'
 *   │                     (deposit released, work running, no mark yet)
 *   │
 *   └── commissioned ──── default
 *                          (escrow funded but work not yet started)
 *
 * The view model is intentionally minimal — copy/labels live in the UI
 * component so translations and microcopy can be tweaked without touching
 * the selector. The selector exposes the raw signals (expiresAt,
 * createdAt) so the card can render its own countdown.
 */

import type { Job } from '../jobs/types'
import type { Acceptance } from '../acceptance/types'

export type CustomerReleaseProgressState =
  | 'commissioned'
  | 'in_progress'
  | 'awaiting_admin_confirm'
  | 'acceptance_pending'
  | 'released'
  | 'disputed'

export interface CustomerReleaseProgressViewModel {
  state: CustomerReleaseProgressState
  /**
   * When `state === 'acceptance_pending'`, the timestamp at which the
   * customer's acceptance window expires and the cron auto-releases.
   */
  acceptanceExpiresAt?: number
  acceptanceCreatedAt?: number
  /**
   * When `state === 'awaiting_admin_confirm'`, the timestamp at which
   * the worker reported the job finished. UI uses this to render
   * "gemeldet vor X Stunden".
   */
  workMarkedCompleteAt?: number
}

const ACTIVE_DISPUTE_STATES = new Set([
  'open',
  'under_review',
  'customer_waiting',
  'provider_waiting',
])

export function deriveCustomerReleaseProgressViewModel(
  job: Job,
  acceptance?: Acceptance,
): CustomerReleaseProgressViewModel {
  // ── 1. Active dispute always wins ──────────────────────────────────────
  if (job.disputeStatus && ACTIVE_DISPUTE_STATES.has(job.disputeStatus)) {
    return { state: 'disputed' }
  }

  // ── 2. Released — manual or auto ───────────────────────────────────────
  if (acceptance?.status === 'accepted') {
    return {
      state: 'released',
      acceptanceCreatedAt: acceptance.createdAt,
    }
  }

  // ── 3. Acceptance window open ──────────────────────────────────────────
  if (acceptance?.status === 'pending') {
    return {
      state: 'acceptance_pending',
      acceptanceExpiresAt: acceptance.expiresAt,
      acceptanceCreatedAt: acceptance.createdAt,
    }
  }

  // ── 4. Worker reported finished, owner has not confirmed ───────────────
  if (job.workMarkedCompleteAt && !job.workConfirmedCompleteAt) {
    return {
      state: 'awaiting_admin_confirm',
      workMarkedCompleteAt: job.workMarkedCompleteAt,
    }
  }

  // ── 5. Work running ────────────────────────────────────────────────────
  if (job.status === 'in_progress') {
    return { state: 'in_progress' }
  }

  // ── 6. Default — commissioned (deposit funded, work not yet started) ───
  return { state: 'commissioned' }
}
