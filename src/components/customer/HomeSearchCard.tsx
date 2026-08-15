/**
 * HomeSearchCard — quick-access "Handwerker finden" tile on the customer home.
 *
 * Presentational: the caller owns the route + router-state (the money-funnel
 * contract requires the home pill to stay `mode: 'manual'`), so this component
 * never hard-codes a search mode.
 */
import { Link } from 'react-router-dom'
import { Search, ArrowRight } from 'lucide-react'

type Props = {
  to: string
  state?: Record<string, unknown>
  title: string
  subtitle: string
}

export default function HomeSearchCard({ to, state, title, subtitle }: Props) {
  return (
    <Link
      to={to}
      state={state}
      aria-label={title}
      className="flex items-center gap-3.5 rounded-[18px] bg-surface p-3.5 ring-1 ring-edge/70 shadow-elevated transition active:scale-[0.99]"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(160deg,#3B82F6,#2563EB_55%,#1D4ED8)] text-white shadow-[0_8px_16px_-6px_rgba(37,99,235,0.6)]">
        <Search size={19} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold tracking-[-0.01em] text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] text-ink-sub">{subtitle}</div>
      </div>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand">
        <ArrowRight size={16} aria-hidden />
      </span>
    </Link>
  )
}
