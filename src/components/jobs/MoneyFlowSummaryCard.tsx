/**
 * MoneyFlowSummaryCard — Kompakte Geldfluss-Übersicht pro Job
 *
 * Zeigt auf einen Blick:
 *   - Hat der Kunde gezahlt?
 *   - Wo ist das Geld gerade?
 *   - Was ist freigegeben / freigabefähig / gesperrt?
 *   - Warum ist etwas gesperrt?
 *   - Was ist der nächste Schritt?
 *
 * Konsumiert ausschließlich MoneyFlowProjection — keine eigene Ableitung.
 */

import CraftsmanSectionCard from '../CraftsmanSectionCard'
import type { MoneyFlowProjection, TrancheProjection } from '../../lib/payments/moneyFlowProjection'

type Props = {
  projection: MoneyFlowProjection
}

// ── Funding status display ──────────────────────────────────────────────────

const FUNDING_STATUS_DISPLAY: Record<
  MoneyFlowProjection['fundingStatus'],
  { icon: string; color: string; bg: string }
> = {
  no_escrow_plan: { icon: '📋', color: 'text-slate-600', bg: 'bg-slate-50 ring-slate-200/60' },
  customer_not_paid: { icon: '⏳', color: 'text-amber-700', bg: 'bg-amber-50 ring-amber-200/60' },
  payment_processing: { icon: '⏳', color: 'text-blue-700', bg: 'bg-blue-50 ring-blue-200/60' },
  funded_in_escrow: { icon: '🔒', color: 'text-emerald-700', bg: 'bg-emerald-50 ring-emerald-200/60' },
  funding_failed: { icon: '⚠️', color: 'text-red-700', bg: 'bg-red-50 ring-red-200/60' },
  // Terminal-dead request: neutral slate (not the actionable amber of
  // customer_not_paid) so a dead request is visually distinct from a payment
  // that is genuinely still pending. ⌛ = the request's window has run out.
  funding_expired: { icon: '⌛', color: 'text-slate-600', bg: 'bg-slate-100 ring-slate-300/60' },
}

// ── Tranche status display ──────────────────────────────────────────────────

function getTrancheIcon(t: TrancheProjection): string {
  if (t.isReleased) return '💶'
  if (t.isBlocked) return '⚠️'
  if (t.isEligible) return '✅'
  return '🔒'
}

function getTrancheColor(t: TrancheProjection): string {
  if (t.isReleased) return 'text-emerald-700'
  if (t.isBlocked) return 'text-amber-700'
  if (t.isEligible) return 'text-emerald-600'
  return 'text-slate-500'
}

export default function MoneyFlowSummaryCard({ projection }: Props) {
  const p = projection
  const fundingDisplay = FUNDING_STATUS_DISPLAY[p.fundingStatus]

  return (
    <CraftsmanSectionCard
      title={p.summaryLine}
    >
      <div className="space-y-4">
        {/* ── Funding-Status-Banner ── */}
        <div className={`flex items-center gap-2 rounded-2xl px-4 py-3 ring-1 ${fundingDisplay.bg}`}>
          <span className="text-[18px]">{fundingDisplay.icon}</span>
          <div>
            <div className={`text-[13px] font-semibold ${fundingDisplay.color}`}>
              {p.fundingStatusLabel}
            </div>
            {p.fundingStatus === 'funded_in_escrow' && (
              <div className="text-[12px] text-emerald-600">
                {p.totalAmountFormatted} über Stripe abgesichert
              </div>
            )}
          </div>
        </div>

        {/* ── Betragsübersicht ── */}
        <div className="divide-y divide-slate-100">
          <div className="flex items-center justify-between py-2">
            <span className="text-[13px] text-slate-500">Gesamtbetrag</span>
            <span className="text-[14px] font-semibold text-slate-900">
              {p.totalAmountFormatted}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-[13px] text-slate-500">Plattformgebühr ({Math.round(p.platformFeeRate * 100)} %)</span>
            <span className="text-[13px] text-slate-500">
              − {p.platformFeeFormatted}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-[13px] text-slate-600 font-medium">Dein Nettobetrag</span>
            <span className="text-[14px] font-semibold text-slate-900">
              {p.providerNetFormatted}
            </span>
          </div>
        </div>

        {/* ── Tranchen-Detail ── */}
        {p.tranches.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Freigabe-Status
            </div>
            {p.tranches.map((t) => (
              <div
                key={t.id}
                className="rounded-[14px] bg-slate-50 px-3 py-2.5 ring-1 ring-slate-200/50"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-slate-600 font-medium">
                    {t.label}
                  </span>
                  <span className={`text-[11px] font-semibold ${getTrancheColor(t)}`}>
                    {getTrancheIcon(t)} {t.statusLabel}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[12px] text-slate-500">
                    {t.amountFormatted}
                  </span>
                  {t.releasedAtFormatted && (
                    <span className="text-[11px] text-slate-400">
                      {t.releasedAtFormatted}
                    </span>
                  )}
                </div>
                {t.blockingReason && !t.isReleased && (
                  <p className="mt-1.5 text-[11px] leading-snug text-amber-700">
                    {t.blockingReason}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Release-Zusammenfassung ── */}
        {p.fundingStatus === 'funded_in_escrow' && p.tranches.length > 0 && (
          <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2">
            <div className="flex items-center justify-between py-2">
              <span className="text-[13px] text-emerald-700">Bereits freigegeben</span>
              <span className="text-[13px] font-semibold text-emerald-700">
                {p.releasedAmountFormatted} ({p.releasedPercent} %)
              </span>
            </div>
            {p.releasableAmount > 0 && (
              <div className="flex items-center justify-between py-2">
                <span className="text-[13px] text-blue-700">Jetzt freigabefähig</span>
                <span className="text-[13px] font-semibold text-blue-700">
                  {p.releasableAmountFormatted}
                </span>
              </div>
            )}
            {p.unreleasedAmount > 0 && p.releasedPercent < 100 && (
              <div className="flex items-center justify-between py-2">
                <span className="text-[13px] text-slate-500">Noch im Escrow</span>
                <span className="text-[13px] text-slate-500">
                  {p.unreleasedAmountFormatted}
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── Dispute-Banner ── */}
        {p.isDisputed && (
          <div className="flex items-center gap-2 rounded-2xl bg-amber-50 px-4 py-3 ring-1 ring-amber-200/60">
            <span className="text-[18px]">⚖️</span>
            <div>
              <div className="text-[13px] font-semibold text-amber-800">
                Streitfall aktiv
              </div>
              <div className="text-[12px] text-amber-600">
                Gelder sind eingefroren bis zur Klärung.
              </div>
            </div>
          </div>
        )}

        {/* ── Blocking-Reason ── */}
        {p.blockingReason !== 'none' && !p.isDisputed && (
          <div className="flex items-center gap-2 rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200/60">
            <span className="text-[16px]">ℹ️</span>
            <div className="text-[12px] text-slate-600">
              {p.blockingReasonLabel}
            </div>
          </div>
        )}

        {/* ── Payout-Status ── */}
        {p.payoutStatus !== 'no_transfer_yet' && (
          <div className="flex items-center justify-between py-2 border-t border-slate-100">
            <span className="text-[12px] text-slate-500">Auszahlung</span>
            <span className={`text-[12px] font-medium ${
              p.payoutStatus === 'transfer_triggered' ? 'text-emerald-700' :
              p.payoutStatus === 'transfer_reversed' ? 'text-amber-700' :
              p.payoutStatus === 'payout_blocked' ? 'text-red-600' :
              'text-slate-500'
            }`}>
              {p.payoutStatusLabel}
            </span>
          </div>
        )}

        {/* ── Nächster Schritt ── */}
        {p.primaryAction !== 'no_action' && !p.isTerminal && (
          <div className="rounded-[14px] bg-blue-50 px-3 py-2.5 ring-1 ring-blue-200/50">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-400 mb-1">
              Nächster Schritt
            </div>
            <div className="text-[13px] font-medium text-blue-800">
              {p.primaryActionLabel}
            </div>
          </div>
        )}

        {/* ── Terminal-Banner ── */}
        {p.isTerminal && !p.isDisputed && (
          <div className={`flex items-center gap-2 rounded-2xl px-4 py-3 ring-1 ${
            p.requiresReconciliation
              ? 'bg-amber-50 ring-amber-200/60'
              : p.payoutStatus === 'transfer_triggered' || p.payoutStatus === 'payout_in_transit'
              ? 'bg-blue-50 ring-blue-200/60'
              : 'bg-emerald-50 ring-emerald-200/60'
          }`}>
            <span className="text-[18px]">
              {p.requiresReconciliation
                ? '⚠️'
                : p.payoutStatus === 'transfer_triggered' || p.payoutStatus === 'payout_in_transit'
                ? '⏳'
                : '✅'}
            </span>
            <div className={`text-[13px] font-semibold ${
              p.requiresReconciliation
                ? 'text-amber-800'
                : p.payoutStatus === 'transfer_triggered' || p.payoutStatus === 'payout_in_transit'
                ? 'text-blue-800'
                : 'text-emerald-800'
            }`}>
              {p.summaryLine}
            </div>
          </div>
        )}
      </div>
    </CraftsmanSectionCard>
  )
}
