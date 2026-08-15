import { Link } from 'react-router-dom'
import { Box } from 'lucide-react'

/**
 * SpatialEntryCard — craftsman dashboard quick-access into the 3D / Aufmaß hub.
 *
 * The operative dashboard stays the provider's home; this card makes the 3D
 * area reachable in a single tap (`/craftsman/spatial`) instead of two
 * (Dashboard → Verwaltung → Spatial-Card). Mirrors {@link BackofficeEntryCard}
 * structurally. Static label — no count badge: a dashboard-time scan count
 * would force eager hydration of all provider scenes and regress TTFB; a
 * dedicated count RPC is a V1.6+ follow-up.
 */
export default function SpatialEntryCard() {
  return (
    <Link
      to="/craftsman/spatial"
      className="flex items-center gap-3 rounded-[18px] bg-white px-4 py-3.5 ring-1 ring-slate-200/70 shadow-[0_4px_12px_-10px_rgba(2,6,23,0.12)] transition active:scale-[0.98]"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[#EEF2FB] text-brand">
        <Box size={16} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-semibold text-ink">Aufmaße</span>
        <p className="mt-0.5 text-[11px] text-ink-muted">3D-Räume · Messungen · Projekte</p>
      </div>
      <span className="shrink-0 text-[13px] text-ink-muted">›</span>
    </Link>
  )
}
