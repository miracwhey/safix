import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isNative } from '../lib/platform'
import { ReceiptText, Euro, X, ArrowLeft } from 'lucide-react'
import AppShell from '../components/AppShell'
import NavigationCard from '../components/primitives/NavigationCard'
import HeroPayoutCard from '../components/finance/HeroPayoutCard'
import PaymentMechanismExplainer from '../components/finance/PaymentMechanismExplainer'
import CraftsmanPayoutSummarySection from '../components/finance/CraftsmanPayoutSummarySection'
import ActionItemsSection from '../components/finance/ActionItemsSection'
import ActiveJobPaymentsSection from '../components/finance/ActiveJobPaymentsSection'
import RecentActivitySection from '../components/finance/RecentActivitySection'
import PayoutFailureBanner from '../components/finance/PayoutFailureBanner'
import DiagnosticDebugBlock from '../components/DiagnosticDebugBlock'
import {
  getFinanceDashboardViewModel,
  type FinanceDashboardViewModel,
} from '../lib/finance'
import { deriveCraftsmanFinanceActions } from '../lib/finance/craftsmanActions'
import { subscribeDisputes, isDisputeRepositoryHydrated } from '../lib/disputes'
import { getInvoiceByJobId, subscribeInvoices, isInvoiceRepositoryHydrated } from '../lib/invoices'
import { subscribeJobs } from '../lib/jobs'
import { subscribeTimeline } from '../lib/timeline'
import { getChatRepository } from '../lib/chat'

function subscribeChatMessages(cb: () => void): () => void {
  return getChatRepository().subscribe(cb)
}
import { subscribePayments, getAllPayments, getPaymentForJob, isPaymentRepositoryHydrated } from '../lib/payments'
import {
  derivePayoutFailureAlert,
  getEmptyPayoutFailureAlert,
} from '../lib/payments/payoutFailureAlert'
import {
  subscribeNotifications,
  getNotificationSignals,
} from '../lib/notifications'
import { subscribeFundingRequests, isFundingRequestRepositoryHydrated } from '../lib/payments/fundingRequest'
import { subscribeEscrowPlans, isEscrowPlanRepositoryHydrated } from '../lib/payments/escrow'
import { subscribeLedger, getLedger, isLedgerRepositoryHydrated } from '../lib/payments/ledger'
import { getAllSupplementaryPayments, subscribeSupplementaryPayments, isSupplementaryPaymentRepositoryHydrated } from '../lib/payments/supplementary'
import { useStoreSync } from '../lib/reactive'
import { deriveCraftsmanPayoutSummary } from '../lib/payout/craftsmanPayoutSummary'
import { resolveMoneyFlowProjection, type PayoutStatus } from '../lib/payments/moneyFlowProjection'
import { derivePayoutReadinessStatus } from '../lib/payout/selectors'
import type { PayoutReadinessStatus, ProviderPayoutAccount } from '../lib/payout/types'
import type { CraftsmanPayoutSummary } from '../lib/payout'
import { supabase } from '../lib/supabase'
import { apiUrl } from '../lib/api/baseUrl'
import { recordAnalyticsEventOnce } from '../lib/analytics'
import { logError } from '../lib/observability'
import { buildDiagnostic, emitDiagnostic, type RuntimeDiagnostic } from '../lib/diagnostics'
import { areRepositoriesHydrated } from '../lib/shared/repositoryReadiness'
import ScreenSkeleton from '../components/system/ScreenSkeleton'
import { useSmartBack } from '../hooks/useSmartBack'

export default function CraftsmanFinanceScreen() {
  const navigate = useNavigate()
  const goBack = useSmartBack('/craftsman/backoffice')
  const handlePayoutSetup = useCallback(() => navigate('/craftsman/payout-setup'), [navigate])

  // ActiveJobPaymentsSection and the payout summary derive from
  // MoneyFlowProjection, which reads funding + escrow truth. Without those
  // hydration gates a cold start briefly shows "Einzahlung ausstehend" for
  // jobs that are already funded.
  const deferredReady = areRepositoriesHydrated([
    isInvoiceRepositoryHydrated,
    isDisputeRepositoryHydrated,
    isLedgerRepositoryHydrated,
    isSupplementaryPaymentRepositoryHydrated,
    isPaymentRepositoryHydrated,
    isFundingRequestRepositoryHydrated,
    isEscrowPlanRepositoryHydrated,
  ])

  const [vm, setVm] = useState<FinanceDashboardViewModel>(
    getFinanceDashboardViewModel()
  )
  const [payoutStatus, setPayoutStatus] = useState<PayoutReadinessStatus>('no_account')
  const [payoutStatusError, setPayoutStatusError] = useState<string | null>(null)
  const [payoutDebug, setPayoutDebug] = useState<RuntimeDiagnostic | null>(null)
  const [payoutFailureAlert, setPayoutFailureAlert] = useState(getEmptyPayoutFailureAlert)

  useEffect(() => {
    const refresh = () =>
      setPayoutFailureAlert(derivePayoutFailureAlert(getNotificationSignals()))
    refresh()
    const unsub = subscribeNotifications(refresh)
    return () => {
      unsub()
    }
  }, [])

  // Craftsman-scoped payout transparency
  const [craftsmanUserId, setCraftsmanUserId] = useState<string | null>(null)
  const [payoutAccount, setPayoutAccount] = useState<ProviderPayoutAccount | null>(null)
  const [storeTick, setStoreTick] = useState(0)
  const [payoutRefreshTick, setPayoutRefreshTick] = useState(0)

  useEffect(() => {
    if (!isNative()) return
    let handle: { remove: () => Promise<void> } | null = null
    let mounted = true
    void (async () => {
      const { App } = await import('@capacitor/app')
      const h = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) setPayoutRefreshTick((t) => t + 1)
      })
      if (!mounted) { void h.remove() } else { handle = h }
    })()
    return () => {
      mounted = false
      if (handle) void handle.remove()
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function fetchPayoutStatus() {
      try {
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        const userId = data.session?.user.id ?? null
        if (!token) return

        const res = await fetch(apiUrl('/api/payout-account-status'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
        })
        if (cancelled) return
        if (!res.ok) {
          const errBody = await res.json().catch(() => null) as { error?: string } | null
          throw new Error(
            (errBody && typeof errBody.error === 'string' ? errBody.error : null) ??
            'Auszahlungsstatus konnte nicht geladen werden.',
          )
        }

        const body = await res.json() as {
          account: Pick<ProviderPayoutAccount, 'stripeConnectAccountId' | 'onboardingStatus' | 'chargesEnabled' | 'payoutsEnabled'> | null
        }

        const partial: ProviderPayoutAccount | null = body.account
          ? {
              id: '',
              providerUserId: '',
              stripeConnectAccountId: body.account.stripeConnectAccountId,
              onboardingStatus: body.account.onboardingStatus,
              chargesEnabled: body.account.chargesEnabled,
              payoutsEnabled: body.account.payoutsEnabled,
              onboardingCompletedAt: null,
              requirementsDue: null,
              createdAt: 0,
              updatedAt: 0,
            }
          : null

        if (!cancelled) {
          const derivedStatus = derivePayoutReadinessStatus(partial)
          setPayoutStatus(derivedStatus)
          setCraftsmanUserId(userId)
          setPayoutAccount(partial)

          if (derivedStatus === 'payout_ready') {
            recordAnalyticsEventOnce({
              eventType: 'payout_ready',
              entityType: 'provider',
              entityId: body.account?.stripeConnectAccountId ?? '',
            })
          }
        }
      } catch (err) {
        setPayoutStatusError('Auszahlungsstatus konnte nicht abgerufen werden.')
        const diagnostic = buildDiagnostic({
          source: 'CONNECT_STATUS',
          step: 'finance_load_status',
          name: 'CraftsmanFinanceScreen.fetchPayoutStatus',
          error: err,
          hint: 'Fetch payout-account-status with valid auth token.',
        })
        emitDiagnostic(diagnostic)
        setPayoutDebug(diagnostic)
        logError('finance.payout_status_load_failed', err)
      }
    }

    void fetchPayoutStatus()
    return () => { cancelled = true }
  }, [payoutRefreshTick])

  const payoutSummary = useMemo<CraftsmanPayoutSummary | null>(() => {
    if (!craftsmanUserId) return null
    const payments = getAllPayments()
    // MoneyFlowProjection.payoutStatus is the single source of truth for the
    // payout OUTCOME (received / in-transit / reversed / failed / blocked).
    // Resolve it per craftsman payment and feed it into the summary so the
    // released buckets exclude reversed/failed payouts instead of mis-claiming
    // them as "In Auszahlung". subscribeTimeline (in useStoreSync) keeps this
    // fresh when a payout webhook signal lands.
    const payoutStatusByPaymentId = new Map<string, PayoutStatus>()
    for (const p of payments) {
      if (p.craftsmanUserId !== craftsmanUserId) continue
      const proj = resolveMoneyFlowProjection(p.jobId, payoutAccount)
      if (proj) payoutStatusByPaymentId.set(p.id, proj.payoutStatus)
    }
    return deriveCraftsmanPayoutSummary(
      craftsmanUserId,
      payments,
      getLedger(),
      payoutAccount,
      getAllSupplementaryPayments(),
      payoutStatusByPaymentId,
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeTick, craftsmanUserId, payoutAccount])

  useStoreSync(
    [
      subscribeJobs,
      subscribeChatMessages,
      subscribePayments,
      subscribeFundingRequests,
      subscribeEscrowPlans,
      subscribeInvoices,
      subscribeDisputes,
      subscribeLedger,
      subscribeSupplementaryPayments,
      // Payout-outcome timeline signals (`payout_completed` / `payout_failed`)
      // drive the projection's payoutStatus — without subscribing here, a
      // realtime signal insert would land in the timeline store but the
      // active finance cards would keep rendering stale transfer state.
      subscribeTimeline,
    ],
    () => {
      setVm(getFinanceDashboardViewModel())
      setStoreTick((t) => t + 1)
    },
  )

  // Derive action items for the craftsman
  const actions = useMemo(
    () =>
      deriveCraftsmanFinanceActions({
        payoutReadiness: payoutStatus,
        disputesWithContext: vm.disputesWithContext,
        jobs: vm.jobs,
        invoices: vm.invoices,
        getInvoiceByJobId,
        getPaymentForJob,
      }),
    [payoutStatus, vm]
  )

  // Collect craftsman's payment IDs for ledger filtering
  const craftsmanPaymentIds = useMemo(() => {
    if (!payoutSummary) return new Set<string>()
    return new Set(payoutSummary.perJob.map((j) => j.paymentId))
  }, [payoutSummary])

  // Count open invoices for badge
  const openInvoiceCount = useMemo(
    () => vm.invoices.filter((inv) => inv.status !== 'paid' && inv.status !== 'cancelled').length,
    [vm.invoices]
  )

  if (!deferredReady) {
    return (
      <AppShell active="home">
        <ScreenSkeleton variant="detail" eyebrow="Finanzen" />
      </AppShell>
    )
  }

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          <button type="button" onClick={goBack} aria-label="Zurück" className="flex h-9 w-9 items-center justify-center rounded-full bg-surface/80 ring-1 ring-edge"><ArrowLeft size={18} className="text-ink" aria-hidden /></button>
          {/* Payout status fetch error — dismissable, non-blocking */}
          {payoutStatusError !== null && (
            <div className="flex items-center justify-between gap-3 rounded-card bg-amber-50 px-4 py-3 ring-1 ring-amber-200">
              <p className="text-[13px] font-medium text-amber-700">{payoutStatusError}</p>
              <button
                type="button"
                onClick={() => setPayoutStatusError(null)}
                className="shrink-0 text-amber-500 transition hover:text-amber-700"
                aria-label="Schließen"
              >
                <X size={16} aria-hidden />
              </button>
            </div>
          )}
          <DiagnosticDebugBlock diagnostic={payoutDebug} />

          {/* ── Top alert: failed Stripe payouts (Block 7.1D) ── */}
          <PayoutFailureBanner alert={payoutFailureAlert} />

          {/* ── Hero: "Dein Geld" ── */}
          <HeroPayoutCard summary={payoutSummary} />

          {/* ── Global payment mechanism explanation ── */}
          <PaymentMechanismExplainer summary={payoutSummary} />

          {/* ── Bucket breakdown — where money sits across all jobs ── */}
          {payoutSummary && (
            <CraftsmanPayoutSummarySection
              summary={payoutSummary}
              onSetup={handlePayoutSetup}
            />
          )}

          {/* ── Action items — only when craftsman needs to do something ── */}
          <ActionItemsSection actions={actions} />

          {/* ── Per-job payment list — individual jobs with status ── */}
          {payoutSummary && (
            <ActiveJobPaymentsSection
              perJob={payoutSummary.perJob}
              payoutAccount={payoutAccount}
            />
          )}

          {/* ── Recent activity — last 5 ledger events ── */}
          <RecentActivitySection
            entries={vm.ledgerEntries}
            craftsmanPaymentIds={craftsmanPaymentIds}
          />

          {/* ── Quick links ── */}
          <div className="grid grid-cols-2 gap-3">
            <NavigationCard
              to="/craftsman/invoices"
              icon={ReceiptText}
              title="Rechnungen"
              subtitle="Erstellen & prüfen"
              badge={openInvoiceCount > 0 ? openInvoiceCount : undefined}
            />
            <NavigationCard
              to="/craftsman/jobs"
              icon={Euro}
              title="Alle Zahlungen"
              subtitle="Status in Jobs"
              badge={vm.activePayments.length > 0 ? `${vm.activePayments.length} aktiv` : undefined}
            />
          </div>
        </div>
      </section>
    </AppShell>
  )
}
