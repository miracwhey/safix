import { useNavigate } from 'react-router-dom'
import { Scan } from 'lucide-react'
import type { RoomScanMetadata } from '../../lib/roomScan/types'

type Props = {
  projectId: string
  metadata: RoomScanMetadata
}

function fmt(m: number): string {
  return m.toFixed(2).replace('.', ',') + ' m'
}

function fmtArea(m2: number): string {
  return m2.toFixed(1).replace('.', ',') + ' m²'
}

/**
 * Compact scan card in the thread persistent-context bar.
 * Tapping navigates to ProjectScanScreen (/projects/:id/scan) where the
 * craftsman sees gewerk-sorted raw data and the AR Quick Look button.
 */
export default function ThreadArtifactScanCard({ projectId, metadata }: Props) {
  const navigate = useNavigate()
  const primaryWall = metadata.walls[0]

  return (
    <button
      type="button"
      onClick={() => navigate(`/projects/${projectId}/scan`)}
      className="w-full rounded-[12px] bg-white px-3 py-2.5 ring-1 ring-slate-200/50 shadow-[0_4px_12px_-8px_rgba(2,6,23,0.08)] text-left transition active:bg-slate-50/60"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Scan size={14} className="shrink-0 text-brand" aria-hidden />
          <span className="text-[13px] font-semibold text-slate-900 shrink-0">Raumscan</span>
          <span className="text-[12px] text-slate-400 truncate">
            {fmtArea(metadata.floorAreaM2)}
            {primaryWall ? ` · ${fmt(primaryWall.widthM)} × ${fmt(primaryWall.heightM)}` : ''}
            {` · ${fmt(metadata.ceilingHeightM)} Höhe`}
          </span>
        </div>
        <span className="shrink-0 text-[11px] font-semibold text-brand">Ansehen →</span>
      </div>
    </button>
  )
}
