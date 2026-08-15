import { Link } from 'react-router-dom'
import { LayoutGrid } from 'lucide-react'

export default function BackofficeEntryCard() {
  return (
    <Link
      to="/craftsman/backoffice"
      className="flex items-center gap-3 rounded-[18px] bg-white px-4 py-3.5 ring-1 ring-slate-200/70 shadow-[0_4px_12px_-10px_rgba(2,6,23,0.12)] transition active:scale-[0.98]"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-ink-sub">
        <LayoutGrid size={16} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-semibold text-ink">Verwaltung</span>
        <p className="mt-0.5 text-[11px] text-ink-muted">Anfragen · Aufträge · Finanzen</p>
      </div>
      <span className="shrink-0 text-[13px] text-ink-muted">›</span>
    </Link>
  )
}
