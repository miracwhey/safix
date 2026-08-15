import { useEffect, useState } from 'react'
import {
  Banknote,
  CheckCircle,
  Clock,
  Scale,
  AlertTriangle,
  Lock,
  Circle,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { Icon } from '../primitives'
import { resolveMoneyFlowProjection, type MoneyFlowProjection, type TrancheProjection } from '../../lib/payments/moneyFlowProjection'
import { resolveCanonicalAmount } from '../../lib/shared/canonicalAmountResolver'
import { subscribeTimeline } from '../../lib/timeline'
import { getJobById, subscribeJobs } from '../../lib/jobs'
import { getAcceptanceByJobId } from '../../lib/acceptance'
import {
  deriveCustomerReleaseProgressViewModel,
  type CustomerReleaseProgressViewModel,
} from '../../lib/projects/customerReleaseProgressViewModel'
import type { EscrowTranche } from '../../lib/payments/escrow/escrowTypes'

type Props = {
  jobId: string
}

// ── Tranche presentation helpers (icon/color only — no business logic) ────

function getTrancheStatusIcon(status: EscrowTranche['status']): { label: string; icon: LucideIcon; color: string } {
  switch (status) {
    case 'released':
      return { label: 'Freigegeben', icon: Banknote, color: 'text-emerald-700' }
    case 'eligible_for_release':
      return { label: 'Freigabe möglich', icon: CheckCircle, color: 'text-emerald-600' }
    case 'release_pending':
      return { label: 'Freigabe läuft', icon: Clock, color: 'text-blue-700' }
    case 'disputed':
      return { label: 'Streitfall', icon: Scale, color: 'text-red-700' }
    case 'blocked':
      return { label: 'Blockiert', icon: AlertTriangle, color: 'text-amber-700' }
    case 'funded':
      return { label: 'In Zahlung', icon: Lock, color: 'text-slate-600' }
    case 'pending_funding':
      return { label: 'Einzahlung ausstehend', icon: Clock, color: 'text-slate-500' }
    default:
      return { label: status, icon: Circle, color: 'text-slate-500' }
  }
}

/**
 * Format the remaining time until `expiresAt` in a customer-friendly
 * German label (e.g. "noch 14 Std", "noch 45 Min", "abgelaufen").
 */
function formatRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return 'abgelaufen'
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 60) return `noch ${totalMin} Min`
  const totalHours = Math.floor(totalMin / 60)
  if (totalHours < 48) return `noch ${totalHours} Std`
  const days = Math.floor(totalHours / 24)
  return `noch ${days} Tage`
}

// ── Plan status badge — derived from MoneyFlowProjection fields ───────────

function derivePlanBadge(mfp: MoneyFlowProjection): { label: string; accent: string } {
  if (mfp.isTerminal && mfp.releasedPercent === 100) {
    return { label: 'Vollständig freigegeben', accent: 'bg-emerald-50 text-emerald-800 ring-emerald-200' }
  }
  if (mfp.releasedPercent > 0) {
    return { label: 'Teilweise freigegeben', accent: 'bg-emerald-50 text-emerald-700 ring-emerald-200' }
  }
  if (mfp.isDisputed) {
    return { label: 'Streitfall', accent: 'bg-red-50 text-red-700 ring-red-200' }
  }
  if (mfp.isTerminal) {
    // Terminal without releases = refunded or cancelled
    return { label: 'Abgeschlossen', accent: 'bg-slate-50 text-slate-600 ring-slate-200' }
  }
  return { label: 'In Zahlung abgesichert', accent: 'bg-blue-50 text-blue-700 ring-blue-200' }
}

/**
 * Customer-facing release progress card.
 *
 * Shows per-tranche release progress — funded, eligible, released —
 * so the customer understands exactly where their money stands.
 *
 * DATA SOURCES:
 * - Per-tranche status + released amount: MoneyFlowProjection (canonical)
 * - "Gesamtbetrag" total: resolveCanonicalAmount (order-scope, same as
 *   CustomerPaymentSummaryCard — includes ChangeOrder delta)
 * - Payout-outcome signals: timeline subscription keeps payoutStatus and
 *   per-tranche releasedAt fresh without requiring a parent re-render.
 *
 * Visibility: renders from funded_in_escrow onwards. A funded-but-no-release
 * state shows the calm "In Zahlung abgesichert" badge with the 25/75 split so
 * the customer understands the mechanic before any action is required.
 */
export default function CustomerReleaseProgressCard({ jobId }: Props) {
  // Local tick bumped on every timeline-store change so the projection
  // re-reads payout-outcome signals (payout_completed / payout_failed) and
  // newly released tranches without relying on parent subscriptions.
  const [, setTimelineTick] = useState(0)
  useEffect(() => {
    const unsub = subscribeTimeline(() => setTimelineTick((t) => t + 1))
    return () => unsub()
  }, [])

  // Block 7.2.1a — re-derive the 4-state view model whenever the job
  // store changes (e.g. owner confirms → workConfirmedCompleteAt set).
  const [, setJobsTick] = useState(0)
  useEffect(() => {
    const unsub = subscribeJobs(() => setJobsTick((t) => t + 1))
    return () => unsub()
  }, [])

  const mfp = resolveMoneyFlowProjection(jobId)

  // ── Gate: need an escrow plan that is at least funded ──────────────────
  // Before funding confirmation the funding/payment cards carry the truth;
  // this card stays out of the way. From funded_in_escrow onwards it is
  // always visible so the customer sees the 25/75 structure early, ruhig,
  // and understands the mechanic before any action is required.
  if (!mfp || !mfp.hasEscrowPlan) return null
  if (
    mfp.fundingStatus !== 'funded_in_escrow' &&
    mfp.releasedAmount === 0 &&
    !mfp.isDisputed &&
    !mfp.isTerminal
  ) return null

  const badge = derivePlanBadge(mfp)
  // Order-scope total — consistent with CustomerPaymentSummaryCard
  const canonicalTotal = resolveCanonicalAmount(jobId)

  // Block 7.2.1a — 4-state view model
  const job = getJobById(jobId)
  const acceptance = getAcceptanceByJobId(jobId)
  const progressVM: CustomerReleaseProgressViewModel | null = job
    ? deriveCustomerReleaseProgressViewModel(job, acceptance)
    : null

  return (
    <div className="rounded-[24px] bg-white p-4 ring-1 ring-slate-200/70 shadow-[0_8px_20px_-18px_rgba(2,6,23,0.10)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[14px] font-semibold text-slate-800">Zahlungsfreigabe</h3>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${badge.accent}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Block 7.2.1a — admin-confirm-gate banner */}
      {progressVM?.state === 'awaiting_admin_confirm' && (
        <div
          data-testid="release-progress-awaiting-admin"
          className="mb-3 rounded-[14px] bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200/60"
        >
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-800 mb-1">
            <Icon icon={Wrench} size="sm" className="shrink-0" />
            Wird intern abgeschlossen
          </p>
          <p className="text-[11px] leading-snug text-amber-900/80">
            Der Betrieb prüft gerade die Fertigmeldung. Sobald sie bestätigt
            ist, hast du 72 Stunden, um die Zahlung freizugeben oder Mängel
            zu melden.
          </p>
        </div>
      )}

      {/* Block 7.2.1a — Acceptance window with countdown */}
      {progressVM?.state === 'acceptance_pending' && progressVM.acceptanceExpiresAt && (
        <div
          data-testid="release-progress-acceptance-pending"
          className="mb-3 rounded-[14px] bg-emerald-50 px-3 py-2.5 ring-1 ring-emerald-200/60"
        >
          <p className="flex items-center gap-1.5 text-[12px] font-semibold text-emerald-800 mb-1">
            <Icon icon={CheckCircle} size="sm" className="shrink-0" />
            Bereit zur Freigabe
          </p>
          <p className="text-[11px] leading-snug text-emerald-900/80 mb-1">
            Der Betrieb hat den Auftrag als abgeschlossen bestätigt. Bitte
            prüfen und freigeben — oder melde einen Mangel.
          </p>
          <p
            data-testid="release-progress-countdown"
            className="text-[11px] font-medium text-emerald-700"
          >
            Frist: {formatRemaining(progressVM.acceptanceExpiresAt)}
          </p>
        </div>
      )}

      {/* Summary line — canonical total (order-scope) */}
      <div className="flex items-center justify-between mb-3 text-[12px]">
        <span className="text-slate-500">Gesamtbetrag</span>
        <span className="font-semibold text-slate-700">
          {canonicalTotal.formatted || mfp.totalAmountFormatted}
        </span>
      </div>
      {mfp.releasedAmount > 0 && (
        <div className="flex items-center justify-between mb-3 text-[12px]">
          <span className="text-slate-500">Davon freigegeben</span>
          <span className="font-semibold text-emerald-700">
            {mfp.releasedAmountFormatted}
          </span>
        </div>
      )}

      {/* Per-tranche breakdown — from MoneyFlowProjection */}
      <div className="space-y-2">
        {mfp.tranches.map((tranche: TrancheProjection) => {
          // Stale funded tranches that are effectively eligible must show
          // "Freigabe möglich", not "In Zahlung" — same truth as provider CTA/Hero.
          const display = tranche.isEligible && tranche.status !== 'eligible_for_release' && tranche.status !== 'released'
            ? { label: 'Freigabe möglich', icon: CheckCircle, color: 'text-emerald-600' }
            : getTrancheStatusIcon(tranche.status)

          return (
            <div
              key={tranche.id}
              className="rounded-[14px] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/50"
            >
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-slate-600 font-medium">
                  {tranche.label}
                </span>
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${display.color}`}>
                  <Icon icon={display.icon} size="sm" /> {display.label}
                </span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[12px] text-slate-500">
                  {tranche.amountFormatted}
                </span>
                {tranche.releasedAtFormatted && (
                  <span className="text-[11px] text-slate-400">
                    {tranche.releasedAtFormatted}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Pre-release calm explanation — funded, no tranche released yet */}
      {mfp.fundingStatus === 'funded_in_escrow' &&
        mfp.releasedAmount === 0 &&
        !mfp.isDisputed &&
        !mfp.isTerminal && (
          <p className="mt-3 text-[11px] leading-snug text-slate-500">
            Deine Zahlung ist über Stripe abgesichert. 25&nbsp;% werden automatisch
            bei Arbeitsbeginn freigegeben, 75&nbsp;% nach deiner Freigabe am Ende.
          </p>
        )}

      {/* Explanation for partially released state */}
      {mfp.releasedPercent > 0 && mfp.releasedPercent < 100 && !mfp.isTerminal && (
        <p className="mt-3 text-[11px] leading-snug text-slate-400">
          Ein Teil der Zahlung wurde an den Handwerker freigegeben. Die Restzahlung wird nach Fertigstellung der Arbeiten freigegeben.
        </p>
      )}

      {/* Confirmation for fully released */}
      {mfp.isTerminal && mfp.releasedPercent === 100 && (
        <p className="mt-3 text-[11px] leading-snug text-emerald-600">
          Die gesamte Zahlung wurde aus der abgesicherten Zahlung freigegeben. Der Auftrag ist abgeschlossen.
        </p>
      )}
    </div>
  )
}
