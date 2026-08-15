import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { applyCors } from './_cors.js'
import { requireOwner } from './_authRole.js'
import { getSupabaseAdminWithStatus, formatAdminUnavailable } from './_supabase.js'
import { logInfo, logError } from './_observability.js'
import { applyRateLimit } from './_rateLimit.js'
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import { requireProEntitlement } from './_subscriptionAuth.js'

// Initialised once at module level; reused across warm serverless invocations.
let stripeClient: Stripe | null = null

function getStripe(secretKey: string): Stripe {
  if (!stripeClient) {
    stripeClient = new Stripe(secretKey)
  }
  return stripeClient
}

type OnboardingStatus = 'not_started' | 'onboarding_in_progress' | 'pending_verification' | 'onboarding_complete' | 'payout_blocked'

function deriveOnboardingStatus(stripeAccount: Stripe.Account): OnboardingStatus {
  if (stripeAccount.charges_enabled && stripeAccount.payouts_enabled) {
    return 'onboarding_complete'
  }
  const disabledReason = stripeAccount.requirements?.disabled_reason
  // Only hard rejections by Stripe warrant payout_blocked.
  // requirements.past_due / action_required.* are normal onboarding-incomplete
  // states — the account is not rejected, the user simply hasn't finished the flow.
  if (disabledReason?.startsWith('rejected.')) {
    return 'payout_blocked'
  }
  // Log any non-rejected disabled_reason so unexpected Stripe values surface in observability
  // before they silently misclassify accounts (e.g. 'listed', 'under_review', 'other').
  if (disabledReason && !disabledReason.startsWith('rejected.')) {
    logInfo('api.connect.non_rejected_disabled_reason', { disabledReason })
  }
  // Distinguish "user must still provide info" from "submitted, waiting for Stripe review".
  // When currently_due is empty the user has submitted everything and Stripe is verifying.
  const currentlyDue = stripeAccount.requirements?.currently_due ?? []
  if (currentlyDue.length === 0) {
    return 'pending_verification'
  }
  return 'onboarding_in_progress'
}

function isMissingTable(error: PostgrestError | null, table: string): boolean {
  if (!error?.message) return false
  const msg = error.message.toLowerCase()
  const normalized = table.toLowerCase()
  return (
    msg.includes(`table '${normalized}`) ||
    msg.includes(`table 'public.${normalized}`) ||
    msg.includes(`table "public.${normalized}`) ||
    msg.includes(`relation "${normalized}`) ||
    msg.includes(`relation "public.${normalized}`)
  )
}

type PayoutAccountRow = {
  stripe_connect_account_id: string | null
  onboarding_status?: OnboardingStatus | null
  charges_enabled?: boolean | null
  payouts_enabled?: boolean | null
  onboarding_completed_at?: string | null
  requirements_due?: string | null
}

async function fetchPayoutAccount(
  client: SupabaseClient,
  userId: string,
): Promise<
  | {
    kind: 'found',
    record: PayoutAccountRow
  }
  | { kind: 'missing_row' }
  | { kind: 'missing_storage'; reason: string }
  | { kind: 'db_error'; error: PostgrestError }
> {
  const payoutResult = await client
    .from('provider_payout_accounts')
    .select(
      [
        'stripe_connect_account_id',
        'onboarding_status',
        'charges_enabled',
        'payouts_enabled',
        'onboarding_completed_at',
        'requirements_due',
      ].join(','),
    )
    .eq('provider_user_id', userId)
    .maybeSingle()

  if (payoutResult.error) {
    if (isMissingTable(payoutResult.error, 'provider_payout_accounts')) {
      return { kind: 'missing_storage', reason: payoutResult.error.message }
    }
    return { kind: 'db_error', error: payoutResult.error }
  }

  if (!payoutResult.data) {
    return { kind: 'missing_row' }
  }

  const record = payoutResult.data as unknown as PayoutAccountRow
  return { kind: 'found', record }
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (applyCors(req, res, 'core')) return

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed. Use POST.' })
    return
  }

  const auth = await requireOwner(req, res)
  if (!auth) return
  if (await applyRateLimit(res, 'standard', auth.userId)) return

  const userId = auth.userId

  const adminResult = getSupabaseAdminWithStatus()
  if (adminResult.ok === false) {
    logError('api.connect.status_sync_failed', undefined, {
      userId,
      reason: 'supabase_admin_unavailable',
      missing: adminResult.missing,
    })
    res.status(500).json({
      error: `Server misconfiguration: ${formatAdminUnavailable(adminResult.missing)}`,
    })
    return
  }

  // ── Pro entitlement gate ──────────────────────────────────────────────
  const { jobId: aweJobId } = (req.body ?? {}) as { jobId?: unknown }
  const proResult = await requireProEntitlement(
    adminResult.client,
    userId,
    'setup_stripe_connect',
    typeof aweJobId === 'string' ? aweJobId : undefined,
  )
  if (proResult.ok === false) {
    res.status(proResult.status).json({ error: proResult.reason })
    return
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    logError('api.connect.status_sync_failed', undefined, { userId, reason: 'stripe_key_missing' })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  try {
    const { data: provider, error: providerError } = await adminResult.client
      .from('providers')
      .select('id, profile_id')
      .eq('profile_id', userId)
      .maybeSingle()

    if (providerError) {
      logError('api.connect.status_sync_failed', providerError, { userId, reason: 'provider_lookup_failed' })
      res.status(500).json({ error: `Failed to load provider profile: ${providerError.message}` })
      return
    }

    if (!provider) {
      res.status(404).json({ error: 'No provider profile found for the authenticated user.' })
      return
    }

    const lookup = await fetchPayoutAccount(adminResult.client, userId)
    if (lookup.kind === 'db_error') {
      logError('api.connect.status_sync_failed', lookup.error, { userId, reason: 'db_fetch_failed' })
      res.status(500).json({
        error: `Failed to query payout account: ${lookup.error.message ?? 'unknown database error.'}`,
      })
      return
    }
    if (lookup.kind === 'missing_storage') {
      logError('api.connect.status_sync_failed', undefined, {
        userId,
        reason: 'payout_storage_missing',
        detail: lookup.reason,
      })
      res.status(500).json({
        error: 'Payout account storage is missing from the database schema.',
      })
      return
    }
    if (lookup.kind === 'missing_row') {
      res.status(200).json({
        status: 'no_account',
        account: null,
        reason: 'missing_payout_account',
      })
      return
    }
    if (!lookup.record.stripe_connect_account_id) {
      res.status(200).json({
        status: 'no_account',
        account: null,
        reason: 'missing_stripe_account_id',
      })
      return
    }
    const stripeAccountId: string = lookup.record.stripe_connect_account_id
    const stripe = getStripe(secretKey)

    let stripeAccount: Stripe.Account
    try {
      stripeAccount = await stripe.accounts.retrieve(stripeAccountId)
    } catch (stripeError: unknown) {
      const detail = stripeError instanceof Error ? stripeError.message : String(stripeError)
      logError('api.connect.status_sync_failed', stripeError instanceof Error ? stripeError : undefined, {
        userId,
        reason: 'stripe_account_lookup_failed',
        stripeAccountId,
      })
      res.status(502).json({ error: `Failed to retrieve Stripe account: ${detail}` })
      return
    }

    const newStatus = deriveOnboardingStatus(stripeAccount)
    const chargesEnabled = stripeAccount.charges_enabled ?? false
    const payoutsEnabled = stripeAccount.payouts_enabled ?? false
    const payoutScheduleInterval = stripeAccount.settings?.payouts?.schedule?.interval ?? null
    const requirementsDue = stripeAccount.requirements?.currently_due?.join(',') ?? null

    // P1 escrow-integrity drift alert: a payouts-enabled account whose schedule
    // is NOT 'manual' will auto-pay-out, defeating the manual-payout escrow hold.
    // Detection ONLY — do not flip a live schedule here (flipping a money-holding
    // account before P3's payouts.create exists would strand in-flight funds).
    if (payoutsEnabled && payoutScheduleInterval !== 'manual') {
      logError('api.connect.payout_schedule_drift', undefined, {
        userId,
        stripeAccountId,
        payoutScheduleInterval,
      })
    }
    const now = new Date().toISOString()
    const existingCompletion = lookup.record.onboarding_completed_at ?? null
    const nextCompletion = newStatus === 'onboarding_complete' && !existingCompletion ? now : existingCompletion

    const updatePayload: Record<string, unknown> = {
      onboarding_status: newStatus,
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
      requirements_due: requirementsDue,
      updated_at: now,
    }
    if (nextCompletion) {
      updatePayload.onboarding_completed_at = nextCompletion
    }

    const { error: updateError } = await adminResult.client
      .from('provider_payout_accounts')
      .update(updatePayload)
      .eq('provider_user_id', userId)

    if (updateError) {
      logError('api.connect.status_sync_failed', updateError, { userId, reason: 'db_update_failed' })
      res.status(500).json({
        error: `Failed to update payout account status: ${updateError.message ?? 'unknown database error.'}`,
      })
      return
    }

    logInfo('api.connect.status_synced', {
      userId,
      status: newStatus,
      chargesEnabled,
      payoutsEnabled,
    })

    res.status(200).json({
      status: newStatus,
      account: {
        providerUserId: userId,
        stripeConnectAccountId: stripeAccountId,
        onboardingStatus: newStatus,
        chargesEnabled,
        payoutsEnabled,
        payoutScheduleInterval,
        requirementsDue,
        onboardingCompletedAt: nextCompletion ?? null,
      },
    })
  } catch (err: unknown) {
    logError('api.connect.status_sync_failed', err instanceof Error ? err : undefined, { userId })
    const detail = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
