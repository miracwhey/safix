import { Link } from 'react-router-dom'
import { Scale, Users, ClipboardList, CheckCircle2 } from 'lucide-react'
import type { WorkEntrySummary, WorkEntryUrgency } from '../../lib/dashboard/workEntrySelectors'

type Props = {
  summary: WorkEntrySummary
  loading?: boolean
}

function getUrgencyIcon(urgency: WorkEntryUrgency) {
  if (urgency === 'critical') return <Scale size={20} aria-hidden />
  if (urgency === 'high') return <Users size={20} aria-hidden />
  if (urgency === 'normal') return <ClipboardList size={20} aria-hidden />
  return <CheckCircle2 size={20} aria-hidden />
}

// One style map covering all four states — consistent card language,
// state-specific tint only where urgency requires it.
const URGENCY_STYLES = {
  critical: {
    card:    'bg-rose-50 ring-1 ring-rose-200/70 shadow-[0_4px_16px_-8px_rgba(220,38,38,0.15)]',
    iconBg:  'bg-rose-100',
    iconTxt: 'text-rose-600',
    eyebrow: 'text-rose-600',
    title:   'text-ink',
    sub:     'text-ink-muted',
    cta:     'text-rose-600',
  },
  high: {
    card:    'bg-amber-50 ring-1 ring-amber-200/70 shadow-[0_4px_16px_-8px_rgba(217,119,6,0.15)]',
    iconBg:  'bg-amber-100',
    iconTxt: 'text-amber-600',
    eyebrow: 'text-amber-600',
    title:   'text-ink',
    sub:     'text-ink-muted',
    cta:     'text-amber-600',
  },
  normal: {
    card:    'bg-surface ring-1 ring-edge shadow-subtle',
    iconBg:  'bg-brand/10',
    iconTxt: 'text-brand',
    eyebrow: 'text-brand',
    title:   'text-ink',
    sub:     'text-ink-muted',
    cta:     'text-brand',
  },
  none: {
    card:    'bg-surface ring-1 ring-edge shadow-subtle',
    iconBg:  'bg-ok-bg',
    iconTxt: 'text-ok',
    eyebrow: 'text-ink-muted',
    title:   'text-ink',
    sub:     'text-ink-muted',
    cta:     'text-ink-muted',
  },
} as const

export default function WorkEntryCard({ summary, loading }: Props) {
  if (loading) {
    return (
      <div
        className="rounded-[24px] bg-surface ring-1 ring-edge p-5"
        aria-busy="true"
        aria-label="Arbeitsstatus wird geladen"
      >
        <div className="flex items-start gap-3.5">
          <div className="h-11 w-11 shrink-0 rounded-2xl bg-slate-100 animate-pulse" />
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            <div className="h-2.5 w-20 rounded bg-slate-100 animate-pulse" />
            <div className="h-4 w-44 rounded bg-slate-100 animate-pulse" />
            <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <div className="h-3 w-28 rounded-full bg-slate-100 animate-pulse" />
        </div>
      </div>
    )
  }

  const s = URGENCY_STYLES[summary.urgency]

  return (
    <Link
      to={summary.ctaRoute}
      className={`block rounded-[24px] p-5 transition active:scale-[0.98] ${s.card}`}
    >
      <div className="flex items-start gap-3.5">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${s.iconBg}`}>
          <span className={s.iconTxt}>{getUrgencyIcon(summary.urgency)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-[11px] font-bold uppercase tracking-[0.18em] ${s.eyebrow}`}>
            {summary.eyebrow}
          </div>
          <h2 className={`mt-0.5 text-[17px] font-bold leading-snug ${s.title}`}>
            {summary.headline}
          </h2>
          <p className={`mt-0.5 text-[13px] leading-snug ${s.sub}`}>
            {summary.subtitle}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end">
        <span className={`text-[12px] font-semibold ${s.cta}`}>{summary.ctaLabel}</span>
      </div>
    </Link>
  )
}
