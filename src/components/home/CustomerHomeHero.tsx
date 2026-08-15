import { useNavigate } from 'react-router-dom'
import { ArrowRight, Search, Clock } from 'lucide-react'
import type { CustomerHomeState } from '../../lib/viewmodel/homeState'

type Props = {
  vm: CustomerHomeState
  /**
   * Block 7.2.1a (P7) — gate Zahlung wording on whether the customer
   * actually has an open down-payment-style request (FundingRequest in
   * sent/funding_started/funding_initiated, or SupplementaryPaymentRequest
   * in pending/acknowledged/funding_initiated).
   *
   * Defaults to `true` so existing call-sites that have not yet wired up
   * `deriveDownPaymentRequestPending` keep the legacy wording. New
   * call-sites should pass the derived boolean.
   */
  downPaymentRequestPending?: boolean
}

export default function CustomerHomeHero({ vm, downPaymentRequestPending = true }: Props) {
  const navigate = useNavigate()

  if (vm.kind === 'loading') {
    return (
      <div className="rounded-[24px] bg-slate-50 p-5 ring-1 ring-slate-200 animate-pulse">
        <div className="h-2.5 w-20 rounded bg-slate-200" />
        <div className="mt-4 h-16 rounded-[18px] bg-slate-200" />
        <div className="mt-3 h-10 rounded-[14px] bg-slate-200" />
      </div>
    )
  }

  const { primaryAction } = vm

  // ── Discovery ──────────────────────────────────────────────────────────────
  if (vm.kind === 'discovery') {
    return (
      <button
        type="button"
        onClick={() => navigate(primaryAction?.route ?? '/explore')}
        className="block w-full rounded-[24px] overflow-hidden relative p-6 text-left transition active:scale-[0.99]"
        style={{
          background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
          boxShadow: '0 18px 42px -16px rgba(37,99,235,0.55), 0 4px 12px -4px rgba(37,99,235,0.25)',
        }}
      >
        <svg className="absolute -top-5 -right-5 opacity-15 pointer-events-none" width="180" height="180" viewBox="0 0 180 180">
          {[0,1,2,3,4,5].map(i => (
            <circle key={i} cx="90" cy="90" r={20 + i*14} stroke="#fff" strokeWidth="1" fill="none"/>
          ))}
        </svg>
        <div className="relative z-10">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">Wo fangen wir an?</div>
          <div className="mt-2 text-[24px] font-bold leading-tight text-white tracking-[-0.025em]">
            Was muss bei dir<br />gemacht werden?
          </div>
          <div className="mt-2 text-[13px] text-white/80 leading-relaxed">
            Beschreib's kurz — wir finden dir passende Handwerker.
          </div>
          <div className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-white px-4 py-3">
            <Search size={14} className="text-brand" />
            <span className="text-[14px] font-bold text-brand">Auftrag beschreiben</span>
            <ArrowRight size={14} className="text-brand" />
          </div>
        </div>
      </button>
    )
  }

  // ── Waiting ────────────────────────────────────────────────────────────────
  if (vm.kind === 'waiting') {
    // Block 7.2.1a (P7): only show the Zahlung wording when the customer
    // actually has an open down-payment request. A `funding_required`
    // priority reason without a corresponding open request is a stale
    // signal — fall back to the neutral "wartet" status instead of telling
    // the customer to pay something they were never asked to pay.
    const isUrgent =
      vm.priorityReason === 'funding_required' && downPaymentRequestPending

    const innerContent = (
      <>
        <div className="flex items-center justify-between">
          <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${isUrgent ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-ink-sub'}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${isUrgent ? 'bg-amber-500' : 'bg-slate-400'}`} />
            {isUrgent ? 'Einzahlung erwartet' : 'Warte auf Angebote'}
          </div>
          <Clock size={14} className="text-ink-muted" />
        </div>
        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-muted">
            {vm.priorityReason ? 'Deine Aktion' : 'Deine Anfrage'}
          </div>
          <div className="mt-1.5 text-[21px] font-bold text-ink leading-snug tracking-[-0.02em]">
            {primaryAction?.label ?? 'Anfrage läuft'}
          </div>
          <div className="mt-1.5 text-[12px] text-ink-sub">
            {isUrgent
              ? 'Einzahlung ins Stripe-Absicherung erforderlich'
              : 'Handwerker schauen sich deine Anfrage an'}
          </div>
        </div>
        {primaryAction && (
          <div className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-[14px] py-3 font-bold text-[14px] ${isUrgent ? 'bg-amber-500 text-white' : 'bg-brand text-white'}`}>
            {primaryAction.label} <ArrowRight size={14} />
          </div>
        )}
      </>
    )

    const cardClass =
      'block w-full rounded-[24px] bg-white p-[22px] ring-1 ring-edge text-left'
    const cardStyle = {
      boxShadow:
        '0 8px 18px -10px rgba(15,23,42,0.12), 0 2px 4px rgba(15,23,42,0.04)',
    }

    // Defensive: only render an interactive button when there is a concrete
    // route to navigate to. Without primaryAction, fall back to a static
    // status card — no fake CTA, no navigate('/') round-trip on tap.
    if (!primaryAction) {
      return (
        <div className={cardClass} style={cardStyle}>
          {innerContent}
        </div>
      )
    }

    return (
      <button
        type="button"
        onClick={() => navigate(primaryAction.route)}
        className={`${cardClass} transition active:scale-[0.99]`}
        style={cardStyle}
      >
        {innerContent}
      </button>
    )
  }

  // ── Active ─────────────────────────────────────────────────────────────────
  const isDispute = vm.priorityReason === 'dispute_open'
  const isRelease = vm.priorityReason === 'release_required'

  return (
    <button
      type="button"
      onClick={() => navigate(primaryAction?.route ?? '/')}
      className="block w-full rounded-[24px] overflow-hidden relative p-[22px] text-left transition active:scale-[0.99]"
      style={{
        background: isDispute
          ? 'linear-gradient(135deg, #1D4ED8 0%, #1E1B4B 100%)'
          : 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
        boxShadow: '0 18px 42px -16px rgba(37,99,235,0.55), 0 4px 12px -4px rgba(37,99,235,0.25)',
      }}
    >
      <svg className="absolute -top-5 -right-5 opacity-15 pointer-events-none" width="180" height="180" viewBox="0 0 180 180">
        {[0,1,2,3,4,5].map(i => (
          <circle key={i} cx="90" cy="90" r={20 + i*14} stroke="#fff" strokeWidth="1" fill="none"/>
        ))}
      </svg>

      <div className="relative z-10">
        {/* Status pill */}
        <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-sm">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${isDispute ? 'bg-rose-300' : isRelease ? 'bg-amber-300' : 'bg-green-300'}`} />
          <span className="text-[11px] font-bold text-white/90">
            {isDispute ? 'Streitfall offen' : isRelease ? 'Freigabe ausstehend' : 'Projekt läuft'}
          </span>
        </div>

        {/* Title */}
        <div className="mt-5">
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-white/70">
            {isDispute ? 'Als Erstes' : 'Mein Projekt'}
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-white leading-snug tracking-[-0.025em]">
            {primaryAction?.label ?? 'Projekt öffnen'}
          </div>
        </div>

        {/* CTA */}
        <div className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-white px-4 py-3">
          <span className="text-[14px] font-bold text-brand">{primaryAction?.label ?? 'Öffnen'}</span>
          <ArrowRight size={14} className="text-brand" />
        </div>
      </div>
    </button>
  )
}
