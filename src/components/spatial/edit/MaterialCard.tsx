/**
 * Spatial · Edit · MaterialCard (Mockup 42 §3 · grid card)
 *
 * One material in the picker grid: a square albedo thumbnail (`<img>` with a
 * solid-colour fallback when the texture is not on Storage yet), a sheen
 * overlay for depth, and the name + finish label. The currently-applied
 * material carries a brand ring + "Aktuell" badge.
 */

import { useState } from 'react'
import Spinner from '../../system/Spinner'
import type { CatalogMaterial } from '../../../lib/spatial/canonical/catalog/material-types.ts'
import { materialThumbnailUrl, materialFinishLabel } from './materialPickerModel'

export interface MaterialCardProps {
  material: CatalogMaterial
  /** This material is the one currently applied to the surface. */
  isCurrent: boolean
  /** A fetch is in flight for this material — show a spinner, block taps. */
  isApplying: boolean
  /** Picker is locked (dispute / another apply in flight). */
  disabled: boolean
  onTap: (material: CatalogMaterial) => void
}

export function MaterialCard({ material, isCurrent, isApplying, disabled, onTap }: MaterialCardProps) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const showImage = !material.procedural && !thumbFailed

  return (
    <button
      type="button"
      aria-current={isCurrent ? 'true' : undefined}
      aria-label={`${material.displayName} · ${materialFinishLabel(material)}${
        isCurrent ? ' · aktuell angewendet' : ' · anwenden'
      }`}
      disabled={disabled || isCurrent}
      onClick={() => onTap(material)}
      className={[
        'group relative flex flex-col overflow-hidden rounded-2xl text-left transition',
        'bg-white/80 ring-1 ring-inset shadow-[0_2px_8px_rgba(15,23,42,0.06)]',
        'active:scale-[0.97] hover:-translate-y-0.5',
        isCurrent ? 'ring-2 ring-blue-600' : 'ring-slate-900/10',
        disabled && !isCurrent ? 'opacity-60' : '',
      ].join(' ')}
    >
      {/* Texture thumbnail */}
      <div className="relative aspect-square w-full">
        {showImage ? (
          <img
            src={materialThumbnailUrl(material)}
            alt={material.displayName}
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="size-full object-cover"
            style={{ backgroundColor: material.fallbackColorHex }}
          />
        ) : (
          <div
            aria-hidden="true"
            className="size-full"
            style={{ backgroundColor: material.fallbackColorHex }}
          />
        )}

        {/* Sheen — light highlight top-left, soft shade bottom (Mockup 42 §3) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0) 42%), ' +
              'linear-gradient(0deg, rgba(15,23,42,0.14) 0%, rgba(15,23,42,0) 38%)',
          }}
        />

        {isCurrent && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white shadow">
            <svg viewBox="0 0 20 20" className="size-3" fill="currentColor">
              <path d="M8.143 14.6 3.5 9.957l1.414-1.414 3.229 3.228 6.943-6.942 1.414 1.414z" />
            </svg>
            Aktuell
          </span>
        )}

        {isApplying && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/55">
            <Spinner size="md" tone="brand" />
          </div>
        )}
      </div>

      {/* Name + finish */}
      <div className="flex flex-col px-2.5 py-2">
        <span className="truncate text-[13px] font-semibold text-slate-900">
          {material.displayName}
        </span>
        <span className="truncate text-[11px] text-slate-500">
          {materialFinishLabel(material)}
        </span>
      </div>
    </button>
  )
}
