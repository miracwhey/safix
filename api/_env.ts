/**
 * Server-side environment validation and production gate.
 *
 * Detects production via VERCEL_ENV (set automatically by Vercel).
 * In production, ALL payment-critical secrets are required — missing any
 * causes a hard 500 via checkProductionGate() before any handler logic runs.
 *
 * In development/preview, only base requirements are enforced.
 *
 * Production-required variables:
 *   STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   STRIPE_WEBHOOK_SECRET, CRON_SECRET, RELEASE_CONFIRM_SECRET,
 *   FUNDING_CONFIRM_SECRET, ALLOWED_ORIGIN (must not be "*")
 */

// ---------------------------------------------------------------------------
// Production detection
// ---------------------------------------------------------------------------

/** True when running on a Vercel production deployment. */
export const isProduction: boolean = process.env.VERCEL_ENV === 'production'

// ---------------------------------------------------------------------------
// Production gate — cached per scope, runs once per cold start
// ---------------------------------------------------------------------------

export type ProductionGateResult =
  | { ok: true }
  | { ok: false; missing: string[] }

/**
 * Gate scope controls which secrets are required:
 *   - 'core':  Only base infrastructure (Stripe key, Supabase, CORS origin).
 *              Use for endpoints that only need Stripe API + DB access
 *              (e.g. payout onboarding, status sync).
 *   - 'full':  Core + payment-execution secrets (webhook, cron, release/funding
 *              confirm). Use for endpoints that handle money movement.
 */
export type GateScope = 'core' | 'full'

const CORE_SECRETS = [
  'STRIPE_SECRET_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const

const EXECUTION_SECRETS = [
  'STRIPE_WEBHOOK_SECRET',
  'CRON_SECRET',
  'RELEASE_CONFIRM_SECRET',
  'FUNDING_CONFIRM_SECRET',
] as const

let _coreGateResult: ProductionGateResult | null = null
let _fullGateResult: ProductionGateResult | null = null

/**
 * Validates that required environment variables are present.
 * In non-production environments, always returns { ok: true }.
 * Result is cached per scope per cold start — safe to call on every request.
 */
export function checkProductionGate(scope: GateScope = 'full'): ProductionGateResult {
  const cached = scope === 'core' ? _coreGateResult : _fullGateResult
  if (cached) return cached

  // Read env at call time (not module-level const) so the gate
  // respects runtime changes in test environments.
  if (process.env.VERCEL_ENV !== 'production') {
    const result: ProductionGateResult = { ok: true }
    if (scope === 'core') _coreGateResult = result
    else _fullGateResult = result
    return result
  }

  const missing: string[] = []

  for (const key of CORE_SECRETS) {
    const val = process.env[key]
    if (!val || val.trim() === '') missing.push(key)
  }

  // A production deployment must never execute against Stripe test mode. The
  // client build gate independently requires pk_live_; this server-side gate
  // ensures the payment executor is live as well.
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY
  if (stripeSecretKey?.trim() && !stripeSecretKey.trim().startsWith('sk_live_')) {
    missing.push('STRIPE_SECRET_KEY (must start with sk_live_ in production)')
  }

  if (scope === 'full') {
    for (const key of EXECUTION_SECRETS) {
      const val = process.env[key]
      if (!val || val.trim() === '') missing.push(key)
    }
  }

  const origin = process.env.ALLOWED_ORIGIN
  if (!origin || origin.trim() === '' || origin.trim() === '*') {
    missing.push('ALLOWED_ORIGIN (must be set to exact origin, not "*")')
  }

  const result: ProductionGateResult = missing.length > 0 ? { ok: false, missing } : { ok: true }
  if (scope === 'core') _coreGateResult = result
  else _fullGateResult = result
  return result
}

/** Reset cached gate results. Only for testing. */
export function _resetGateCache(): void {
  _coreGateResult = null
  _fullGateResult = null
}

// ---------------------------------------------------------------------------
// Legacy per-route validation (kept for backwards compatibility)
// ---------------------------------------------------------------------------

export type ServerEnvConfig = {
  stripeSecretKey: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  stripeWebhookSecret: string | null
  allowedOrigin: string | null
  cronSecret: string | null
}

export type ServerEnvResult =
  | { ok: true; config: ServerEnvConfig }
  | { ok: false; missing: string[] }

function get(key: string): string | undefined {
  return process.env[key]
}

export function validateServerEnv(): ServerEnvResult {
  const missing: string[] = []

  const stripeSecretKey = get('STRIPE_SECRET_KEY')
  const supabaseUrl = get('SUPABASE_URL')
  const supabaseServiceRoleKey = get('SUPABASE_SERVICE_ROLE_KEY')

  if (!stripeSecretKey || stripeSecretKey.trim() === '') missing.push('STRIPE_SECRET_KEY')
  if (!supabaseUrl || supabaseUrl.trim() === '') missing.push('SUPABASE_URL')
  if (!supabaseServiceRoleKey || supabaseServiceRoleKey.trim() === '')
    missing.push('SUPABASE_SERVICE_ROLE_KEY')

  if (missing.length > 0) {
    return { ok: false, missing }
  }

  return {
    ok: true,
    config: {
      stripeSecretKey: stripeSecretKey!,
      supabaseUrl: supabaseUrl!,
      supabaseServiceRoleKey: supabaseServiceRoleKey!,
      stripeWebhookSecret: get('STRIPE_WEBHOOK_SECRET') ?? null,
      allowedOrigin: get('ALLOWED_ORIGIN') ?? null,
      cronSecret: get('CRON_SECRET') ?? null,
    },
  }
}
