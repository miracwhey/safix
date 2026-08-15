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
  onboarding_status: 'not_started' | 'onboarding_in_progress' | 'onboarding_complete' | 'payout_blocked' | null
}

async function findStripeAccountId(
  client: SupabaseClient,
  userId: string,
): Promise<
  | { kind: 'found'; stripeAccountId: string; onboardingStatus: PayoutAccountRow['onboarding_status'] | null }
  | { kind: 'missing_account' }
  | { kind: 'missing_storage'; reason: string }
  | { kind: 'db_error'; error: PostgrestError }
> {
  const payoutResult = await client
    .from('provider_payout_accounts')
    .select('stripe_connect_account_id, onboarding_status')
    .eq('provider_user_id', userId)
    .maybeSingle()

  if (payoutResult.error && !isMissingTable(payoutResult.error, 'provider_payout_accounts')) {
    return { kind: 'db_error', error: payoutResult.error }
  }

  if (isMissingTable(payoutResult.error, 'provider_payout_accounts')) {
    return { kind: 'missing_storage', reason: payoutResult.error?.message ?? 'provider_payout_accounts missing' }
  }

  if (payoutResult.data?.stripe_connect_account_id) {
    return {
      kind: 'found',
      stripeAccountId: payoutResult.data.stripe_connect_account_id,
      onboardingStatus: (payoutResult.data as PayoutAccountRow).onboarding_status,
    }
  }

  return { kind: 'missing_account' }
}

async function persistStripeAccountId(
  client: SupabaseClient,
  userId: string,
  stripeAccountId: string,
): Promise<{ ok: true } | { ok: false; reason: 'db_error' | 'missing_storage'; error?: PostgrestError; detail?: string }> {
  const now = new Date().toISOString()
  const upsertResult = await client
    .from('provider_payout_accounts')
    .upsert(
      {
        provider_user_id: userId,
        stripe_connect_account_id: stripeAccountId,
        onboarding_status: 'onboarding_in_progress',
        charges_enabled: false,
        payouts_enabled: false,
        requirements_due: null,
        updated_at: now,
      },
      { onConflict: 'provider_user_id' },
    )

  if (!upsertResult.error) return { ok: true }
  if (isMissingTable(upsertResult.error, 'provider_payout_accounts')) {
    return { ok: false, reason: 'missing_storage', detail: upsertResult.error.message }
  }

  return { ok: false, reason: 'db_error', error: upsertResult.error }
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
    logError('api.connect.account_creation_failed', undefined, {
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
  // setup_stripe_connect is in the AWE allow-list: pass jobId if the client
  // provides one (expired provider completing an active-escrow job).
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
    logError('api.connect.account_creation_failed', undefined, { userId, reason: 'stripe_key_missing' })
    res.status(500).json({ error: 'Server misconfiguration: Stripe secret key not configured.' })
    return
  }

  try {
    // An owner role alone is not sufficient: only an owner with a canonical
    // provider profile may create a Stripe Express account for payouts.
    const { data: provider, error: providerError } = await adminResult.client
      .from('providers')
      .select('id')
      .eq('profile_id', userId)
      .maybeSingle()

    if (providerError) {
      logError('api.connect.account_creation_failed', providerError, {
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

    // Check if provider already has a connect account stored
    const lookup = await findStripeAccountId(adminResult.client, userId)
    if (lookup.kind === 'db_error') {
      logError('api.connect.account_creation_failed', lookup.error, { userId, reason: 'db_fetch_failed' })
      res.status(500).json({ error: 'Failed to query payout account.' })
      return
    }
    if (lookup.kind === 'missing_storage') {
      logError('api.connect.account_creation_failed', undefined, { userId, reason: 'payout_storage_missing', detail: lookup.reason })
      res.status(500).json({ error: 'Payout account storage is missing from the database schema.' })
      return
    }
    if (lookup.kind === 'found') {
      res.status(200).json({
        stripeConnectAccountId: lookup.stripeAccountId,
        onboardingStatus: lookup.onboardingStatus ?? 'onboarding_in_progress',
      })
      return
    }

    const stripe = getStripe(secretKey)

    const stripeAccount = await stripe.accounts.create(
      {
        type: 'express',
        country: 'DE',
        capabilities: {
          transfers: { requested: true },
        },
        metadata: { provider_user_id: userId },
        // P1 escrow hold: default NEW accounts to a manual payout schedule so
        // Stripe does not auto-pay-out daily — funds stay frozen on the connected
        // account until an explicit payouts.create (P3). Capabilities stay
        // transfers-only on purpose (card_payments / on_behalf_of are lawyer-gated).
        settings: {
          payouts: {
            schedule: { interval: 'manual' },
          },
        },
      },
      // Stable across retries and concurrent requests. If Stripe succeeds but
      // the Supabase upsert fails, the next request receives this same account
      // and can repair the canonical DB link without orphaning another account.
      { idempotencyKey: `stripe_connect_account_${userId}` },
    )

    const persistResult = await persistStripeAccountId(adminResult.client, userId, stripeAccount.id)
    if (persistResult.ok === false) {
      const errorPayload =
        persistResult.reason === 'missing_storage'
          ? { error: 'Payout account storage is missing from the database schema.' }
          : { error: 'Failed to save payout account.' }
      logError('api.connect.account_creation_failed', persistResult.error, {
        userId,
        reason: persistResult.reason === 'missing_storage' ? 'payout_storage_missing' : 'db_upsert_failed',
        detail: persistResult.detail,
      })
      res.status(500).json(errorPayload)
      return
    }

    logInfo('api.connect.account_created', { userId, stripeAccountId: stripeAccount.id })

    res.status(200).json({
      stripeConnectAccountId: stripeAccount.id,
      onboardingStatus: 'onboarding_in_progress',
    })
  } catch (err: unknown) {
    logError('api.connect.account_creation_failed', err instanceof Error ? err : undefined, { userId })
    const detail = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: `Unexpected server error: ${detail}` })
  }
}
