/**
 * Entitlement Resolution — Block 6
 *
 * Pure functions that determine whether a pro action is allowed given the
 * effective subscription state and optional active-work context.
 *
 * Rules:
 *   trial_active / active / grace / canceled → full access
 *   trial_available → trial_start (user must confirm trial first)
 *   expired + active escrow → active-work-exception (per-action allow list)
 *   expired without active escrow → blocked
 *   null (non-owner / no row) → NOT handled here; useSubscription returns
 *     scope='not_applicable' and ProActionGuard passes through
 */

import type {
  ProAction,
  EffectiveSubscriptionStatus,
  ActiveWorkContext,
  EntitlementResult,
} from './types'

/**
 * Actions allowed under the active-work-exception for expired owners.
 * Only actions needed to finish existing escrow-bound work.
 */
const EXCEPTION_ACTIONS: ReadonlySet<ProAction> = new Set([
  'start_job',
  'complete_job',
  'release_tranche',
  'open_invoice_creator',
  'issue_invoice',
  'send_message',
  // Payout setup and change orders needed to finish active escrow-bound work
  'setup_stripe_connect',
  'create_change_order',
])

/**
 * Earning-loop actions that are FREE for every verified craftsman (Apple 3.1.1).
 *
 * The craftsman's ability to earn money is not a Pro feature: payout setup,
 * funding requests, escrow release, running jobs, customer messaging, quote +
 * invoice creation, and change orders are always available. These resolve to
 * 'full' regardless of subscription state — no trial prompt, no upgrade sheet.
 *
 * Pro stays required for office surfaces (Team-Hub, Korrekturen, Kalender,
 * interne Team-Nachrichten, Finance) and for 2+ Highlights
 * ('create_highlight_extra'), which are intentionally NOT in this set.
 */
const FREE_ACTIONS: ReadonlySet<ProAction> = new Set([
  'setup_stripe_connect',
  'request_funding',
  'release_tranche',
  'start_job',
  'complete_job',
  'send_message',
  'open_quote_composer',
  'open_invoice_creator',
  'issue_invoice',
  'create_change_order',
])

/**
 * True for earning-loop / free actions (Apple 3.1.1) that must NEVER be gated —
 * not even during the owner-subscription load window. Consumed by the
 * programmatic gate (useProActionGate) so a still-loading or permanently-null
 * craftsman_subscriptions row can't silently swallow a free send.
 */
export function isFreeAction(action: ProAction): boolean {
  return FREE_ACTIONS.has(action)
}

export function resolveActionEntitlement(
  action: ProAction,
  effectiveState: EffectiveSubscriptionStatus,
  jobContext?: ActiveWorkContext,
): EntitlementResult {
  // Free earning-loop actions (Apple 3.1.1) — always allowed, independent of
  // subscription state. Resolved before the state branches so an expired or
  // trial_available craftsman gets no trial/upgrade sheet for these.
  if (FREE_ACTIONS.has(action)) {
    return { level: 'full' }
  }

  // Full access states
  if (
    effectiveState === 'trial_active' ||
    effectiveState === 'active' ||
    effectiveState === 'grace' ||
    effectiveState === 'canceled'
  ) {
    return { level: 'full' }
  }

  // Trial available — user needs to confirm trial start first
  if (effectiveState === 'trial_available') {
    return { level: 'trial_start' }
  }

  // Expired — check active-work-exception.
  // Only actions in the EXCEPTION_ACTIONS allow-list qualify.
  // Everything else (open_quote_composer, request_funding, …) is blocked.
  if (effectiveState === 'expired') {
    if (jobContext?.hasActiveEscrow && EXCEPTION_ACTIONS.has(action)) {
      // send_message only in bound thread — caller must verify threadId match
      // by only passing jobContext when the current thread matches boundThreadId
      return { level: 'exception' }
    }

    return { level: 'blocked', reason: 'expired' }
  }

  return { level: 'blocked', reason: 'unknown_state' }
}

/**
 * Checks whether a send_message action in a specific thread is allowed
 * under the active-work-exception.
 *
 * Requires exact thread match against the job's bound conversation thread.
 */
export function isMessageAllowedInThread(
  currentThreadId: string,
  jobContext: ActiveWorkContext,
): boolean {
  if (!jobContext.boundThreadId) return false
  return jobContext.boundThreadId === currentThreadId
}
