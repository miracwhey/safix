/**
 * Spatial Lane 3 V1.6 Block 3 · Customer Home Card — "Meine Räume"
 *
 * Three states, always visible on `CustomerHomeScreen` (Discovery-Card by
 * design — user-decision TBD-5):
 *
 *   1. Empty       — onboarding copy, no scans yet
 *   2. Single      — one card with title + date + "Ansehen" CTA
 *   3. Multiple    — vertical list of up to 5 + "Alle ansehen" link
 *
 * Renders nothing on the loading tick to avoid layout flicker; the parent
 * reserves the row because the card is always present once `isHydrated` flips.
 */

import { Link } from 'react-router-dom'
import { Box, ChevronRight, AlertTriangle } from 'lucide-react'

import { useCustomerSpatialScans } from '../../lib/spatial/hooks/useCustomerSpatialScans'
import type { Scan } from '../../lib/spatial/types'

function formatDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }).format(
      new Date(ts),
    )
  } catch {
    return ''
  }
}

function scanTitle(s: Scan): string {
  return s.ownerType === 'customer' ? 'Eigenes Aufmaß' : 'Aufmaß vom Handwerker'
}

function scanSubtitle(s: Scan): string {
  const date = formatDate(s.createdAt)
  return s.ownerType === 'customer'
    ? `Selbst erstellt · ${date}`
    : `Freigegeben · ${date}`
}

/**
 * Dark "3D" thumbnail tile — a navy gradient plate with a wireframe-box glyph.
 * A real per-scan render is not available on the customer-home query, so this
 * is a faithful placeholder rather than a fabricated room preview.
 */
function ScanThumb() {
  return (
    <span className="relative flex h-[60px] w-[76px] shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-[linear-gradient(157deg,#0E2153,#16327B_60%,#1E3A8A)]">
      <span className="absolute left-1.5 top-1.5 rounded-full bg-white/15 px-1.5 py-[2px] text-[8px] font-bold uppercase tracking-[0.1em] text-white">
        3D
      </span>
      <Box size={26} strokeWidth={1.25} className="text-white/85" aria-hidden />
    </span>
  )
}

/** Presentational scan row (navy tile + title/subtitle + chevron). */
export function SpatialScanRow({
  title,
  subtitle,
  to,
}: {
  title: string
  subtitle: string
  to: string
}) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-[16px] bg-surface p-2.5 ring-1 ring-edge/70 shadow-elevated transition hover:bg-slate-50 active:scale-[0.99]"
    >
      <ScanThumb />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-bold text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] text-ink-sub">{subtitle}</div>
      </div>
      <ChevronRight size={18} className="shrink-0 text-ink-muted" aria-hidden />
    </Link>
  )
}

function EmptyState() {
  return (
    <div className="flex items-center gap-3 rounded-[16px] bg-surface p-2.5 ring-1 ring-edge/70 shadow-elevated">
      <ScanThumb />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-bold text-ink">Demnächst hier</div>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Sobald dein Handwerker dir ein 3D-Aufmaß freigibt, erscheint es hier — drehen, zoomen, Maße prüfen.
        </p>
      </div>
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-[16px] bg-surface p-3 ring-1 ring-edge/70 shadow-elevated">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-amber-100">
        <AlertTriangle size={20} className="text-amber-600" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-bold text-ink">Aufmaße konnten nicht geladen werden</div>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Bitte prüfe deine Verbindung und versuche es erneut.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void onRetry()}
        className="shrink-0 rounded-[10px] bg-white px-3 py-1.5 text-[13px] font-semibold text-brand ring-1 ring-edge transition active:scale-[0.97]"
      >
        Erneut
      </button>
    </div>
  )
}

function ScanCard({ scan }: { scan: Scan }) {
  return (
    <SpatialScanRow
      title={scanTitle(scan)}
      subtitle={scanSubtitle(scan)}
      to={`/customer/spatial/scan/${scan.id}`}
    />
  )
}

export function CustomerSpatialHomeCard() {
  const { scans, isHydrated, status, reload } = useCustomerSpatialScans()

  if (!isHydrated) {
    return (
      <div className="h-[72px] animate-pulse rounded-[16px] bg-slate-100" aria-busy="true" />
    )
  }

  if (status === 'unauthenticated') return null

  // Error must surface with a retry — never fall through to the empty
  // "Demnächst hier" state, which would silently mask a failed load.
  if (status === 'error') {
    return <ErrorState onRetry={reload} />
  }

  if (scans.length === 0) {
    // Only show the empty state once truly ready; during a background reload
    // keep the skeleton rather than flashing "Demnächst hier".
    return status === 'ready' ? (
      <EmptyState />
    ) : (
      <div className="h-[72px] animate-pulse rounded-[16px] bg-slate-100" aria-busy="true" />
    )
  }

  if (scans.length === 1) {
    return <ScanCard scan={scans[0]} />
  }

  const preview = scans.slice(0, 5)
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        {preview.map(s => (
          <ScanCard key={s.id} scan={s} />
        ))}
      </div>
      <Link
        to="/customer/spatial/list"
        className="block text-right text-[12px] font-semibold text-brand hover:underline"
      >
        Alle {scans.length} Räume ansehen →
      </Link>
    </div>
  )
}
