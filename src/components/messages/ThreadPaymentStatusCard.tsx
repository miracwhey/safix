/**
 * ThreadPaymentStatusCard — compact payment/payout status strip rendered
 * inside a message thread once an offer has been accepted and a job exists.
 *
 * Reads the canonical MoneyFlowProjection for the linked job, mirrors the
 * same four strictly separated payout phases the Finance surface uses
 * ("Zur Auszahlung übergeben" / "Auszahlung läuft" / "Auf deinem Konto" /
 * "Auszahlung fehlgeschlagen"), and links to the finance section for the
 * full corridor view.
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { resolveMoneyFlowProjection } from '../../lib/payments/moneyFlowProjection'
import { subscribeTimeline } from '../../lib/timeline'
import { getProjectByJobId } from '../../lib/projects'
import type { MessageRole } from '../../lib/messages'

type Props = {
  jobId: string
  role: MessageRole
}

function formatRelative(ms: number | null | undefined): string | null {
  if (!ms) return null
  const diff = Date.now() - ms
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return 'gerade eben'
  if (minutes < 60) return `vor ${minutes} Min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `vor ${hours} Std`
  const days = Math.round(hours / 24)
  return `vor ${days} Tag${days === 1 ? '' : 'en'}`
}

function deriveLastEventLabel(
  proj: ReturnType<typeof resolveMoneyFlowProjection>,
): { label: string; at: number } | null {
  if (!proj) return null
  const candidates: { label: string; at: number }[] = []
  for (const t of proj.tranches) {
    if (t.isReleased && t.releasedAt) {
      candidates.push({
        label: `${t.percentage}% freigegeben`,
        at: t.releasedAt,
      })
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.at - a.at)
  return candidates[0]
}

function getStatusAccent(status: string): { bg: string; text: string } {
  if (status === 'payout_completed') return { bg: 'bg-emerald-50', text: 'text-emerald-700' }
  if (status === 'payout_failed') return { bg: 'bg-rose-50', text: 'text-rose-700' }
  if (status === 'payout_in_transit') return { bg: 'bg-blue-50', text: 'text-blue-700' }
  if (status === 'transfer_triggered') return { bg: 'bg-amber-50', text: 'text-amber-700' }
  return { bg: 'bg-slate-50', text: 'text-slate-600' }
}

export default function ThreadPaymentStatusCard({ jobId, role }: Props) {
  // Local tick bumped on every timeline-store change so
  // `resolveMoneyFlowProjection` re-reads the payout-outcome signals
  // emitted by the Stripe webhook (payout_completed / payout_failed).
  const [, setTimelineTick] = useState(0)
  useEffect(() => {
    const unsub = subscribeTimeline(() => setTimelineTick((t) => t + 1))
    return () => unsub()
  }, [])

  const proj = resolveMoneyFlowProjection(jobId, null)
  if (!proj) return null
  // Only render once money actually moved on the provider side — before
  // release the regular funding / offer cards already carry the truth.
  if (!proj.hasEscrowPlan) return null
  if (proj.fundingStatus !== 'funded_in_escrow' && proj.releasedAmount === 0 && !proj.isDisputed) {
    return null
  }

  const accent = getStatusAccent(proj.payoutStatus)
  const lastEvent = deriveLastEventLabel(proj)
  // Customer detail route is keyed by projectId (not jobId). Resolve the
  // project that owns this job so the link lands on CustomerProjectDetail;
  // fall back to the messages inbox when the project isn't resolvable yet.
  const customerProject = role === 'customer' ? getProjectByJobId(jobId) : null
  const financeHref = role === 'craftsman'
    ? `/craftsman/finance?job=${jobId}`
    : customerProject
      ? `/projects/${customerProject.id}?focus=payment`
      : '/projects'

  return (
    <Link
      to={financeHref}
      className="mt-2 block rounded-card bg-canvas p-3 ring-1 ring-edge transition hover:ring-ink-muted/30"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Zahlung
          </div>
          <div className="mt-0.5 truncate text-[13px] font-semibold text-ink">
            {proj.payoutStatusLabel}
          </div>
          {lastEvent && (
            <div className="mt-0.5 text-[12px] text-ink-muted">
              {lastEvent.label}
              {formatRelative(lastEvent.at) ? ` · ${formatRelative(lastEvent.at)}` : ''}
            </div>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${accent.bg} ${accent.text}`}
        >
          {proj.releasedPercent}%
        </span>
      </div>
    </Link>
  )
}
