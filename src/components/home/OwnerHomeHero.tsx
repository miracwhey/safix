import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Scale,
  Inbox,
  Clock,
  CreditCard,
  CheckCircle2,
  ChevronRight,
} from 'lucide-react'
import type { OwnerHomeState, HomeFollowUp } from '../../lib/viewmodel/homeState'

// ── Shared primitives ─────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="rounded-[24px] bg-slate-50 p-5 ring-1 ring-slate-200 animate-pulse">
      <div className="flex items-start gap-3.5">
        <div className="h-11 w-11 shrink-0 rounded-2xl bg-slate-200" />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <div className="h-2.5 w-20 rounded bg-slate-200" />
          <div className="h-4 w-44 rounded bg-slate-200" />
          <div className="h-3 w-32 rounded bg-slate-200" />
        </div>
      </div>
    </div>
  )
}

function FollowUpList({ items, onNavigate }: { items: HomeFollowUp[]; onNavigate: (route: string) => void }) {
  if (items.length === 0) return null
  return (
    <div className="mt-2 flex flex-col gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onNavigate(item.route)}
          className="flex w-full items-center gap-3 rounded-[18px] bg-white px-4 py-3 ring-1 ring-edge text-left transition active:scale-[0.99]"
        >
          <div className={`h-8 w-8 shrink-0 rounded-[10px] flex items-center justify-center ${
            item.severity === 'urgent' ? 'bg-rose-50 text-rose-600' :
            item.severity === 'action' ? 'bg-brand-50 text-brand' :
            'bg-slate-50 text-ink-muted'
          }`}>
            {item.severity === 'urgent' ? <Scale size={15} /> :
             item.severity === 'action' ? <Inbox size={15} /> :
             <Clock size={15} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-ink truncate">{item.title}</div>
            <div className="text-[11px] text-ink-muted mt-0.5 truncate">{item.meta}</div>
          </div>
          <ChevronRight size={15} className="shrink-0 text-ink-muted" />
        </button>
      ))}
    </div>
  )
}

// ── Hero card variants ────────────────────────────────────────────────────────

function GradientHero({
  eyebrow,
  title,
  meta,
  ctaLabel,
  ctaRoute,
  dot,
  onNavigate,
  bg,
  shadow,
}: {
  eyebrow: string
  title: string
  meta: string
  ctaLabel: string
  ctaRoute: string
  dot: string
  onNavigate: (route: string) => void
  bg: string
  shadow: string
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(ctaRoute)}
      className="block w-full rounded-[24px] overflow-hidden relative p-[22px] text-left transition active:scale-[0.99]"
      style={{ background: bg, boxShadow: shadow }}
    >
      {/* Decorative rings */}
      <svg className="absolute -top-5 -right-5 opacity-15 pointer-events-none" width="180" height="180" viewBox="0 0 180 180">
        {[0,1,2,3,4,5].map(i => (
          <circle key={i} cx="90" cy="90" r={20 + i*14} stroke="#fff" strokeWidth="1" fill="none"/>
        ))}
      </svg>

      <div className="relative z-10">
        {/* Pill */}
        <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-sm">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: dot }} />
          <span className="text-[11px] font-bold text-white/90">{eyebrow}</span>
        </div>

        {/* Content */}
        <div className="mt-5">
          <div className="text-[22px] font-bold leading-snug text-white tracking-[-0.02em] whitespace-pre-line">
            {title}
          </div>
          <div className="mt-2 text-[12px] text-white/75 leading-relaxed">{meta}</div>
        </div>

        {/* CTA */}
        <div className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-white px-4 py-3">
          <span className="text-[14px] font-bold text-brand">{ctaLabel}</span>
          <ArrowRight size={14} className="text-brand" />
        </div>
      </div>
    </button>
  )
}

function WhiteHero({
  eyebrow,
  title,
  meta,
  ctaLabel,
  ctaRoute,
  onNavigate,
  pillColor,
  dotColor,
}: {
  eyebrow: string
  title: string
  meta: string
  ctaLabel: string
  ctaRoute: string
  onNavigate: (route: string) => void
  pillColor: string
  dotColor: string
}) {
  return (
    <button
      type="button"
      onClick={() => onNavigate(ctaRoute)}
      className="block w-full rounded-[24px] bg-white p-[22px] ring-1 ring-edge text-left transition active:scale-[0.99]"
      style={{ boxShadow: '0 8px 18px -10px rgba(15,23,42,0.12), 0 2px 4px rgba(15,23,42,0.04)' }}
    >
      {/* Pill */}
      <div className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold" style={{ background: `${pillColor}1a`, color: pillColor }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: dotColor }} />
        {eyebrow}
      </div>

      <div className="mt-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-muted">Als Nächstes</div>
        <div className="mt-1.5 text-[21px] font-bold text-ink leading-snug tracking-[-0.02em] whitespace-pre-line">{title}</div>
        <div className="mt-1.5 text-[12px] text-ink-sub">{meta}</div>
      </div>

      <div className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-[14px] py-3 font-bold text-[14px]" style={{ background: pillColor, color: '#fff' }}>
        {ctaLabel} <ArrowRight size={14} />
      </div>
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

type Props = { vm: OwnerHomeState }

export default function OwnerHomeHero({ vm }: Props) {
  const navigate = useNavigate()
  const nav = (route: string) => navigate(route)

  if (vm.kind === 'loading') return <Skeleton />

  const { primaryAction, followUps } = vm

  if (vm.kind === 'calm') {
    return (
      <div>
        <GradientHero
          eyebrow="Heute · alles im Plan"
          title={primaryAction?.label ?? 'Tagesplan ansehen'}
          meta="Kein Handlungsbedarf — schau in die Zahlen oder plan die nächste Woche"
          ctaLabel={primaryAction?.label ?? 'Tagesplan ansehen'}
          ctaRoute={primaryAction?.route ?? '/craftsman/dashboard'}
          dot="#86EFAC"
          onNavigate={nav}
          bg="linear-gradient(135deg, #0F766E 0%, #134E4A 100%)"
          shadow="0 18px 42px -16px rgba(15,118,110,0.5), 0 4px 12px -4px rgba(15,118,110,0.2)"
        />
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  if (vm.kind === 'dispute') {
    return (
      <div>
        <GradientHero
          eyebrow="Heute · 1 dringend"
          title={primaryAction?.label ?? 'Streit beantworten'}
          meta={`Antwort erwartet · ${followUps.length > 0 ? `${followUps.length + 1} Punkte offen` : 'Streitfall aktiv'}`}
          ctaLabel={primaryAction?.label ?? 'Streit öffnen'}
          ctaRoute={primaryAction?.route ?? '/craftsman/disputes'}
          dot="#FCA5A5"
          onNavigate={nav}
          bg="linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)"
          shadow="0 18px 42px -16px rgba(37,99,235,0.55), 0 4px 12px -4px rgba(37,99,235,0.25)"
        />
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  // Payment-priority dispatch must run BEFORE the generic `busy` branch:
  // deriveOwnerHomeState produces kind='busy' for payout_blocked, payout_failed,
  // release_overdue, and funding_awaited as well as for the generic busy state.
  // Routing on priorityReason first preserves the contract priority order
  // (dispute > payout_blocked > payout_failed > release_overdue > funding_awaited
  // > requests_pending) that homeState already encodes.
  // onboarding_incomplete suppresses payment alerts — onboarding wins.
  const urgentPayment = vm.kind === 'onboarding_incomplete'
    ? null
    : vm.priorityReason

  if (urgentPayment === 'payout_blocked') {
    return (
      <div>
        <WhiteHero
          eyebrow="Auszahlung gesperrt"
          title={primaryAction?.label ?? 'Konto einrichten'}
          meta="Dein Stripe-Konto hat offene Anforderungen. Prüfe die Details, um Auszahlungen wieder freizuschalten."
          ctaLabel={primaryAction?.label ?? 'Konto einrichten'}
          ctaRoute={primaryAction?.route ?? '/craftsman/profile'}
          onNavigate={nav}
          pillColor="#D97706"
          dotColor="#F59E0B"
        />
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  if (urgentPayment === 'payout_failed') {
    return (
      <div>
        <WhiteHero
          eyebrow="Auszahlung fehlgeschlagen"
          title="Bankdaten prüfen"
          meta="Prüfe deine Bankdaten, damit SaFix die Auszahlung erneut verarbeiten kann."
          ctaLabel={primaryAction?.label ?? 'Bankdaten prüfen'}
          ctaRoute={primaryAction?.route ?? '/craftsman/profile/tax-bank'}
          onNavigate={nav}
          pillColor="#DC2626"
          dotColor="#F87171"
        />
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  if (urgentPayment === 'release_overdue' || urgentPayment === 'funding_awaited') {
    return (
      <div>
        <WhiteHero
          eyebrow={urgentPayment === 'release_overdue' ? 'Freigabe ausstehend' : 'Einzahlung erwartet'}
          title={primaryAction?.label ?? 'Zahlung prüfen'}
          meta={urgentPayment === 'release_overdue' ? 'Kunde muss Arbeit bestätigen & Betrag freigeben' : 'Kunde hat Einzahlung noch nicht geleistet'}
          ctaLabel={primaryAction?.label ?? 'Projekt öffnen'}
          ctaRoute={primaryAction?.route ?? '/craftsman/dashboard'}
          onNavigate={nav}
          pillColor="#2563EB"
          dotColor="#60A5FA"
        />
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  // Generic busy hero — runs only when no payment-priority reason fired above.
  // Covers `requests_pending` and the generic active-jobs busy state.
  if (vm.kind === 'busy') {
    return (
      <div>
        <GradientHero
          eyebrow={`${vm.priorityReason === 'requests_pending' ? 'Neue Anfragen' : 'Pipeline füllt sich'}`}
          title={primaryAction?.label ?? 'Anfragen prüfen'}
          meta="Offene Kundenanfragen warten auf Angebote"
          ctaLabel={primaryAction?.label ?? 'Anfragen prüfen'}
          ctaRoute={primaryAction?.route ?? '/craftsman/messages'}
          dot="#FCD34D"
          onNavigate={nav}
          bg="linear-gradient(135deg, #2563EB 0%, #1E1B4B 100%)"
          shadow="0 18px 42px -16px rgba(37,99,235,0.5), 0 4px 12px -4px rgba(37,99,235,0.2)"
        />
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  // onboarding_incomplete
  // Defensive: if the selector did not produce a concrete primaryAction (the
  // state shape allows null), render a non-clickable status card pointing at
  // the profile hub instead of faking a CTA into a generic onboarding route.
  if (!primaryAction) {
    return (
      <div>
        <div
          className="flex w-full items-center gap-4 rounded-[24px] bg-white p-5 ring-1 ring-edge"
          style={{ boxShadow: '0 8px 18px -10px rgba(15,23,42,0.12)' }}
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-50">
            <CheckCircle2 size={22} className="text-brand" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-muted">Einrichtung</div>
            <div className="mt-0.5 text-[16px] font-bold text-ink">Setup wird geprüft</div>
            <button
              type="button"
              onClick={() => nav('/craftsman/profile')}
              className="mt-1 text-[12px] text-brand underline-offset-2 hover:underline"
            >
              Profil öffnen
            </button>
          </div>
        </div>
        <FollowUpList items={followUps} onNavigate={nav} />
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => nav(primaryAction.route)}
        className="flex w-full items-center gap-4 rounded-[24px] bg-white p-5 ring-1 ring-edge text-left transition active:scale-[0.99]"
        style={{ boxShadow: '0 8px 18px -10px rgba(15,23,42,0.12)' }}
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-brand-50">
          <CheckCircle2 size={22} className="text-brand" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-ink-muted">Einrichtung</div>
          <div className="mt-0.5 text-[16px] font-bold text-ink">{primaryAction.label}</div>
          <div className="mt-0.5 text-[12px] text-ink-sub">Damit Kunden dich finden können</div>
        </div>
        <CreditCard size={18} className="shrink-0 text-brand" />
      </button>
      <FollowUpList items={followUps} onNavigate={nav} />
    </div>
  )
}
