/**
 * Trial Service — Block 6
 *
 * Client access layer for trial-start and subscription row ensure.
 * All mutations go through Supabase RPCs (SECURITY DEFINER).
 *
 * Error contract:
 *   - Business rejections: { ok: false, error: string }
 *   - Technical errors: thrown as Error
 */

import { supabase } from '../supabase'
import type { TrialStartResult } from './types'

/**
 * Starts the 14-day trial for the current authenticated owner.
 *
 * Returns a typed result — business rejections are returned as values,
 * not thrown. Technical/transport errors are thrown.
 */
export async function startTrial(): Promise<TrialStartResult> {
  const { data, error } = await supabase.rpc('start_trial')

  if (error) {
    // SQL RAISE EXCEPTION → PostgREST error
    const msg = error.message || 'Trial konnte nicht gestartet werden'
    throw new Error(msg)
  }

  const result = data as Record<string, unknown>

  if (result.ok === true) {
    return { ok: true, trial_ends_at: result.trial_ends_at as string }
  }

  return {
    ok: false,
    error: (result.error as string) ?? 'unknown',
    current: result.current as string | undefined,
  }
}

/**
 * Ensures a subscription row exists for the current authenticated owner.
 * Idempotent — no-ops if row already exists.
 *
 * Called during onboarding completion to guarantee row existence
 * without a drift window between onboarding_done and subscription row.
 */
export async function ensureSubscriptionRow(): Promise<void> {
  const { error } = await supabase.rpc('ensure_subscription_row')

  if (error) {
    // not_owner is expected for non-owner callers — swallow silently
    // since this is called in onboarding which may run for workers too.
    if (error.message?.includes('not_owner')) return
    throw new Error(error.message || 'Subscription-Zeile konnte nicht erstellt werden')
  }
}
