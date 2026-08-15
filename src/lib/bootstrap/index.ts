import {
  setJobRepository,
  initializeJobRepository,
  SupabaseJobRepository,
} from '../jobs/repository'
import {
  getMessageRepository,
  setMessageRepository,
  initializeMessageRepository,
  SupabaseMessageRepository,
  setThreadArtifactRepository,
  initializeThreadArtifactRepository,
  SupabaseThreadArtifactRepository,
} from '../messages/repository'
import {
  getChatRepository,
  setChatRepository,
  initializeChatRepository,
  SupabaseChatRepository,
} from '../chat/repository'
import {
  setPaymentRepository,
  initializePaymentRepository,
  SupabasePaymentRepository,
} from '../payments/repository'
import {
  setLedgerRepository,
  initializeLedgerRepository,
  SupabaseLedgerRepository,
} from '../payments/ledger/repository'
import {
  setDisputeRepository,
  initializeDisputeRepository,
  SupabaseDisputeRepository,
} from '../disputes/repository'
import {
  setCalendarRepository,
  initializeCalendarRepository,
  SupabaseCalendarRepository,
  drainCalendarInFlightWrites,
} from '../calendar/repository'
import {
  setScheduleRepository,
  initializeScheduleRepository,
  SupabaseScheduleRepository,
} from '../operations/repository'
import {
  setProjectRepository,
  initializeProjectRepository,
  SupabaseProjectRepository,
} from '../projects/repository'
import {
  setTimelineRepository,
  initializeTimelineRepository,
  SupabaseTimelineRepository,
} from '../timeline/repository'
import {
  setNotificationRepository,
  initializeNotificationRepository,
  SupabaseNotificationRepository,
} from '../notifications/repository'
import {
  setInAppNotificationRepository,
  SupabaseInAppNotificationRepository,
} from '../inAppNotifications/repository'
import {
  setInvoiceRepository,
  initializeInvoiceRepository,
  SupabaseInvoiceRepository,
} from '../invoices/repository'
import {
  setMediaRepository,
  initializeMediaRepository,
  SupabaseMediaRepository,
} from '../media/repository'
import {
  setFeedbackRepository,
  initializeFeedbackRepository,
  SupabaseFeedbackRepository,
} from '../feedback/repository'
import {
  setTeamMemberRepository,
  initializeTeamMemberRepository,
  SupabaseTeamMemberRepository,
  setTimeEntryRepository,
  initializeTimeEntryRepository,
  SupabaseTimeEntryRepository,
  setAbsenceRepository,
  initializeAbsenceRepository,
  SupabaseAbsenceRepository,
} from '../team/repository'
import {
  setAnalyticsRepository,
  initializeAnalyticsRepository,
  SupabaseAnalyticsRepository,
} from '../analytics/repository'
import {
  setFeatureFlagsRepository,
  initializeFeatureFlagsRepository,
  SupabaseFeatureFlagsRepository,
} from '../flags/repository'
import {
  setRatingRepository,
  initializeRatingRepository,
  SupabaseRatingRepository,
} from '../ratings/repository'
import {
  setOfferRepository,
  initializeOfferRepository,
  SupabaseOfferRepository,
} from '../offers/repository'
import {
  initializeFundingRequestRepository,
  setFundingRequestRepository,
  SupabaseFundingRequestRepository,
} from '../payments/fundingRequest'
import {
  initializeEscrowPlanRepository,
  setEscrowPlanRepository,
  SupabaseEscrowPlanRepository,
} from '../payments/escrow'
import {
  setCorrectionRepository,
  initializeCorrectionRepository,
  SupabaseCorrectionRepository,
} from '../corrections/repository'
import {
  setAcceptanceRepository,
  initializeAcceptanceRepository,
  SupabaseAcceptanceRepository,
} from '../acceptance'
import {
  setChangeOrderRepository,
  initializeChangeOrderRepository,
  SupabaseChangeOrderRepository,
} from '../changeOrders'
import {
  setSupplementaryPaymentRepository,
  initializeSupplementaryPaymentRepository,
  SupabaseSupplementaryPaymentRepository,
} from '../payments/supplementary'
import {
  setSpatialRepository,
  initializeSpatialRepository,
  SupabaseSpatialRepository,
  InMemorySpatialRepository,
} from '../spatial/repository'
import { clearPersistenceFailures, hasPendingMutations } from '../persistence'
import { flushPendingMutations } from '../persistence/flushPendingMutations'
import { getAuthSession } from '../auth/authSingleFlight'
import { resolveDataSourceWith, validateClientEnv } from '../env/envValidation'
import { assertApiBaseUrlForNative } from '../api/baseUrl'
import {
  setPaymentProvider,
  type PaymentProviderName,
} from '../payments/providers'

export type DataSource = 'in-memory' | 'supabase'

function resolveDataSource(): DataSource {
  return resolveDataSourceWith(import.meta.env as Record<string, string | undefined>)
}

function resolvePaymentProvider(): PaymentProviderName {
  const env = import.meta.env.VITE_PAYMENT_PROVIDER as string | undefined
  return env === 'stripe' ? 'stripe' : 'mock'
}

/**
 * Validates that the required Supabase environment variables are present.
 * Throws a descriptive error early — before any repository is instantiated —
 * so the AppBootstrap error boundary surfaces a clear message rather than
 * silent fetch failures deep inside repository code.
 *
 * Called whenever the resolved data source is 'supabase' — this includes both
 * the explicit VITE_DATA_SOURCE=supabase case and the auto-detected case where
 * both Supabase credentials are present without an explicit VITE_DATA_SOURCE.
 */
function validateSupabaseConfig(): void {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

  if (!url || url.trim() === '') {
    throw new Error(
      '[SaFix] VITE_SUPABASE_URL is not configured. ' +
        'Either set VITE_DATA_SOURCE=in-memory to use the local mock, or ' +
        'provide both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. ' +
        'See .env.example for details.',
    )
  }

  if (!key || key.trim() === '') {
    throw new Error(
      '[SaFix] VITE_SUPABASE_ANON_KEY is not configured. ' +
        'Either set VITE_DATA_SOURCE=in-memory to use the local mock, or ' +
        'provide both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. ' +
        'See .env.example for details.',
    )
  }
}

/**
 * Validates that the required Stripe environment variables are present.
 * Throws a descriptive error early — before any payment operation is
 * attempted — so the AppBootstrap error boundary surfaces a clear message.
 *
 * Only called when VITE_PAYMENT_PROVIDER=stripe.
 */
function validateStripeConfig(): void {
  const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined

  if (!publishableKey || publishableKey.trim() === '') {
    throw new Error(
      '[SaFix] VITE_STRIPE_PUBLISHABLE_KEY is not configured. ' +
        'Either set VITE_PAYMENT_PROVIDER=mock to use simulated payments, or ' +
        'provide VITE_STRIPE_PUBLISHABLE_KEY (pk_live_* / pk_test_*). ' +
        'See .env.example for details.',
    )
  }
}

/**
 * Centralized application bootstrap.
 *
 * Selects which repository implementations are active based on the
 * VITE_DATA_SOURCE environment variable ('supabase' | default: 'in-memory'),
 * registers them via the domain registries, and awaits initialization of all
 * async-capable repositories.
 *
 * The active payment provider is selected via the VITE_PAYMENT_PROVIDER
 * environment variable ('stripe' | default: 'mock').
 *
 * Must be awaited before the application renders any data-dependent UI.
 * For the default in-memory data source all initialize() calls resolve
 * immediately, so there is no visible startup delay.
 */
export async function bootstrapRepositories(
  dataSource: DataSource = resolveDataSource(),
  paymentProvider: PaymentProviderName = resolvePaymentProvider(),
): Promise<void> {
  // Fail-fast env validation. In production builds this blocks:
  //   - running against the in-memory mock data source
  //   - using the mock payment provider
  //   - missing Supabase / Stripe credentials
  // A thrown error surfaces in the AppBootstrap error boundary with a
  // descriptive message instead of silent fetch failures later on.
  validateClientEnv()

  // Native fail-fast for the API origin. Web same-origin deployments are
  // allowed to boot without VITE_API_BASE_URL; native Capacitor builds are
  // not — they would appear healthy until the first /api/* call.
  assertApiBaseUrlForNative()

  setPaymentProvider(paymentProvider)

  if (paymentProvider === 'stripe') {
    validateStripeConfig()
  }

  if (dataSource === 'supabase') {
    validateSupabaseConfig()
    setJobRepository(new SupabaseJobRepository())
    setMessageRepository(new SupabaseMessageRepository())
    setThreadArtifactRepository(new SupabaseThreadArtifactRepository())
    setPaymentRepository(new SupabasePaymentRepository())
    setLedgerRepository(new SupabaseLedgerRepository())
    setDisputeRepository(new SupabaseDisputeRepository())
    setCalendarRepository(new SupabaseCalendarRepository())
    setScheduleRepository(new SupabaseScheduleRepository())
    setProjectRepository(new SupabaseProjectRepository())
    setTimelineRepository(new SupabaseTimelineRepository())
    setNotificationRepository(new SupabaseNotificationRepository())
    setInAppNotificationRepository(new SupabaseInAppNotificationRepository())
    setInvoiceRepository(new SupabaseInvoiceRepository())
    setMediaRepository(new SupabaseMediaRepository())
    setFeedbackRepository(new SupabaseFeedbackRepository())
    setTeamMemberRepository(new SupabaseTeamMemberRepository())
    setTimeEntryRepository(new SupabaseTimeEntryRepository())
    setAbsenceRepository(new SupabaseAbsenceRepository())
    setAnalyticsRepository(new SupabaseAnalyticsRepository())
    setFeatureFlagsRepository(new SupabaseFeatureFlagsRepository())
    setRatingRepository(new SupabaseRatingRepository())
    setOfferRepository(new SupabaseOfferRepository())
    setEscrowPlanRepository(new SupabaseEscrowPlanRepository())
    setFundingRequestRepository(new SupabaseFundingRequestRepository())
    setChatRepository(new SupabaseChatRepository())
    setCorrectionRepository(new SupabaseCorrectionRepository())
    setAcceptanceRepository(new SupabaseAcceptanceRepository())
    setChangeOrderRepository(new SupabaseChangeOrderRepository())
    setSupplementaryPaymentRepository(new SupabaseSupplementaryPaymentRepository())
    initializeSpatialRepository(new SupabaseSpatialRepository())
  } else {
    setSpatialRepository(new InMemorySpatialRepository())
  }

  // Replay pending mutations BEFORE initializing repositories so that critical
  // repos load the post-replay DB state rather than pre-replay stale state.
  // The Supabase client restores auth from its own localStorage, so the flush
  // can run before any repository initializes. On error bootstrap continues —
  // failures surface via the persistence failure store and SyncStatusBar.
  if (dataSource === 'supabase' && hasPendingMutations()) {
    try { await flushPendingMutations() } catch { /* failures surface via SyncStatusBar */ }
  }

  // Pre-warm the auth session ONCE before constructing the repository init
  // arrays below. Every SupabaseXxxRepository.initialize() issues a
  // supabase.from().select() whose PostgREST _getAccessToken() calls the RAW
  // supabase.auth.getSession() (not this single-flight). On a cold start ~28 of
  // those fire in parallel the instant the criticalInits/deferredInits array
  // literals are evaluated (initialize() runs eagerly at array construction, not
  // at await). Each getSession() first awaits GoTrueClient's one-shot init, then
  // acquires the auth-js navigator.locks 'fixup.auth' lock; whenever the herd
  // reaches that lock with a still-expired token (init's recover-refresh left it
  // unfresh after a retryable failure, or it lapsed the 90 s expiry margin
  // between init and the herd), the first member runs an in-lock token refresh
  // over the multi-second launch network while the rest queue past the 5 s lock
  // timeout → "lock not released within 5000ms" + steal, a multi-second boot
  // stall. Awaiting getAuthSession() here forces that one refresh-and-persist to
  // complete first (single-flight, so it cannot itself herd); the subsequent raw
  // getSession() calls then short-circuit on the now-fresh in-memory session and
  // hold the lock for microseconds. A prewarm failure is non-fatal — each repo keeps
  // its own auth-read error handling and boot degrades to the prior behaviour
  // rather than crashing. (AppBootstrap also awaits getAuthSession, but only
  // AFTER bootstrapRepositories() returns — too late to order the herd.)
  if (dataSource === 'supabase') {
    try { await getAuthSession() } catch { /* non-fatal: repos handle their own auth-read failures */ }
  }

  // Critical repositories — required for landing screens and notification bridge.
  // TimelineRepository is critical because startNotificationBridge() reads from
  // it immediately after bootstrap; an unhydrated timeline would silently skip
  // the initial sync and leave notifications derived from pre-bridge events missing.
  const criticalInits = [
    initializeJobRepository(),
    initializeMessageRepository(),
    initializePaymentRepository(),
    initializeProjectRepository(),
    initializeCalendarRepository(),
    initializeNotificationRepository(),
    initializeTimelineRepository(),
    // Critical: flags gate guarded flows (chat cutover, kill-switch), so they
    // must hydrate before the app renders. Fail-closed on a fetch error — a
    // missing flag resolves OFF and the chat adapter falls back to its env
    // default, so a flags outage degrades gracefully rather than blocking boot.
    initializeFeatureFlagsRepository(),
  ]

  // Deferred repositories — loaded in background after first paint.
  // Screens guard on isHydrated() so missing data shows loading state.
  const deferredInits = [
    initializeThreadArtifactRepository(),
    initializeLedgerRepository(),
    initializeDisputeRepository(),
    initializeScheduleRepository(),
    initializeInvoiceRepository(),
    initializeMediaRepository(),
    initializeFeedbackRepository(),
    initializeTeamMemberRepository(),
    initializeTimeEntryRepository(),
    initializeAbsenceRepository(),
    initializeAnalyticsRepository(),
    initializeRatingRepository(),
    initializeOfferRepository(),
    initializeFundingRequestRepository(),
    initializeEscrowPlanRepository(),
    initializeChatRepository(),
    initializeCorrectionRepository(),
    initializeAcceptanceRepository(),
    initializeChangeOrderRepository(),
    initializeSupplementaryPaymentRepository(),
  ]

  // Await critical repos with resilience — partial failures log but don't crash.
  const criticalResults = await Promise.allSettled(criticalInits)
  const criticalFailures = criticalResults.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  )

  if (criticalFailures.length > 0) {
    for (const f of criticalFailures) {
      console.warn('[SaFix] Critical repository init failed:', f.reason)
    }
  }

  // If ALL critical repos failed, the app is fundamentally broken.
  if (criticalFailures.length === criticalInits.length) {
    throw new AggregateError(
      criticalFailures.map((f) => f.reason),
      `All ${criticalInits.length} critical repositories failed to initialize`,
    )
  }

  // Fire deferred repos in background — don't block first render.
  void Promise.allSettled(deferredInits).then((results) => {
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )
    for (const f of failures) {
      console.warn('[SaFix] Deferred repository init failed:', f.reason)
    }
  })
}

/**
 * Re-syncs all repositories by reloading their data from the underlying store.
 *
 * Call this to reconcile local cache divergence after one or more optimistic
 * write failures have been detected via `hasPersistenceFailures()`.
 * On success, clears all recorded persistence failures so that subscribers
 * stop showing the sync-error indicator.
 *
 * If any repository fails to reload this function throws and failures are
 * intentionally left in the store — the local cache may still be diverged
 * and the caller should surface the error to the user.
 *
 * Throws if any repository fails to reload — the caller (e.g. AppBootstrap or
 * a UI error boundary) is responsible for handling that case.
 */
let _resyncGeneration = 0

export async function resyncRepositories(): Promise<void> {
  const generation = ++_resyncGeneration

  // Flush pending mutations first: if offline-written items are in the queue,
  // reloading from DB would overwrite the optimistic cache with stale state and
  // then the pending writes would replay on top of already-correct DB data —
  // or worse, replay an INSERT against a row that now exists and lose the update.
  // flushPendingMutations() is safe to call concurrently (no-ops if already running).
  if (hasPendingMutations()) {
    try { await flushPendingMutations() } catch { /* failures surface via SyncStatusBar */ }
  }

  // Reload all caches from the database. If this rejects, we do NOT clear
  // failures — the divergence signal must remain visible to the user.
  await Promise.all([
    initializeJobRepository(true),
    initializeMessageRepository(true),
    initializeChatRepository(true),
    initializeThreadArtifactRepository(true),
    initializePaymentRepository(true),
    initializeLedgerRepository(true),
    initializeDisputeRepository(true),
    initializeCalendarRepository(true),
    initializeScheduleRepository(true),
    initializeProjectRepository(true),
    initializeTimelineRepository(true),
    initializeNotificationRepository(true),
    initializeInvoiceRepository(true),
    initializeMediaRepository(true),
    initializeFeedbackRepository(true),
    initializeTeamMemberRepository(true),
    initializeTimeEntryRepository(true),
    initializeAbsenceRepository(true),
    initializeAnalyticsRepository(true),
    initializeRatingRepository(true),
    initializeOfferRepository(true),
    initializeFundingRequestRepository(true),
    initializeEscrowPlanRepository(true),
    initializeCorrectionRepository(true),
    initializeAcceptanceRepository(true),
    initializeChangeOrderRepository(true),
    initializeSupplementaryPaymentRepository(true),
  ])

  // Drain calendar in-flight writes BEFORE clearing failures.  Subscribers
  // (CraftsmanDashboardScreen, CraftsmanOperationsScreen) call
  // syncCalendarEntriesForJobs synchronously when JobRepository notifies
  // during initializeJobRepository(true).  Each such call can fire-and-forget
  // a `replace()` whose supabase update completes AFTER Promise.all above
  // resolves.  Without this drain, a permanent-kind failure recorded
  // post-clear would re-show the SyncStatusBar — the user reads the retry
  // as a no-op even though the resync genuinely cleared everything else.
  // Bounded so a hung connection can't block the failure-clear indefinitely.
  await drainCalendarInFlightWrites()

  // The message + chat repositories swallow fetch errors internally — their
  // initialize() always resolves and records the failure via getLastError()
  // instead. Promise.all above therefore resolves even when their reload
  // genuinely failed. Surface that failure here so the caller
  // (getOrStartResyncWave in session.ts) does NOT advance lastResyncAt and
  // the next online/resume retry is not debounced away for 30s. Throwing
  // also skips clearPersistenceFailures() below on purpose — the divergence
  // signal must remain visible (see function doc).
  const failedRepos = [
    getMessageRepository().getLastError() !== null ? 'messages' : null,
    getChatRepository().getLastError() !== null ? 'chat' : null,
  ].filter((domain): domain is string => domain !== null)
  if (failedRepos.length > 0) {
    throw new Error(`resyncRepositories: repository reload failed (${failedRepos.join(', ')})`)
  }

  // Only clear failure state when this resync was not superseded by a newer one
  // (e.g. a concurrent sign-out reset). Superseded calls resolve early on generation
  // mismatch — clearing failures then would hide divergence after a real race.
  if (generation !== _resyncGeneration) return
  clearPersistenceFailures()
}
