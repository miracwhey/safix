export type EnvVarStatus = 'present' | 'missing' | 'not_required'

export type ClientEnvReport = {
  VITE_DATA_SOURCE: EnvVarStatus
  VITE_SUPABASE_URL: EnvVarStatus
  VITE_SUPABASE_ANON_KEY: EnvVarStatus
  VITE_PAYMENT_PROVIDER: EnvVarStatus
  VITE_STRIPE_PUBLISHABLE_KEY: EnvVarStatus
  VITE_SENTRY_DSN: EnvVarStatus
  VITE_STRIPE_BACKEND_URL: EnvVarStatus
  VITE_API_BASE_URL: EnvVarStatus
}

type EnvMap = Record<string, string | undefined>

function presentOrMissing(value: string | undefined): 'present' | 'missing' {
  return value && value.trim() !== '' ? 'present' : 'missing'
}

/**
 * Resolves the data source to use based on the provided env map.
 *
 * Resolution order:
 * 1. If VITE_DATA_SOURCE is explicitly 'supabase' or 'in-memory', that wins.
 * 2. If VITE_DATA_SOURCE is absent but both Supabase credentials are present,
 *    automatically resolves to 'supabase'. This prevents the silent split-brain
 *    where auth (supabase.auth) and provider discovery (supabase.from('providers'))
 *    always use Supabase regardless of this flag, while the 17 repository-based
 *    domains (jobs, messages, payments, disputes, projects, …) fall back to
 *    in-memory — causing all operational data to vanish on page refresh even
 *    though the user is authenticated against a real Supabase project.
 * 3. Otherwise defaults to 'in-memory'.
 */
export function resolveDataSourceWith(env: EnvMap): 'supabase' | 'in-memory' {
  const explicit = env['VITE_DATA_SOURCE']
  if (explicit === 'supabase') return 'supabase'
  if (explicit === 'in-memory') return 'in-memory'

  // Auto-detect: both Supabase credentials present → use Supabase.
  const url = env['VITE_SUPABASE_URL']
  const key = env['VITE_SUPABASE_ANON_KEY']
  if (url && url.trim() !== '' && key && key.trim() !== '') return 'supabase'

  return 'in-memory'
}

/**
 * Core validation logic. Accepts an explicit env map so unit tests can call
 * this without needing to mock import.meta.env at the module level.
 *
 * Uses resolveDataSourceWith() so that Supabase credentials are validated
 * whenever the runtime will actually run in Supabase mode — including the
 * auto-detected case where VITE_DATA_SOURCE is absent but both credentials
 * are present.
 *
 * @param isProd — true for production Vite builds (import.meta.env.PROD).
 *   When true, the mock payment provider is blocked to prevent accidental
 *   deployment without real Stripe integration.
 */
export function validateClientEnvWith(env: EnvMap, isProd = false): void {
  const resolvedDataSource = resolveDataSourceWith(env)
  const paymentProvider = env['VITE_PAYMENT_PROVIDER']

  // ── Production data-source gate ─────────────────────────────────────────
  // A production build must never silently run against the in-memory mock
  // data source. That would leak demo state into real users.
  if (isProd && resolvedDataSource !== 'supabase') {
    throw new Error(
      '[SaFix] Production build requires a Supabase data source. ' +
        'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (optionally ' +
        'VITE_DATA_SOURCE=supabase). The in-memory mock is only available ' +
        'in development builds. See .env.example for details.',
    )
  }

  // ── Production provider gate ────────────────────────────────────────────
  // A production build must use the real Stripe provider. Defaulting to mock
  // (or explicitly setting mock) in a deployed build would let payment flows
  // appear to succeed without real money moving.
  if (isProd && paymentProvider !== 'stripe') {
    throw new Error(
      '[SaFix] Production build requires VITE_PAYMENT_PROVIDER=stripe. ' +
        'The mock payment provider is only available in development builds. ' +
        'Set VITE_PAYMENT_PROVIDER=stripe and provide VITE_STRIPE_PUBLISHABLE_KEY. ' +
        'See .env.example for details.',
    )
  }

  // ── Native API-origin gate ──────────────────────────────────────────────
  // Inside a native Capacitor shell the origin is capacitor://localhost and
  // relative /api/* URLs do not resolve. apiUrl() enforces this at call time
  // on every native build — the runtime throw surfaces in the AppBootstrap
  // error boundary with the same descriptive message. We do NOT enforce it
  // for web prod builds: a standard same-origin Vercel deployment resolves
  // /api/* relatively and works with an empty base.

  if (resolvedDataSource === 'supabase') {
    const url = env['VITE_SUPABASE_URL']
    const key = env['VITE_SUPABASE_ANON_KEY']

    if (!url || url.trim() === '') {
      throw new Error(
        '[SaFix] VITE_SUPABASE_URL is not configured. ' +
          'Set VITE_DATA_SOURCE=in-memory to use the local mock, or ' +
          'provide both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
          '(setting VITE_DATA_SOURCE=supabase is optional when both credentials are present). ' +
          'See .env.example for details.',
      )
    }

    if (!key || key.trim() === '') {
      throw new Error(
        '[SaFix] VITE_SUPABASE_ANON_KEY is not configured. ' +
          'Set VITE_DATA_SOURCE=in-memory to use the local mock, or ' +
          'provide both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
          '(setting VITE_DATA_SOURCE=supabase is optional when both credentials are present). ' +
          'See .env.example for details.',
      )
    }
  }

  if (paymentProvider === 'stripe') {
    const publishableKey = env['VITE_STRIPE_PUBLISHABLE_KEY']

    if (!publishableKey || publishableKey.trim() === '') {
      throw new Error(
        '[SaFix] VITE_STRIPE_PUBLISHABLE_KEY is not configured. ' +
          'Either set VITE_PAYMENT_PROVIDER=mock to use simulated payments, or ' +
          'provide VITE_STRIPE_PUBLISHABLE_KEY (pk_live_* / pk_test_*). ' +
          'See .env.example for details.',
      )
    }

    if (isProd && !publishableKey.trim().startsWith('pk_live_')) {
      throw new Error(
        '[SaFix] Production build requires a live Stripe publishable key ' +
          '(VITE_STRIPE_PUBLISHABLE_KEY must start with pk_live_). ' +
          'A pk_test_* key would send the shipped App Store build to Stripe test mode.',
      )
    }
  }
}

/**
 * Core report builder. Accepts an explicit env map for testability.
 */
export function getClientEnvReportWith(env: EnvMap): ClientEnvReport {
  const resolvedDataSource = resolveDataSourceWith(env)
  const paymentProvider = env['VITE_PAYMENT_PROVIDER']
  const isSupabase = resolvedDataSource === 'supabase'
  const isStripe = paymentProvider === 'stripe'

  return {
    VITE_DATA_SOURCE: presentOrMissing(env['VITE_DATA_SOURCE']),
    VITE_SUPABASE_URL: isSupabase
      ? presentOrMissing(env['VITE_SUPABASE_URL'])
      : 'not_required',
    VITE_SUPABASE_ANON_KEY: isSupabase
      ? presentOrMissing(env['VITE_SUPABASE_ANON_KEY'])
      : 'not_required',
    VITE_PAYMENT_PROVIDER: presentOrMissing(paymentProvider),
    VITE_STRIPE_PUBLISHABLE_KEY: isStripe
      ? presentOrMissing(env['VITE_STRIPE_PUBLISHABLE_KEY'])
      : 'not_required',
    VITE_SENTRY_DSN: presentOrMissing(env['VITE_SENTRY_DSN']),
    VITE_STRIPE_BACKEND_URL: presentOrMissing(env['VITE_STRIPE_BACKEND_URL']),
    VITE_API_BASE_URL: presentOrMissing(env['VITE_API_BASE_URL']),
  }
}

/**
 * Validates all VITE_* environment variables required for the current
 * configuration. Throws a descriptive error if a required variable is absent.
 *
 * Call this during application startup to surface misconfiguration early,
 * before any repository or payment operation is attempted.
 */
export function validateClientEnv(): void {
  validateClientEnvWith(import.meta.env as EnvMap, import.meta.env.PROD === true)
}

/**
 * Returns a report of the current state of all VITE_* environment variables.
 * Variables that are only required under certain configurations are marked
 * 'not_required' when their condition does not apply.
 */
export function getClientEnvReport(): ClientEnvReport {
  return getClientEnvReportWith(import.meta.env as EnvMap)
}
