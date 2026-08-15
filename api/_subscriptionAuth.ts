/**
 * Server-side subscription authorization helper.
 *
 * Answers: is this authenticated Pro owner allowed to perform this action?
 *
 * The Pro status check mirrors client-side resolveEffectiveState logic.
 * Active-work-exception (AWE): expired owners with an active escrow job
 * may still perform a specific allow-listed set of actions.
 *
 * Called as the second auth step after requireAuth() in payment API routes.
 * On failure returns { ok: false, status: 402, reason } — caller must return
 * res.status(result.status).json({ error: result.reason }).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProAction =
  | 'request_funding'
  | 'release_tranche'
  | 'setup_stripe_connect'
  | 'create_change_order'
  | 'issue_invoice'
  | 'open_quote_composer'
  | 'send_message'
  | 'start_job'
  | 'complete_job'
  | 'open_invoice_creator'

/** Actions allowed for expired owners who have an active escrow job. */
const EXCEPTION_ACTIONS: ReadonlySet<ProAction> = new Set([
  'start_job',
  'complete_job',
  'release_tranche',
  'open_invoice_creator',
  'issue_invoice',
  'send_message',
  'setup_stripe_connect',
  'create_change_order',
])

/**
 * Earning-loop actions that are FREE for every verified craftsman.
 *
 * Apple 3.1.1: the craftsman's ability to earn (set up payouts, request
 * funding, release escrow, run a job, message customers, send quotes/invoices,
 * create change orders) must NOT sit behind the Pro IAP subscription. These
 * actions short-circuit to { ok: true } before any subscription lookup.
 *
 * Pro stays required for office/admin surfaces (Team-Hub, Korrekturen,
 * Kalender/Einsatzplanung, interne Team-Nachrichten, Finance-Dashboard,
 * 2+ Highlights) — those are gated elsewhere (ProScreenGuard / the client
 * resolver's create_highlight_extra path), never through this allow-list.
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

/** Escrow plan statuses that qualify as "active work". Must match escrow_payment_plans.status CHECK constraint. */
const ACTIVE_ESCROW_STATUSES = ['funded_in_escrow', 'partially_released']

// ---------------------------------------------------------------------------
// Subscription row shape (subset of craftsman_subscriptions)
// ---------------------------------------------------------------------------

interface SubscriptionRow {
  status: string
  trial_ends_at: string | null
  current_period_end: string | null
  grace_started_at: string | null
}

// ---------------------------------------------------------------------------
// Effective state resolver (mirrors src/lib/subscription/resolveEffectiveState)
// ---------------------------------------------------------------------------

type EffectiveState = 'trial_active' | 'active' | 'grace' | 'canceled' | 'expired' | 'trial_available'

function resolveEffective(row: SubscriptionRow, now: Date): EffectiveState {
  switch (row.status) {
    case 'trial_available':
      return 'trial_available'
    case 'trial_active':
      if (row.trial_ends_at && new Date(row.trial_ends_at) <= now) return 'expired'
      return 'trial_active'
    case 'active':
      return 'active'
    case 'grace': {
      const GRACE_MS = 16 * 24 * 60 * 60 * 1000
      if (row.grace_started_at && now.getTime() - new Date(row.grace_started_at).getTime() > GRACE_MS) {
        return 'expired'
      }
      return 'grace'
    }
    case 'canceled':
      if (row.current_period_end && new Date(row.current_period_end) <= now) return 'expired'
      return 'canceled'
    default:
      return 'expired'
  }
}

// ---------------------------------------------------------------------------
// Active-work-exception check
// ---------------------------------------------------------------------------

async function hasActiveEscrowForJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('escrow_payment_plans')
    .select('id')
    .eq('job_id', jobId)
    .in('status', ACTIVE_ESCROW_STATUSES)
    .limit(1)
    .maybeSingle()

  return data !== null
}

// ---------------------------------------------------------------------------
// Main gate
// ---------------------------------------------------------------------------

export type SubscriptionAuthResult =
  | { ok: true }
  | { ok: false; status: number; reason: string }

/**
 * Verifies the authenticated caller has Pro access for the given action.
 *
 * @param supabase   Admin Supabase client (service_role).
 * @param profileId  Supabase auth.uid() of the caller.
 * @param action     The Pro action being attempted.
 * @param jobId      Optional: job context for active-work-exception check.
 */
export async function requireProEntitlement(
  supabase: SupabaseClient,
  profileId: string,
  action: ProAction,
  jobId?: string,
): Promise<SubscriptionAuthResult> {
  // ── Free earning-loop actions (Apple 3.1.1) ──────────────────────────────
  // These are free for every verified craftsman. Return before any
  // subscription lookup — no trial, no AWE, no 402 path applies.
  if (FREE_ACTIONS.has(action)) {
    return { ok: true }
  }

  const { data: row, error } = await supabase
    .from('craftsman_subscriptions')
    .select('status, trial_ends_at, current_period_end, grace_started_at')
    .eq('profile_id', profileId)
    .maybeSingle()

  if (error) {
    return { ok: false, status: 500, reason: 'subscription_lookup_failed' }
  }

  if (!row) {
    return { ok: false, status: 402, reason: 'no_subscription' }
  }

  const effective = resolveEffective(row as SubscriptionRow, new Date())

  // Full access states
  if (['trial_active', 'active', 'grace', 'canceled'].includes(effective)) {
    return { ok: true }
  }

  // trial_available → must start trial first
  if (effective === 'trial_available') {
    return { ok: false, status: 402, reason: 'pro_required:trial_start' }
  }

  // expired — check AWE
  if (effective === 'expired') {
    if (jobId && EXCEPTION_ACTIONS.has(action)) {
      const hasEscrow = await hasActiveEscrowForJob(supabase, jobId)
      if (hasEscrow) return { ok: true }
    }
    return { ok: false, status: 402, reason: 'pro_required:blocked' }
  }

  return { ok: false, status: 402, reason: 'pro_required:unknown_state' }
}
