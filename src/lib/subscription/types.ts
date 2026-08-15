/**
 * Subscription Domain Types — Block 6
 *
 * Central type definitions for the owner subscription / entitlement system.
 * Covers: subscription row, effective state resolver output, pro actions,
 * entitlement levels, and active-work-exception context.
 */

// ── Subscription States ─────────────────────────────────────────────────────

/**
 * Base status persisted in the DB.
 * NEVER used for fachliche Entscheidungen außerhalb des Resolvers.
 */
export type SubscriptionBaseStatus =
  | 'trial_available'
  | 'trial_active'
  | 'active'
  | 'grace'
  | 'canceled'
  | 'expired'

/**
 * Effective status computed by the resolver from base status + time fields.
 * This is the ONLY status that UI, guards, and entitlement logic may use.
 */
export type EffectiveSubscriptionStatus =
  | 'trial_available'
  | 'trial_active'
  | 'active'
  | 'grace'
  | 'canceled'
  | 'expired'

// ── Subscription Row (DB shape) ─────────────────────────────────────────────

export type SubscriptionRow = {
  id: string
  profile_id: string
  status: SubscriptionBaseStatus
  trial_started_at: string | null
  trial_ends_at: string | null
  current_period_start: string | null
  current_period_end: string | null
  canceled_at: string | null
  grace_started_at: string | null
  billing_provider: 'apple' | 'stripe' | null
  billing_provider_subscription_id: string | null
  created_at: string
  updated_at: string
}

// ── Pro Actions ─────────────────────────────────────────────────────────────

/**
 * Registry of all subscription-gated pro actions.
 *
 * Naming convention:
 *   - Entry/open actions: open_quote_composer, open_invoice_creator
 *   - Submit/execute actions: send_message, start_job, complete_job, etc.
 *
 * This distinction matters for where ProActionGuard is placed:
 *   - Entry actions → guard at flow entry point
 *   - Submit actions → guard at submit button
 */
export type ProAction =
  // Message thread
  | 'send_message'
  // Quote/offer creation — guard at composer entry, not at final send
  | 'open_quote_composer'
  // Job operations
  | 'start_job'
  | 'complete_job'
  | 'release_tranche'
  | 'request_funding'
  // Invoice operations — guard at creation entry
  | 'open_invoice_creator'
  | 'issue_invoice'
  // Payout / Stripe Connect — Pro only; exception applies (needed to receive active-escrow payout)
  | 'setup_stripe_connect'
  // ChangeOrder / Nachtrag creation — Pro only; exception applies for active jobs
  | 'create_change_order'
  // Highlights — first highlight free, 2+ require Pro
  | 'create_highlight_extra'

// ── Entitlement Levels ──────────────────────────────────────────────────────

/**
 * Entitlement decision from resolveActionEntitlement.
 *
 * 'full'         — action allowed, no gate
 * 'trial_start'  — action requires trial confirmation first
 * 'exception'    — action allowed under active-work-exception (expired owner)
 * 'blocked'      — action denied
 */
export type EntitlementLevel = 'full' | 'trial_start' | 'exception' | 'blocked'

export type EntitlementResult = {
  level: EntitlementLevel
  reason?: string
}

// ── Active Work Context ─────────────────────────────────────────────────────

export type ActiveWorkContext = {
  jobId: string
  hasActiveEscrow: boolean
  boundThreadId: string | null
}

// ── Subscription Scope ──────────────────────────────────────────────────────

/**
 * Scope returned by useSubscription to distinguish:
 * - 'owner': subscription check applies
 * - 'not_applicable': non-owner, subscription irrelevant (passthrough)
 */
export type SubscriptionScope = 'owner' | 'not_applicable'

// ── Trial Start RPC Response ────────────────────────────────────────────────

export type TrialStartResult =
  | { ok: true; trial_ends_at: string }
  | { ok: false; error: string; current?: string }
