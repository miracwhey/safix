import { useState, useRef } from 'react'
import CraftsmanSectionCard from '../CraftsmanSectionCard'
import PaymentTimeline from './PaymentTimeline'
import {
  getPaymentStateDescription,
  getPaymentStateLabel,
  isPaymentEscrowProtected,
  getPaymentActionAvailability,
} from '../../lib/payments/selectors'
import { getPaymentForJobWorkflow } from '../../lib/workflow'
import { subscribePayments } from '../../lib/payments'
import {
  getDisputeByJobId,
  getDisputeReasonLabel,
  getDisputeStatusLabelFor,
  subscribeDisputes,
  type Dispute,
} from '../../lib/disputes'
import {
  releaseEscrowWorkflow,
  disputePaymentWorkflow,
  refundEscrowWorkflow,
} from '../../lib/workflow'
import type { Payment } from '../../lib/payments/types'
import { useStoreSync } from '../../lib/reactive'
import { useSession } from '../../hooks/useSession'
import { getActionablePaymentState } from '../../lib/jobs/helpers'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { resolveCommercialDisplayContext } from '../../lib/shared/canonicalCommercialDisplay'
import { resolveMoneyFlowProjection } from '../../lib/payments/moneyFlowProjection'
import { isPaymentRepositoryHydrated } from '../../lib/payments'

type Props = {
  jobId: string
}

/**
 * Consolidated payment card that merges `PaymentFlowCard` and
 * `PaymentActionsCard` into a single `CraftsmanSectionCard`.
 *
 * Shows the payment state banner, amount breakdown, payment timeline, dispute
 * info, and all available escrow action buttons — all in one surface.
 */
export default function PaymentOperationsCard({ jobId }: Props) {
  const { user } = useSession()
  const [job, setJob] = useState(() => getJobById(jobId))
  const [payment, setPayment] = useState<Payment | undefined>(
    () => getPaymentForJobWorkflow(jobId)
  )
  const [dispute, setDispute] = useState<Dispute | undefined>(
    () => getDisputeByJobId(jobId)
  )
  const [isReleasing, setIsReleasing] = useState(false)
  const [isRefunding, setIsRefunding] = useState(false)
  const [isDisputing, setIsDisputing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  // useRef guards prevent double-submit on rapid taps — unlike useState, refs
  // are updated synchronously before the async call, so a second tap in the
  // same render cycle sees the lock already set.
  const releasingRef = useRef(false)
  const refundingRef = useRef(false)
  const disputingRef = useRef(false)

  useStoreSync(
    [subscribePayments, subscribeDisputes, subscribeJobs],
    () => {
      setJob(getJobById(jobId))
      setPayment(getPaymentForJobWorkflow(jobId))
      setDispute(getDisputeByJobId(jobId))
    }
  )

  if (!job || !payment) return null

  // Hydration guard: do not derive CTA availability until payment repository
  // has finished its initial load.  An unhydrated cache could surface stale
  // action states that resolve to different values once data arrives.
  if (!isPaymentRepositoryHydrated()) return null

  const effectivePaymentState = getActionablePaymentState(job, payment)
  if (!effectivePaymentState) return null

  // Canonical commercial display — no payment.amounts fallbacks.
  // payment.amounts is engine-internal only (legacy 25/75 deposit model).
  const commercial = resolveCommercialDisplayContext(jobId)
  const displayTotal = commercial.orderValue.amount ?? 0
  const displayTotalFormatted = commercial.orderValue.formatted
  const depositReleaseFormatted = commercial.depositReleaseFormatted
  const finalReleaseFormatted = commercial.finalReleaseFormatted
  const depositRelease = commercial.depositRelease ?? 0
  const depositReleasePercent = displayTotal > 0 ? Math.round((depositRelease / displayTotal) * 100) : 0

  const state = effectivePaymentState
  const escrowProtected = isPaymentEscrowProtected(state)
  const isDisputed = state === 'disputed'
  const isRefunded = state === 'refunded'
  const isReleased = state === 'released'

  const actions = getPaymentActionAvailability(state)
  // Gate release on payout readiness — a release CTA must not be shown
  // when the provider cannot receive funds (matches CraftsmanJobOperationsCard truth).
  const mfProjection = resolveMoneyFlowProjection(jobId)
  const payoutReady = mfProjection
    ? !mfProjection.tranches.some((t) => t.isEligible && t.isBlocked)
    : true
  const canRelease = actions.canRelease && payoutReady
  const canDispute = actions.canDispute
  const canRefund = actions.canRefund
  const hasActions = canRelease || canDispute || canRefund

  const handleRelease = async () => {
    // Synchronous ref guard prevents double-submit in the same render cycle
    if (releasingRef.current) return
    releasingRef.current = true
    setIsReleasing(true)
    setActionError(null)
    try {
      await releaseEscrowWorkflow(jobId, undefined, undefined, 'provider')
    } catch (e) {
      console.error(e)
      setActionError('Freigabe fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      releasingRef.current = false
      setIsReleasing(false)
    }
  }

  const handleRefund = async () => {
    if (refundingRef.current) return
    refundingRef.current = true
    setIsRefunding(true)
    setActionError(null)
    try {
      await refundEscrowWorkflow(jobId)
    } catch (e) {
      console.error(e)
      setActionError('Erstattung fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      refundingRef.current = false
      setIsRefunding(false)
    }
  }

  const handleDispute = async () => {
    if (disputingRef.current) return
    disputingRef.current = true
    setIsDisputing(true)
    setActionError(null)
    try {
      await disputePaymentWorkflow(jobId, user?.id)
    } catch (e) {
      console.error(e)
      setActionError('Konflikt konnte nicht eröffnet werden. Bitte erneut versuchen.')
    } finally {
      disputingRef.current = false
      setIsDisputing(false)
    }
  }

  return (
    <CraftsmanSectionCard
      eyebrow="Zahlungsübersicht"
      title={getPaymentStateLabel(state)}
      subtitle={getPaymentStateDescription(state)}
    >
      <div className="space-y-5">
        {/* ── State banners ── */}
        {escrowProtected && (
          <div className="flex items-center gap-2 rounded-2xl bg-blue-50 px-4 py-3 ring-1 ring-blue-100">
            <span className="text-[18px]">🔒</span>
            <div>
              <div className="text-[13px] font-semibold text-blue-800">
                Zahlungs-Schutz aktiv
              </div>
              <div className="text-[12px] text-blue-600">
                SaFix sichert den Betrag bis zur Freigabe.
              </div>
            </div>
          </div>
        )}

        {isReleased && (() => {
          const mf = resolveMoneyFlowProjection(jobId)
          if (mf?.requiresReconciliation) {
            const ps = mf.payoutStatus
            const title = ps === 'payout_failed'
              ? 'Auszahlung fehlgeschlagen'
              : ps === 'transfer_reversed'
              ? 'Überweisung storniert'
              : 'Klärung erforderlich'
            const subtitle = ps === 'payout_failed'
              ? 'Auszahlung vom Bankkonto zurückgewiesen. SaFix prüft den Fall.'
              : ps === 'transfer_reversed'
              ? 'Transfer wurde von Stripe storniert. SaFix prüft den Fall.'
              : 'Freigabe registriert, Transfer wird abgeglichen. Kein Handlungsbedarf.'
            return (
              <div className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-100">
                <span className="text-[18px]">⚠️</span>
                <div>
                  <div className="text-[13px] font-semibold text-amber-800">
                    {title}
                  </div>
                  <div className="text-[12px] text-amber-600">
                    {subtitle}
                  </div>
                </div>
              </div>
            )
          }
          const payoutStatus = mf?.payoutStatus
          const isPaidOut = payoutStatus === 'payout_completed'
          const hasTransfer = payoutStatus === 'transfer_triggered'
            || payoutStatus === 'payout_in_transit'
            || isPaidOut
          return (
            <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-100">
              <span className="text-[18px]">✅</span>
              <div>
                <div className="text-[13px] font-semibold text-emerald-800">
                  {isPaidOut ? 'Auf deinem Konto' : 'Zahlung freigegeben'}
                </div>
                <div className="text-[12px] text-emerald-600">
                  {isPaidOut
                    ? 'Betrag wurde auf dein Bankkonto ausgezahlt.'
                    : hasTransfer
                    ? 'Betrag an das Auszahlungskonto übergeben. Bankauszahlung erfolgt gemäß Stripe-Zeitplan.'
                    : 'Betrag wurde freigegeben. Übergabe ans Auszahlungskonto folgt.'}
                </div>
              </div>
            </div>
          )
        })()}

        {isRefunded && (
          <div className="flex items-center gap-2 rounded-2xl bg-rose-50 px-4 py-3 ring-1 ring-rose-100">
            <span className="text-[18px]">↩️</span>
            <div>
              <div className="text-[13px] font-semibold text-rose-800">
                Zahlung erstattet
              </div>
              <div className="text-[12px] text-rose-600">
                Betrag wurde an den Kunden zurückerstattet.
              </div>
            </div>
          </div>
        )}

        {/* ── Amount rows ── */}
        <div className="divide-y divide-slate-100">
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[13px] text-slate-500">Gesamtbetrag</span>
            <span className="text-[14px] font-semibold text-slate-900">
              {displayTotalFormatted}
            </span>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[13px] text-slate-500">
              Freigabe Arbeitsbeginn ({depositReleasePercent} %)
            </span>
            <span className="text-[14px] font-medium text-slate-700">
              {depositReleaseFormatted}
            </span>
          </div>
          <div className="flex items-center justify-between py-2.5">
            <span className="text-[13px] text-slate-500">Freigabe Fertigstellung</span>
            <span className="text-[14px] font-medium text-slate-700">
              {finalReleaseFormatted}
            </span>
          </div>
        </div>

        {/* ── Payment timeline ── */}
        <div>
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Zahlungsverlauf
          </div>
          <PaymentTimeline state={state} />
        </div>

        {/* ── Dispute info ── */}
        {isDisputed && dispute && (
          <div className="rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-100">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold text-amber-800">
              <span className="text-[16px]">⚠️</span>
              Konflikt – {getDisputeStatusLabelFor(dispute)}
            </div>
            <div className="mt-1 text-[12px] text-amber-700">
              Grund:{' '}
              <span className="font-medium">
                {getDisputeReasonLabel(dispute.reason)}
              </span>
            </div>
            <div className="mt-1.5 text-[12px] text-amber-600">
              {dispute.description}
            </div>
          </div>
        )}

        {/* ── Action buttons ── */}
        {hasActions && (
          <div className="space-y-3 border-t border-slate-100 pt-4">
            {canRelease && (
              <button
                onClick={() => void handleRelease()}
                disabled={isReleasing || isRefunding || isDisputing}
                className="w-full rounded-2xl bg-emerald-600 px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {isReleasing ? 'Wird freigegeben …' : 'Bestätigen & freigeben'}
              </button>
            )}

            {canDispute && (
              <button
                onClick={() => void handleDispute()}
                disabled={isReleasing || isRefunding || isDisputing}
                className="w-full rounded-2xl bg-amber-500 px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {isDisputing ? 'Konflikt wird eröffnet …' : 'Konflikt eröffnen'}
              </button>
            )}

            {canRefund && (
              <button
                onClick={() => void handleRefund()}
                disabled={isReleasing || isRefunding || isDisputing}
                className="w-full rounded-2xl bg-rose-600 px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60"
              >
                {isRefunding ? 'Wird erstattet …' : 'Zahlung erstatten'}
              </button>
            )}

            {actionError && (
              <p className="text-[12px] leading-relaxed text-red-500">{actionError}</p>
            )}
          </div>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
