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
}

async function findStripeAccountId(
  client: SupabaseClient,
  userId: string,
): Promise<
  | { kind: 'found'; stripeAccountId: string }
  | { kind: 'missing_row' }
  | { kind: 'missing_stripe_id' }
  | { kind: 'missing_storage'; reason: string }
  | { kind: 'db_error'; error: PostgrestError }
> {
  const payoutResult = await client
    .from('provider_payout_accounts')
    .select('stripe_connect_account_id')
    .eq('provider_user_id', userId)
    .maybeSingle()

  if (!payoutResult.error && payoutResult.data?.stripe_connect_account_id) {
    return { kind: 'found', stripeAccountId: payoutResult.data.stripe_connect_account_id }
  }
  if (payoutResult.error && !isMissingTable(payoutResult.error, 'provider_payout_accounts')) {
    return { kind: 'db_error', error: payoutResult.error }
  }

  if (isMissingTable(payoutResult.error, 'provider_payout_accounts')) {
    return { kind: 'missing_storage', reason: payoutResult.error?.message ?? 'provider_payout_accounts missing' }
  }

  if (!payoutResult.data) {
    return { kind: 'missing_row' }
  }

  const record = payoutResult.data as PayoutAccountRow
  if (!record.stripe_connect_account_id) {
    return { kind: 'missing_stripe_id' }
  }

  return { kind: 'found', stripeAccountId: record.stripe_connect_account_id }
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
    logError('api.connect.onboarding_link_failed', undefined, {
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
    logError('api.connect.onboarding_link_failed', undefined, { userId, reason: 'stripe_key_missing' })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  try {
    const { data: provider, error: providerError } = await adminResult.client
      .from('providers')
      .select('id')
      .eq('profile_id', userId)
      .maybeSingle()

    if (providerError) {
      logError('api.connect.onboarding_link_failed', providerError, {
        userId,
        reason: 'provider_lookup_failed',
      })
      res.status(500).json({ error: 'Failed to verify provider profile.' })
      return
    }
    if (!provider) {
      res.status(409).json({ error: 'No provider profile found for the authenticated owner.' })
      return
    }

    const lookup = await findStripeAccountId(adminResult.client, userId)
    if (lookup.kind === 'db_error') {
      logError('api.connect.onboarding_link_failed', lookup.error, { userId, reason: 'db_fetch_failed' })
      res.status(500).json({ error: 'Failed to query payout account.' })
      return
    }
    if (lookup.kind === 'missing_storage') {
      logError('api.connect.onboarding_link_failed', undefined, { userId, reason: 'payout_storage_missing', detail: lookup.reason })
      res.status(500).json({ error: 'Payout account storage is missing from the database schema.' })
      return
    }
    if (lookup.kind === 'missing_row') {
      res.status(400).json({ error: 'No payout account found. Call /api/connect-account first.' })
      return
    }
    if (lookup.kind === 'missing_stripe_id') {
      res.status(400).json({ error: 'Stripe account id is missing for this payout account.' })
      return
    }

    const stripeAccountId = lookup.stripeAccountId
    const stripe = getStripe(secretKey)

    const appBaseUrl = process.env.APP_BASE_URL
    if (!appBaseUrl) {
      logError('api.connect.onboarding_link_failed', undefined, { userId, reason: 'app_base_url_missing' })
      res.status(500).json({ error: 'Server misconfiguration: APP_BASE_URL not configured.' })
      return
    }

    const returnUrl = appBaseUrl + '/payout-return'
    const refreshUrl = appBaseUrl + '/payout-refresh'

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    })

    // Update status to onboarding_in_progress
    const now = new Date().toISOString()
    const updateResult = await adminResult.client
      .from('provider_payout_accounts')
      .update({ onboarding_status: 'onboarding_in_progress', updated_at: now })
      .eq('provider_user_id', userId)

    if (updateResult.error) {
      if (isMissingTable(updateResult.error, 'provider_payout_accounts')) {
        logError('api.connect.onboarding_link_failed', updateResult.error, {
          userId,
          reason: 'payout_storage_missing',
        })
        res.status(500).json({ error: 'Payout account storage is missing from the database schema.' })
        return
      }
      logError('api.connect.onboarding_link_failed', updateResult.error, {
        userId,
        reason: 'db_update_failed',
      })
      res.status(500).json({ error: 'Failed to update payout account status.' })
      return
    }

    logInfo('api.connect.onboarding_link_generated', { userId, stripeAccountId })

    res.status(200).json({ onboardingUrl: accountLink.url })
  } catch (err: unknown) {
    logError('api.connect.onboarding_link_failed', err instanceof Error ? err : undefined, { userId })
    const detail = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
