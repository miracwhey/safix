import { useState } from 'react'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import { formatEuro } from '../../lib/payments/selectors'
import { getFundingRequestByJobId, subscribeFundingRequests, isFundingRequestRepositoryHydrated, isFundingRequestTerminalDead } from '../../lib/payments/fundingRequest'
import { getEscrowPlanByJobId, getEscrowTranches, subscribeEscrowPlans, isEscrowPlanRepositoryHydrated } from '../../lib/payments/escrow'
import { getDisputeByJobId, subscribeDisputes, isDisputeRepositoryHydrated } from '../../lib/disputes'
import {
  canOpenDisputeForPaymentState,
  deriveCustomerDisputeDisplay,
  type CustomerDisputeDisplayTone,
} from '../../lib/disputes/disputeSelectors'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'
import { useStoreSync } from '../../lib/reactive'
import type { PaymentState } from '../../lib/payments/types'
import type { EscrowTrancheKind } from '../../lib/payments/escrow/escrowTypes'

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

type PaymentStatusDisplay = {
  label: string
  color: string
  icon: string
}

type TrancheInfo = {
  kind: EscrowTrancheKind
  amount: number
  label: string
}

type DisputeDisplay = {
  label: string
  color: string
}

type Cta = {
  label: string
}

type PaymentSummaryVm = {
  statusDisplay: PaymentStatusDisplay
  totalAmount: string
  tranches: TrancheInfo[]
  disputeDisplay: DisputeDisplay
  cta: Cta | null
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

function deriveStatusDisplay(
  paymentState: PaymentState,
  fundingStatus: string | undefined,
): PaymentStatusDisplay {
  if (paymentState === 'deposit_required') {
    if (fundingStatus === 'funded') {
      return { label: 'Im Stripe-Absicherung gesichert', color: 'text-emerald-700', icon: '🔒' }
    }
    if (fundingStatus === 'funding_started' || fundingStatus === 'funding_initiated') {
      return { label: 'Einzahlung wird verarbeitet', color: 'text-amber-700', icon: '⏳' }
    }
    // Terminal-dead funding (expired / cancelled): never present this as a
    // pending einzahlung — the request can no longer be paid. deriveCta already
    // returns null for deposit_required, so no pay-now CTA fires here.
    if (isFundingRequestTerminalDead(fundingStatus)) {
      return { label: 'Zahlungsanfrage abgelaufen', color: 'text-slate-600', icon: '⌛' }
    }
    return { label: 'Einzahlung ausstehend', color: 'text-amber-700', icon: '💳' }
  }
  if (
    paymentState === 'deposit_paid' ||
    paymentState === 'in_escrow' ||
    paymentState === 'work_in_progress'
  ) {
    return { label: 'Im Stripe-Absicherung gesichert', color: 'text-emerald-700', icon: '🔒' }
  }
  if (paymentState === 'release_pending') {
    return { label: 'Freigabe ausstehend', color: 'text-amber-700', icon: '⌛' }
  }
  if (paymentState === 'released') {
    return { label: 'Zahlung abgeschlossen', color: 'text-emerald-700', icon: '✅' }
  }
  if (paymentState === 'refunded') {
    return { label: 'Betrag erstattet', color: 'text-amber-700', icon: '↩️' }
  }
  if (paymentState === 'disputed') {
    return { label: 'Zahlung eingefroren', color: 'text-rose-700', icon: '⚖️' }
  }
  return { label: 'Zahlung aktiv', color: 'text-slate-600', icon: '💳' }
}

// The money-state derivation (incl. settlementStatus awareness) lives in
// deriveCustomerDisputeDisplay (selector layer). The card only maps the
// resulting semantic tone to a Tailwind colour token.
const DISPUTE_TONE_COLOR: Record<CustomerDisputeDisplayTone, string> = {
  none: 'text-slate-400',
  open: 'text-rose-600',
  waiting: 'text-orange-600',
  review: 'text-violet-600',
  settling: 'text-amber-600',
  resolved: 'text-emerald-600',
  cancelled: 'text-slate-500',
}

function getTranchLabel(kind: EscrowTrancheKind): string {
  return kind === 'deposit_release' ? '25 % bei Arbeitsbeginn' : '75 % bei Fertigstellung'
}

function deriveCta(
  paymentState: PaymentState,
  hasDispute: boolean,
  canOpenDispute: boolean,
): Cta | null {
  if (paymentState === 'deposit_required') {
    // CustomerEscrowFundingCard is the sole canonical actor for all deposit_required states.
    // This card is purely informational here — never show a competing CTA.
    return null
  }
  if (paymentState === 'release_pending') {
    return { label: 'Freigabe prüfen →' }
  }
  if (!hasDispute && canOpenDispute) {
    return { label: 'Konflikt öffnen →' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Build vm
// ---------------------------------------------------------------------------

function buildVm(jobId: string): PaymentSummaryVm | null {
  // Hydration gate (Z.125): never derive a payment status or a "Kein Konflikt"
  // dispute state from a repository that has not finished its initial load.
  // deriveStatusDisplay reads the funding repo and amount/tranches read the
  // escrow repo, so all four payment-readiness repos must be hydrated — the
  // canonical 3-repo payment set (payment + funding + escrow, mirroring
  // homeState.ts:206 / the screen's paymentReady flag) plus the dispute repo.
  // Without the funding/escrow gate, a funded deposit_required job briefly
  // shows "Einzahlung ausstehend" on cold load. Render nothing until ready.
  if (
    !isPaymentRepositoryHydrated() ||
    !isDisputeRepositoryHydrated() ||
    !isFundingRequestRepositoryHydrated() ||
    !isEscrowPlanRepositoryHydrated()
  ) {
    return null
  }

  const payment = getPaymentForJob(jobId)
  if (!payment || payment.state === 'none') return null

  const fundingRequest = getFundingRequestByJobId(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)
  const dispute = getDisputeByJobId(jobId)
  const hasDispute = !!dispute
  const canOpenDispute = canOpenDisputeForPaymentState(payment.state)

  const statusDisplay = deriveStatusDisplay(payment.state, fundingRequest?.status)

  // Amount: via canonical resolver (escrow → offer → job, never payment.amounts directly)
  const canonicalAmount = resolveCanonicalAmount(jobId)
  const totalAmount = canonicalAmount.formatted

  // Tranches: only show if plan exists and has more than one tranche
  const tranches: TrancheInfo[] = []
  if (escrowPlan) {
    const raw = getEscrowTranches(escrowPlan.id)
    if (raw.length > 1) {
      for (const t of raw) {
        tranches.push({
          kind: t.kind,
          amount: t.amount,
          label: getTranchLabel(t.kind),
        })
      }
    }
  }

  const customerDisputeDisplay = deriveCustomerDisputeDisplay(dispute)
  const disputeDisplay: DisputeDisplay = {
    label: customerDisputeDisplay.label,
    color: DISPUTE_TONE_COLOR[customerDisputeDisplay.tone],
  }
  const cta = deriveCta(payment.state, hasDispute, canOpenDispute)

  return { statusDisplay, totalAmount, tranches, disputeDisplay, cta }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function CustomerPaymentSummaryCardView({ vm, onCtaClick }: { vm: PaymentSummaryVm; onCtaClick?: () => void }) {
  const { statusDisplay, totalAmount, tranches, disputeDisplay, cta } = vm

  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/80 shadow-[0_2px_8px_-6px_rgba(2,6,23,0.07)]">
      {/* ── Status + Amount row ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-[15px] leading-none">{statusDisplay.icon}</span>
          <span className={`text-[14px] font-semibold ${statusDisplay.color}`}>
            {statusDisplay.label}
          </span>
        </div>
        <span className="shrink-0 text-[15px] font-bold text-slate-900">
          {totalAmount}
        </span>
      </div>

      {/* ── Tranche structure ── */}
      {tranches.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
          {tranches.map((t) => (
            <div key={t.kind} className="flex items-center gap-1">
              <span className="text-[11px] font-medium text-slate-400">{t.label}</span>
              <span className="text-[12px] font-semibold text-slate-700">
                {formatEuro(t.amount)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* ── Divider ── */}
      <div className="my-3 border-t border-slate-100" />

      {/* ── Konflikt + CTA row ── */}
      <div className="flex items-center justify-between gap-3">
        <span className={`text-[12px] font-medium ${disputeDisplay.color}`}>
          {disputeDisplay.label}
        </span>
        {cta && (
          <button
            type="button"
            onClick={onCtaClick}
            className="text-[12px] font-semibold text-blue-600 active:opacity-70"
          >
            {cta.label}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export default function CustomerPaymentSummaryCard({
  jobId,
  onCtaClick,
}: {
  jobId: string
  onCtaClick?: () => void
}) {
  const [vm, setVm] = useState<PaymentSummaryVm | null>(() => buildVm(jobId))

  useStoreSync(
    [subscribePayments, subscribeDisputes, subscribeFundingRequests, subscribeEscrowPlans],
    () => setVm(buildVm(jobId))
  )

  if (!vm) return null

  return <CustomerPaymentSummaryCardView vm={vm} onCtaClick={onCtaClick} />
}
