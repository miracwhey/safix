import type { ReactNode } from 'react'
import { useState } from 'react'
import type { DisputeCenterItem } from '../../lib/disputes'
import type { DisputeStatus } from '../../lib/disputes/types'
import type { DisputeRole } from '../../lib/disputes/disputeSelectors'
import type { Job } from '../../lib/jobs/types'
import {
  getDisputeNextStep,
  getDisputeNextStepForRole,
  getDisputeProgressStep,
} from '../../lib/disputes/disputeSelectors'
import type { MediaArtifactViewModel } from '../../lib/media'
import {
  getPaymentForJob,
  subscribePayments,
  getPaymentStateLabel,
  getPaymentStateDescription,
  formatEuro,
  isPaymentEscrowProtected,
} from '../../lib/payments'
import { resolveJobFeeRate } from '../../lib/shared/feeRate'
import type { Payment } from '../../lib/payments'
import DisputeEvidenceSection from './DisputeEvidenceSection'
import { useStoreSync } from '../../lib/reactive'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'

type Props = {
  item: DisputeCenterItem
  evidenceArtifacts?: MediaArtifactViewModel[]
  role?: DisputeRole
  onRelease?: () => void
  onRefund?: () => void
  onSplit?: (ratio: number) => void
  onAttachEvidence?: () => void
  /** When provided, enables the real Supabase Storage evidence upload flow */
  ownerUserId?: string
  /**
   * Optional job context — used by the description-evidence renderer to
   * derive role labels (Inhaber / Kunde / SaFix) and by callers that need
   * to mount the dispute response composer at the bottom of the card.
   */
  job?: Job
  /**
   * Optional slot rendered after the evidence section. Used by the
   * provider-side and customer-side cards to mount the
   * `DisputeResponseComposer` or the worker hint. Kept as a slot so the
   * resolution card itself stays free of session/role wiring.
   */
  responseSlot?: ReactNode
  /**
   * Optional slot rendered after the next-step guidance. Used by the party
   * surfaces (customer + craftsman, never operator) to mount the
   * `ConsensusSplitSlot` (P4 Teil B). Kept as a slot so the card stays free of
   * session/role/data wiring; the operator's unilateral `SplitResolutionPanel`
   * path below is unaffected (it only renders for `role === 'admin'`).
   */
  consensusSlot?: ReactNode
}

const STEPS: { label: string; statuses: DisputeStatus[] }[] = [
  { label: 'Offen', statuses: ['open', 'customer_waiting', 'provider_waiting'] },
  { label: 'In Prüfung', statuses: ['under_review'] },
  { label: 'Entschieden', statuses: ['resolved', 'closed', 'cancelled'] },
]

function getStatusBadgeClass(status: DisputeStatus, decision?: 'release' | 'refund' | 'split' | 'reject'): string {
  switch (status) {
    case 'open':
      return 'bg-amber-50 text-amber-700'
    case 'customer_waiting':
    case 'provider_waiting':
      return 'bg-orange-50 text-orange-700'
    case 'under_review':
      return 'bg-blue-50 text-blue-700'
    case 'closed':
      return 'bg-slate-100 text-slate-500'
    case 'cancelled':
      return 'bg-slate-100 text-slate-500'
    case 'resolved':
      if (decision === 'release') return 'bg-emerald-50 text-emerald-700'
      if (decision === 'refund') return 'bg-rose-50 text-rose-700'
      if (decision === 'split') return 'bg-amber-50 text-amber-700'
      return 'bg-slate-100 text-slate-500'
  }
}

function PaymentImpactPanel({
  payment,
  jobId,
  splitRatio,
}: {
  payment: Payment | undefined
  jobId: string
  splitRatio?: number
}) {
  if (!payment) return null

  const isHeld = isPaymentEscrowProtected(payment.state)
  // Canonical amount — no payment.amounts fallback for display.
  const canonical = resolveCanonicalAmount(jobId)
  const total = canonical.amount ?? 0

  // For resolved disputes with decision='split', show the recorded split outcome.
  const feeRate = resolveJobFeeRate(jobId)
  if (payment.state === 'released' && splitRatio !== undefined) {
    const craftsmanShare = total * splitRatio * (1 - feeRate)
    const platformFee = total * splitRatio * feeRate
    const customerRefund = total * (1 - splitRatio)

    return (
      <div className="mt-4 rounded-[18px] bg-amber-50 px-4 py-3 ring-1 ring-amber-200/70">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-[0.1em] text-amber-600">
          Aufgeteilt — {Math.round(splitRatio * 100)} / {100 - Math.round(splitRatio * 100)}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-slate-600">Handwerker (Netto)</span>
            <span className="font-semibold text-emerald-700">{formatEuro(craftsmanShare)}</span>
          </div>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-slate-600">Kunden-Rückerstattung</span>
            <span className="font-semibold text-rose-700">{formatEuro(customerRefund)}</span>
          </div>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-slate-500">Plattform-Gebühr</span>
            <span className="font-semibold text-slate-500">{formatEuro(platformFee)}</span>
          </div>
          <div className="mt-1 border-t border-amber-200/80 pt-1.5 flex items-center justify-between text-[12px] text-amber-700">
            <span>Gesamt eingefroren</span>
            <span className="font-semibold">{formatEuro(total)}</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-[18px] bg-slate-50 px-4 py-3 ring-1 ring-slate-200/70">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-400">
            Zahlung
          </div>
          <div className="mt-0.5 text-[14px] font-semibold text-slate-900">
            {getPaymentStateLabel(payment.state)}
          </div>
          <div className="mt-0.5 text-[13px] text-slate-500">
            {getPaymentStateDescription(payment.state)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[16px] font-semibold text-slate-900">
            {formatEuro(total)}
          </div>
          {isHeld ? (
            <div className="mt-0.5 text-[11px] font-semibold text-amber-600">
              Eingefroren
            </div>
          ) : (
            <div className="mt-0.5 text-[11px] font-semibold text-emerald-600">
              Verarbeitet
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Split resolution input panel.
 * Shows ratio slider + live financial breakdown so the operator sees exactly
 * what the decision will do before confirming.
 */
function SplitResolutionPanel({
  totalAmount,
  feeRate,
  onConfirm,
}: {
  totalAmount: number
  feeRate: number
  onConfirm: (ratio: number) => void
}) {
  // ratio = fraction [0–1] of total going to craftsman
  const [craftsmanPct, setCraftsmanPct] = useState(50)

  const ratio = craftsmanPct / 100
  // Display-only preview: shows the operator what the split WOULD look like
  // before they confirm. Authoritative amounts are computed server-side by
  // resolveDisputeWithSplit when the operator submits. totalAmount and feeRate
  // are server-authoritative props (from resolveCanonicalAmount / resolveJobFeeRate).
  const craftsmanNet = totalAmount * ratio * (1 - feeRate)
  const platformFee = totalAmount * ratio * feeRate
  const customerRefund = totalAmount * (1 - ratio)

  const isValid = craftsmanPct > 0 && craftsmanPct < 100

  return (
    <div className="mt-4 rounded-[18px] bg-slate-50 p-4 ring-1 ring-slate-200/70">
      <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-slate-500">
        Aufteilung festlegen
      </div>
      <p className="mt-1 text-[12px] text-slate-500">
        Legt fest, welcher Anteil des eingefrorenen Betrags an den Handwerker freigegeben wird. Der Rest geht als Rückerstattung an den Kunden.
      </p>

      {/* Slider */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-center justify-between text-[12px]">
          <span className="font-semibold text-emerald-700">Handwerker: {craftsmanPct} %</span>
          <span className="font-semibold text-rose-700">Kunde: {100 - craftsmanPct} %</span>
        </div>
        <input
          type="range"
          min={1}
          max={99}
          value={craftsmanPct}
          onChange={(e) => setCraftsmanPct(Number(e.target.value))}
          className="w-full accent-slate-700"
          aria-label="Handwerker-Anteil in Prozent"
        />
        <div className="mt-0.5 flex justify-between text-[10px] text-slate-400">
          <span>1 %</span>
          <span>50 %</span>
          <span>99 %</span>
        </div>
      </div>

      {/* Financial breakdown */}
      <div className="mt-3 space-y-1.5 border-t border-slate-200/80 pt-3">
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-slate-600">Handwerker erhält (Netto)</span>
          <span className="font-semibold text-emerald-700">{formatEuro(craftsmanNet)}</span>
        </div>
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-slate-600">Kunden-Rückerstattung</span>
          <span className="font-semibold text-rose-700">{formatEuro(customerRefund)}</span>
        </div>
        <div className="flex items-center justify-between text-[13px]">
          <span className="text-slate-500">Plattform-Gebühr ({Math.round(feeRate * 100)} %)</span>
          <span className="font-semibold text-slate-500">{formatEuro(platformFee)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between border-t border-slate-200/80 pt-1.5 text-[12px] text-slate-500">
          <span>Eingefroren gesamt</span>
          <span className="font-semibold">{formatEuro(totalAmount)}</span>
        </div>
      </div>

      <button
        onClick={() => isValid && onConfirm(ratio)}
        disabled={!isValid}
        className="mt-3 w-full rounded-xl bg-amber-500 px-3 py-2.5 text-[13px] font-semibold text-white transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Aufteilung bestätigen ({craftsmanPct}% / {100 - craftsmanPct}%)
      </button>
    </div>
  )
}

function ProgressSteps({ status }: { status: DisputeStatus }) {
  const activeStep = getDisputeProgressStep(status)

  return (
    <div className="mt-4 flex items-center">
      {STEPS.map((step, index) => {
        const isCompleted = index < activeStep
        const isActive = index === activeStep
        const isLast = index === STEPS.length - 1

        return (
          <div key={step.label} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                  isCompleted
                    ? 'bg-emerald-500 text-white'
                    : isActive
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-200 text-slate-400'
                }`}
              >
                {isCompleted ? '✓' : index + 1}
              </div>
              <div
                className={`text-[11px] font-semibold ${
                  isActive
                    ? 'text-slate-900'
                    : isCompleted
                      ? 'text-emerald-600'
                      : 'text-slate-400'
                }`}
              >
                {step.label}
              </div>
            </div>

            {!isLast ? (
              <div
                className={`mb-3 h-[2px] flex-1 transition-colors ${
                  isCompleted ? 'bg-emerald-400' : 'bg-slate-200'
                }`}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export default function DisputeResolutionCard({
  item,
  evidenceArtifacts = [],
  role = 'admin',
  onRelease,
  onRefund,
  onSplit,
  ownerUserId,
  job,
  responseSlot,
  consensusSlot,
}: Props) {
  const descriptionEvidence =
    item.dispute.evidence?.filter((e) => e.type === 'description') ?? []
  const [payment, setPayment] = useState<Payment | undefined>(
    () => getPaymentForJob(item.jobId)
  )
  const [showSplitPanel, setShowSplitPanel] = useState(false)

  useStoreSync(
    [subscribePayments],
    () => setPayment(getPaymentForJob(item.jobId)),
  )

  const nextStep =
    role === 'admin'
      ? getDisputeNextStep(
          item.dispute.status,
          item.dispute.decision,
          item.dispute.settlementStatus,
          item.dispute.resolutionType,
        )
      : getDisputeNextStepForRole(
          item.dispute.status,
          role,
          item.dispute.decision,
          item.dispute.settlementStatus,
          item.dispute.resolutionType,
        )

  const isAdmin = role === 'admin'
  const canAct = isAdmin && !item.isResolved
  const splitRatio = item.dispute.splitRatio

  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200 shadow-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-slate-900">
            {item.title}
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            {item.reasonLabel}
          </div>
        </div>

        <div
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${getStatusBadgeClass(
            item.dispute.status,
            item.dispute.decision,
          )}`}
        >
          {item.statusLabel}
        </div>
      </div>

      {/* Progress Steps */}
      <ProgressSteps status={item.dispute.status} />

      {/* Payment Impact */}
      <PaymentImpactPanel
        payment={payment}
        jobId={item.jobId}
        splitRatio={item.dispute.status === 'resolved' && item.dispute.decision === 'split' ? splitRatio : undefined}
      />

      {/* Description */}
      <div className="mt-3 text-[13px] leading-relaxed text-slate-600">
        {item.description}
      </div>

      {/* Evidence */}
      <DisputeEvidenceSection
        artifacts={evidenceArtifacts}
        uploadConfig={
          !item.isResolved && ownerUserId
            ? { disputeId: item.dispute.id, ownerUserId }
            : undefined
        }
        descriptionEvidence={descriptionEvidence}
        job={job}
      />

      {/* Response composer / worker hint slot — mounted by the caller */}
      {responseSlot ?? null}

      {/* Next-step guidance */}
      <div className="mt-4 rounded-[18px] bg-blue-50 px-4 py-3 ring-1 ring-blue-100">
        <div className="text-[12px] font-semibold uppercase tracking-[0.1em] text-blue-500">
          Nächster Schritt
        </div>
        <div className="mt-1 text-[13px] text-blue-800">{nextStep}</div>
      </div>

      {/* Consensus-split party panel (P4 Teil B) — mounted by party surfaces
          only when VITE_CONSENSUS_SPLIT_ENABLED is on. Null for the operator,
          whose unilateral SplitResolutionPanel path stays below. */}
      {consensusSlot ?? null}

      {/* Action buttons — admin only, unresolved disputes */}
      {canAct && (onRelease || onRefund || onSplit) ? (
        <div className="mt-4 space-y-2">
          <div className="flex gap-2">
            {onRelease && (
              <button
                onClick={onRelease}
                className="flex-1 rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-white transition active:scale-[0.97]"
              >
                Freigeben
              </button>
            )}
            {onRefund && (
              <button
                onClick={onRefund}
                className="flex-1 rounded-xl bg-rose-500 px-3 py-2 text-sm font-semibold text-white transition active:scale-[0.97]"
              >
                Rückerstatten
              </button>
            )}
            {onSplit && (
              <button
                onClick={() => setShowSplitPanel((v) => !v)}
                className={`flex-1 rounded-xl px-3 py-2 text-sm font-semibold transition active:scale-[0.97] ${
                  showSplitPanel
                    ? 'bg-amber-500 text-white'
                    : 'bg-amber-50 text-amber-700 ring-1 ring-amber-300'
                }`}
              >
                Aufteilen
              </button>
            )}
          </div>

          {showSplitPanel && onSplit && payment && (
            <SplitResolutionPanel
              totalAmount={resolveCanonicalAmount(item.jobId).amount ?? 0}
              feeRate={resolveJobFeeRate(item.jobId)}
              onConfirm={(ratio) => {
                setShowSplitPanel(false)
                onSplit(ratio)
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}
