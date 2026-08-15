// @deprecated — use NavigationCard from src/components/primitives
import { Link } from 'react-router-dom'

type Props = {
  to: string
  icon: string
  title: string
  subtitle: string
  accent?: string
  badge?: string
  footer?: string
  compact?: boolean
}

export default function CraftsmanModuleCard({
  to,
  icon,
  title,
  subtitle,
  accent = 'bg-slate-100 text-slate-700',
  badge,
  footer,
  compact = false,
}: Props) {
  if (compact) {
    return (
      <Link
        to={to}
        className="inline-flex items-center gap-2 rounded-full bg-white px-3.5 py-2 text-left ring-1 ring-slate-200/70 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)] transition active:scale-[0.98]"
      >
        <div
          className={[
            'flex h-7 w-7 items-center justify-center rounded-lg text-[14px]',
            accent,
          ].join(' ')}
        >
          {icon}
        </div>
        <span className="text-[13px] font-medium text-slate-700">{title}</span>
        {badge ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {badge}
          </span>
        ) : null}
      </Link>
    )
  }

  return (
    <Link
      to={to}
      className="block rounded-[28px] bg-white p-5 text-left ring-1 ring-slate-200/70 shadow-[0_18px_40px_-28px_rgba(2,6,23,0.28)] transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={[
            'flex h-12 w-12 items-center justify-center rounded-2xl text-[22px]',
            accent,
          ].join(' ')}
        >
          {icon}
        </div>

        {badge ? (
          <div className="rounded-full bg-slate-100 px-3 py-1 text-[12px] font-semibold text-slate-600">
            {badge}
          </div>
        ) : null}
      </div>

      <div className="mt-5 text-[18px] font-semibold text-slate-900">
        {title}
      </div>

      <div className="mt-1 text-[14px] text-slate-500">
        {subtitle}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="text-[13px] text-slate-400">
          {footer ?? 'Bereich öffnen'}
        </div>
        <div className="text-[16px] font-semibold text-[#2563EB]">→</div>
      </div>
    </Link>
  )
}
