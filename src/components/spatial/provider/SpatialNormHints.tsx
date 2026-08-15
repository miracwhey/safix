/**
 * SpatialNormHints — Provider Stückliste-Tab · "Raumdaten & Norm-Hinweise".
 *
 * Surfaces, read-only, two things the craftsman could never see before:
 *   1. The derived room geometry (area / volume / ceiling height / walls /
 *      perimeter / exterior walls) — all already computed on the scene.
 *   2. The 7 DIN/VDE soft-warnings from {@link evaluateSceneDin} (until now
 *      customer-only). Each warning carries a one-tap "Als Position übernehmen"
 *      that drops a trade-actionable line into the BoM — turning a norm hint
 *      into billable work + positioning the craftsman as the norm expert.
 *
 * Pure presentation: warnings + info are computed in the BoM tab and passed in.
 * Collapsed by default with a hint count so it never crowds the position list.
 */

import { useState } from 'react'
import { AlertTriangle, ChevronDown, Plus, Check, Ruler } from 'lucide-react'
import type { DinWarning } from '../../../lib/spatial/canonical/validator/wallObjectDinValidator'
import { dinWarningKey } from '../../../lib/spatial/canonical/validator/sceneDinSummary'

export interface RoomGeometryInfo {
  areaM2: number
  volumeM3: number
  ceilingHeightM: number
  wallCount: number
  exteriorWallCount: number
  perimeterM: number
}

interface Props {
  info: RoomGeometryInfo
  warnings: DinWarning[]
  /** Keys (via {@link dinWarningKey}) of warnings already added as positions. */
  addedKeys: Set<string>
  onAddPosition: (warning: DinWarning) => void
}

function fmt(n: number, unit: string): string {
  return `${n.toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${unit}`
}

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] bg-[#F4F6FA] px-2.5 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-bold text-ink">{value}</div>
    </div>
  )
}

export default function SpatialNormHints({ info, warnings, addedKeys, onAddPosition }: Props) {
  const [open, setOpen] = useState(false)
  const warnCount = warnings.length

  return (
    <div className="border-b border-edge bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
      >
        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[9px] bg-[#EEF2FB] text-brand">
          <Ruler size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold text-ink">Raumdaten &amp; Norm-Hinweise</span>
          <span className="block text-[11px] text-ink-muted">
            {fmt(info.areaM2, 'm²')} · {info.wallCount} Wände
            {warnCount > 0 ? ` · ${warnCount} Hinweis${warnCount === 1 ? '' : 'e'}` : ' · keine Hinweise'}
          </span>
        </span>
        {warnCount > 0 && (
          <span className="flex-shrink-0 rounded-full bg-[#FEF3C7] px-2 py-[2px] text-[11px] font-bold text-[#B45309]">
            {warnCount}
          </span>
        )}
        <ChevronDown
          size={17}
          className={`flex-shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-4 pb-3.5">
          {/* Room geometry */}
          <div className="grid grid-cols-3 gap-1.5">
            <InfoCell label="Fläche" value={fmt(info.areaM2, 'm²')} />
            <InfoCell label="Volumen" value={fmt(info.volumeM3, 'm³')} />
            <InfoCell label="Raumhöhe" value={fmt(info.ceilingHeightM, 'm')} />
            <InfoCell label="Umfang" value={fmt(info.perimeterM, 'm')} />
            <InfoCell label="Wände" value={String(info.wallCount)} />
            <InfoCell label="Außenwände" value={String(info.exteriorWallCount)} />
          </div>

          {/* DIN/VDE hints */}
          {warnCount > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              {warnings.map((w) => {
                const key = dinWarningKey(w)
                const added = addedKeys.has(key)
                return (
                  <div
                    key={key}
                    className="rounded-[12px] border border-[#FCE9C7] bg-[#FFFBF2] px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={14} className="mt-[1px] flex-shrink-0 text-[#B45309]" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] font-semibold leading-snug text-ink">{w.message}</p>
                        <span className="mt-1 inline-block rounded-full bg-white px-2 py-[1px] text-[10px] font-bold text-ink-sub">
                          {w.dinRef}
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 flex justify-end">
                      {added ? (
                        <span className="flex items-center gap-1 text-[11.5px] font-bold text-ok">
                          <Check size={13} /> Als Position übernommen
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onAddPosition(w)}
                          className="flex items-center gap-1 rounded-[9px] bg-brand px-2.5 py-1.5 text-[11.5px] font-bold text-white"
                        >
                          <Plus size={12} strokeWidth={2.5} />
                          Als Position übernehmen
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
