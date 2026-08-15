import { useNavigate } from 'react-router-dom'
import { ArrowRight, MapPin } from 'lucide-react'
import type { EmployeeHomeState } from '../../lib/viewmodel/homeState'

type Props = { vm: EmployeeHomeState }

export default function WorkerHomeHero({ vm }: Props) {
  const navigate = useNavigate()

  if (vm.kind === 'loading') {
    return (
      <div className="rounded-[28px] bg-white p-5 ring-1 ring-slate-200/70 animate-pulse"
        style={{ boxShadow: '0 18px 40px -28px rgba(2,6,23,0.28)' }}
      >
        <div className="h-3 w-24 rounded-full bg-slate-100" />
        <div className="mt-4 h-16 rounded-[18px] bg-slate-100" />
      </div>
    )
  }

  const { primaryAction } = vm

  // ── Onsite ─────────────────────────────────────────────────────────────────
  if (vm.kind === 'onsite') {
    return (
      <div
        className="rounded-[24px] overflow-hidden relative p-[22px]"
        style={{
          background: 'linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)',
          boxShadow: '0 16px 40px -16px rgba(37,99,235,0.55)',
        }}
      >
        <svg className="absolute -top-5 -right-5 opacity-15 pointer-events-none" width="180" height="180" viewBox="0 0 180 180">
          {[0,1,2,3,4,5].map(i => (
            <circle key={i} cx="90" cy="90" r={20 + i*14} stroke="#fff" strokeWidth="1" fill="none"/>
          ))}
        </svg>
        <div className="relative z-10">
          {/* Pill */}
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-sm">
            <span className="inline-block h-2 w-2 rounded-full bg-green-300" style={{ boxShadow: '0 0 0 3px rgba(134,239,172,0.3)' }} />
            <span className="text-[11px] font-bold text-white/90">Im Einsatz</span>
          </div>

          <div className="mt-5">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">
              Aktueller Einsatz
            </div>
            <div className="mt-1.5 text-[24px] font-bold text-white leading-snug tracking-[-0.025em]">
              {primaryAction?.label ?? 'Einsatz öffnen'}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-white/75">
              <MapPin size={12} />
              <span>Einsatz läuft</span>
            </div>
          </div>

          {primaryAction && (
            <button
              type="button"
              onClick={() => navigate(primaryAction.route)}
              className="relative z-10 mt-5 flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-white px-4 py-3 transition active:scale-[0.98]"
            >
              <span className="text-[14px] font-bold text-brand">{primaryAction.label}</span>
              <ArrowRight size={14} className="text-brand" />
            </button>
          )}
        </div>
      </div>
    )
  }

  // ── Between ────────────────────────────────────────────────────────────────
  if (vm.kind === 'between') {
    return (
      <div
        className="rounded-[24px] bg-white p-[22px] ring-1 ring-edge"
        style={{ boxShadow: '0 8px 18px -10px rgba(15,23,42,0.16), 0 2px 4px rgba(15,23,42,0.04)' }}
      >
        <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-bold text-brand">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
          Bereit
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-ink-muted">
            Erster Einsatz heute
          </div>
          <div className="mt-1.5 text-[22px] font-bold text-ink leading-snug tracking-[-0.02em]">
            {primaryAction?.label ?? 'Anfahrt starten'}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-ink-sub">
            <MapPin size={12} />
            <span>Einsatz heute geplant</span>
          </div>
        </div>

        {primaryAction && (
          <button
            type="button"
            onClick={() => navigate(primaryAction.route)}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-[14px] bg-brand px-4 py-3 transition active:scale-[0.98]"
          >
            <span className="text-[14px] font-bold text-white">{primaryAction.label}</span>
            <ArrowRight size={14} className="text-white" />
          </button>
        )}
      </div>
    )
  }

  // ── Day off ────────────────────────────────────────────────────────────────
  return (
    <div
      className="rounded-[24px] overflow-hidden relative p-[22px]"
      style={{
        background: 'linear-gradient(135deg, #0F766E 0%, #134E4A 100%)',
        boxShadow: '0 16px 40px -16px rgba(15,118,110,0.55)',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 backdrop-blur-sm">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-300" />
          <span className="text-[11px] font-bold text-white/90">Frei heute</span>
        </div>
      </div>
      <div className="mt-5">
        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/70">
          Heute kein Einsatz
        </div>
        <div className="mt-1.5 text-[24px] font-bold text-white leading-snug tracking-[-0.025em]">
          Genieß deinen<br />freien Tag
        </div>
        <div className="mt-1.5 text-[12px] text-white/80">
          Schau in den Kalender für deine nächsten Einsätze
        </div>
      </div>
    </div>
  )
}
