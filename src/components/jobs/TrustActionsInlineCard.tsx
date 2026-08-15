import { useState, useRef } from 'react'
import { getPaymentForJob, subscribePayments, isPaymentRepositoryHydrated } from '../../lib/payments'
import {
  getPaymentStateLabel,
  getPaymentStateDescription,
} from '../../lib/payments/selectors'
import {
  getDisputeByJobId,
  getDisputeReasonLabel,
  subscribeDisputes,
} from '../../lib/disputes'
import type { Payment } from '../../lib/payments'
import {
  releaseEscrowWorkflow,
  disputePaymentWorkflow,
  customerReleasePaymentWorkflow,
} from '../../lib/workflow'
import { useStoreSync } from '../../lib/reactive'
import { useSession } from '../../hooks/useSession'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'
import {
  getAcceptanceByJobId,
  subscribeAcceptances,
} from '../../lib/acceptance'
import { deriveAcceptanceDeadlineLabel } from '../../lib/payments/moneyFlowProjection'

type Props = {
  jobId: string
  /**
   * 'customer' — hides the conflict action button and uses the
   * customer-side release workflow (sets paymentReleasedAt on the job).
   * Default (undefined / 'craftsman') — preserves legacy behaviour.
   */
  role?: 'customer' | 'craftsman'
}

type TrustVariant =
  | 'disputed'
  | 'release_pending'
  | 'escrow_active'
  | 'released'
  | 'refunded'
  | 'deposit_required'
  | 'deposit_paid'

type VariantStyle = {
  card: string
  accentBar: string
  eyebrow: string
  icon: string
  amountBadge: string
}

function getVariantStyle(variant: TrustVariant): VariantStyle {
  switch (variant) {
    case 'disputed':
      return {
        card: 'bg-white ring-amber-200/80',
        accentBar: 'bg-gradient-to-b from-amber-500 via-amber-400 to-amber-300',
        eyebrow: 'text-amber-600',
        icon: '🔒',
        amountBadge: 'bg-amber-50 text-amber-700 ring-amber-200',
      }
    case 'release_pending':
      return {
        card: 'bg-white ring-emerald-200/80',
        accentBar: 'bg-gradient-to-b from-emerald-500 via-emerald-400 to-emerald-300',
        eyebrow: 'text-emerald-600',
        icon: '✅',
        amountBadge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
      }
    case 'escrow_active':
      return {
        card: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300',
        eyebrow: 'text-blue-500',
        icon: '🔐',
        amountBadge: 'bg-blue-50 text-blue-700 ring-blue-200',
      }
    case 'released':
      return {
        card: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-emerald-400 via-emerald-300 to-emerald-200',
        eyebrow: 'text-emerald-500',
        icon: '✓',
        amountBadge: 'bg-slate-50 text-slate-500 ring-slate-200',
      }
    case 'refunded':
      return {
        card: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-slate-400 via-slate-300 to-slate-200',
        eyebrow: 'text-slate-400',
        icon: '↩',
        amountBadge: 'bg-slate-50 text-slate-500 ring-slate-200',
      }
    case 'deposit_required':
      return {
        card: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-blue-400 via-blue-300 to-blue-200',
        eyebrow: 'text-blue-500',
        icon: '💳',
        amountBadge: 'bg-blue-50 text-blue-700 ring-blue-200',
      }
    case 'deposit_paid':
      return {
        card: 'bg-white ring-slate-200/70',
        accentBar: 'bg-gradient-to-b from-blue-500 via-blue-400 to-blue-300',
        eyebrow: 'text-blue-500',
        icon: '📥',
        amountBadge: 'bg-blue-50 text-blue-700 ring-blue-200',
      }
  }
}

function deriveVariant(payment: Payment): TrustVariant {
  switch (payment.state) {
    case 'disputed':
      return 'disputed'
    case 'release_pending':
      return 'release_pending'
    case 'in_escrow':
    case 'work_in_progress':
      return 'escrow_active'
    case 'released':
      return 'released'
    case 'refunded':
      return 'refunded'
    case 'deposit_required':
      return 'deposit_required'
    case 'deposit_paid':
      return 'deposit_paid'
    // 'none' is only used on Project.paymentState for projects without payment
    // activity. Payment objects always start with 'deposit_required'. This case
    // satisfies TypeScript exhaustiveness but is unreachable at runtime.
    case 'none':
      return 'deposit_required'
    // Diagnosis payments use a separate path — fall back to deposit_required
    // so this card is not shown for diagnosis jobs.
    case 'diagnosis_payment_pending':
    case 'diagnosis_payment_completed':
      return 'deposit_required'
  }
}

function getVariantLabel(variant: TrustVariant): string {
  switch (variant) {
    case 'disputed':
      return 'Zahlung eingefroren'
    case 'release_pending':
      return 'Freigabe angefordert'
    case 'escrow_active':
      return 'Zahlung aktiv'
    case 'released':
      return 'Zahlung abgeschlossen'
    case 'refunded':
      return 'Zahlung erstattet'
    case 'deposit_required':
      return 'Einzahlung ausstehend'
    case 'deposit_paid':
      return 'Einzahlung bestätigt'
  }
}

export default function TrustActionsInlineCard({ jobId, role }: Props) {
  const { user } = useSession()
  const [payment, setPayment] = useState(
    () => getPaymentForJob(jobId)
  )
  const [dispute, setDispute] = useState(
    () => getDisputeByJobId(jobId)
  )
  const [acceptance, setAcceptance] = useState(
    () => getAcceptanceByJobId(jobId)
  )
  const [isHydrated, setIsHydrated] = useState(() => isPaymentRepositoryHydrated())
  const [isReleasing, setIsReleasing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [isDisputing, setIsDisputing] = useState(false)
  const [disputeError, setDisputeError] = useState<string | null>(null)

  // Synchronous ref guards prevent double-submit in the same render cycle.
  const releasingRef = useRef(false)
  const disputingRef = useRef(false)

  useStoreSync(
    [subscribePayments, subscribeDisputes, subscribeAcceptances],
    () => {
      setPayment(getPaymentForJob(jobId))
      setDispute(getDisputeByJobId(jobId))
      setAcceptance(getAcceptanceByJobId(jobId))
      setIsHydrated(isPaymentRepositoryHydrated())
    },
  )

  if (!payment) return null

  // Canonical display — no payment.amounts fallback.
  const canonical = resolveCanonicalAmount(jobId)
  const displayAmount = canonical.formatted

  const variant = deriveVariant(payment)
  const styles = getVariantStyle(variant)
  const label = getVariantLabel(variant)
  const description = getPaymentStateDescription(payment.state)
  const stateLabel = getPaymentStateLabel(payment.state)
  const deadlineLabel = deriveAcceptanceDeadlineLabel(
    acceptance?.expiresAt ?? null,
    variant === 'released' || variant === 'refunded',
  )

  const handleRelease = async () => {
    if (releasingRef.current) return
    releasingRef.current = true
    setIsReleasing(true)
    setReleaseError(null)
    try {
      if (role === 'customer') {
        await customerReleasePaymentWorkflow(jobId)
      } else {
        await releaseEscrowWorkflow(jobId, undefined, undefined, 'provider')
      }
    } catch (e) {
      console.error(e)
      setReleaseError('Freigabe fehlgeschlagen. Bitte erneut versuchen.')
    } finally {
      releasingRef.current = false
      setIsReleasing(false)
    }
  }

  const handleDispute = async () => {
    if (disputingRef.current) return
    disputingRef.current = true
    setIsDisputing(true)
    setDisputeError(null)
    try {
      await disputePaymentWorkflow(jobId, user?.id)
    } catch (e) {
      console.error(e)
      setDisputeError('Konflikt konnte nicht eröffnet werden. Bitte erneut versuchen.')
    } finally {
      disputingRef.current = false
      setIsDisputing(false)
    }
  }

  return (
    <section
      className={`relative overflow-hidden rounded-[24px] p-4 ring-1 shadow-[0_12px_32px_-20px_rgba(2,6,23,0.22)] ${styles.card}`}
    >
      {/* Left accent bar */}
      <div
        className={`pointer-events-none absolute left-0 top-0 h-full w-[4px] rounded-l-[24px] ${styles.accentBar}`}
      />

      {/* Header row: eyebrow + amount badge */}
      <div className="flex items-center justify-between">
        <span
          className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${styles.eyebrow}`}
        >
          Zahlungsstatus
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ${styles.amountBadge}`}
        >
          {displayAmount}
        </span>
      </div>

      {/* Icon + state label row */}
      <div className="mt-2.5 flex items-center gap-2.5">
        <span className="text-[20px] leading-none">{styles.icon}</span>
        <h3 className="text-[16px] font-semibold leading-snug text-slate-900">
          {label}
        </h3>
      </div>

      {/* State description */}
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
        {description}
      </p>

      {/* Disputed: dispute reason detail */}
      {variant === 'disputed' && dispute ? (
        <div className="mt-3 rounded-[16px] bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200/80">
          <p className="text-[12px] font-medium text-amber-700">
            Grund: {getDisputeReasonLabel(dispute.reason)}
          </p>
          <p className="mt-0.5 text-[12px] text-amber-600">
            In Prüfung durch SaFix · {stateLabel}
          </p>
        </div>
      ) : null}

      {/* Escrow active: waiting context */}
      {variant === 'escrow_active' ? (
        <p className="mt-1.5 text-[12px] text-slate-400">
          Betrag gesichert: {displayAmount}
        </p>
      ) : null}

      {/* Release pending: waiting context + deadline */}
      {variant === 'release_pending' ? (
        <>
          <p className="mt-1.5 text-[12px] text-slate-400">
            Auf Kundenfreigabe warten
          </p>
          {deadlineLabel ? (
            <p className="mt-1 text-[11px] font-medium text-emerald-500">
              ⏱ {deadlineLabel}
            </p>
          ) : null}
        </>
      ) : null}

      {/* Action buttons — only rendered after repository is hydrated to prevent
          stale-cache CTAs from appearing before canonical payment state is confirmed. */}
      {variant === 'release_pending' && isHydrated ? (
        <>
          <button
            type="button"
            disabled={isReleasing || isDisputing}
            onClick={() => void handleRelease()}
            className="mt-3 w-full rounded-2xl bg-emerald-600 px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {isReleasing ? 'Wird freigegeben …' : 'Bestätigen & freigeben'}
          </button>
          {releaseError && (
            <p className="mt-1.5 text-[12px] text-red-500">{releaseError}</p>
          )}
        </>
      ) : null}

      {variant === 'escrow_active' && role !== 'customer' && isHydrated ? (
        <>
          <button
            type="button"
            disabled={isDisputing || isReleasing}
            onClick={() => void handleDispute()}
            className="mt-3 w-full rounded-2xl bg-amber-500 px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            {isDisputing ? 'Konflikt wird eröffnet …' : 'Konflikt melden'}
          </button>
          {disputeError && (
            <p className="mt-1.5 text-[12px] text-red-500">{disputeError}</p>
          )}
        </>
      ) : null}
    </section>
  )
}
