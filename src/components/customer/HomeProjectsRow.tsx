/**
 * HomeProjectsRow — the "Alle Projekte" entry row at the foot of the customer
 * home. Lighter (translucent) than the primary cards; the active count is plain
 * muted text, only shown when there is at least one active project.
 */
import { Link } from 'react-router-dom'
import { FolderOpen, ChevronRight } from 'lucide-react'

export default function HomeProjectsRow({
  to,
  count,
}: {
  to: string
  count?: number
}) {
  return (
    <Link
      to={to}
      aria-label="Alle Projekte"
      className="flex items-center gap-3 rounded-[16px] bg-white/55 px-3.5 py-3 ring-1 ring-edge/60 transition active:scale-[0.99]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#EEF2F7] text-ink-sub">
        <FolderOpen size={17} aria-hidden />
      </span>
      <span className="flex-1 text-[14px] font-bold text-ink-sub">Alle Projekte</span>
      {count !== undefined && count > 0 && (
        <span className="text-[12px] font-semibold text-ink-muted">{count} aktiv</span>
      )}
      <ChevronRight size={16} className="text-ink-muted" aria-hidden />
    </Link>
  )
}
