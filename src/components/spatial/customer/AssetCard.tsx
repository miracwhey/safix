/**
 * Spatial · Customer · AssetCard (V1.6.1 Möbel-Place-Flow Phase 3)
 *
 * One catalog asset in the picker grid: a square rendered thumbnail (with an
 * icon fallback when the JPG is missing / fails to load), a sheen overlay, and
 * the German name + footprint. The selected asset carries a brand ring +
 * "Gewählt" badge. Dark Liquid-Glass tile to match the Customer-Hub sheet.
 */

import { useState } from 'react'
import type { CatalogAsset } from '../../../lib/spatial/canonical/catalog/types.ts'
import { assetThumbnailUrl, formatAssetFootprint } from './assetPickerModel'

export interface AssetCardProps {
  asset: CatalogAsset
  isSelected: boolean
  disabled?: boolean
  onTap: (asset: CatalogAsset) => void
}

export function AssetCard({ asset, isSelected, disabled, onTap }: AssetCardProps) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const url = assetThumbnailUrl(asset)
  const showImage = url != null && !thumbFailed

  return (
    <button
      type="button"
      aria-current={isSelected ? 'true' : undefined}
      aria-label={`${asset.displayName} · ${formatAssetFootprint(asset)}${isSelected ? ' · gewählt' : ' · wählen'}`}
      disabled={disabled}
      onClick={() => onTap(asset)}
      className={[
        'group relative flex flex-col overflow-hidden rounded-2xl text-left transition',
        'border bg-white/[0.05] active:scale-[0.97] hover:-translate-y-0.5',
        isSelected
          ? 'border-blue-500 shadow-[0_0_0_1.5px_#3b82f6,0_8px_22px_rgba(37,99,235,0.42)]'
          : 'border-white/10',
        disabled ? 'opacity-60' : '',
      ].join(' ')}
    >
      {/* Thumbnail — rendered JPGs ship a light #eef1f6 background. */}
      <div className="relative aspect-square w-full bg-[#eef1f6]">
        {showImage ? (
          <img
            src={url}
            alt={asset.displayName}
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <div aria-hidden="true" className="flex size-full items-center justify-center text-slate-400">
            <svg viewBox="0 0 24 24" className="size-1/3" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
              <path d="M4 18v-5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5M4 14h16M6 18v2M18 18v2" />
            </svg>
          </div>
        )}

        {/* Sheen — top-left highlight + soft bottom shade. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(135deg, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0) 42%), ' +
              'linear-gradient(0deg, rgba(15,23,42,0.14) 0%, rgba(15,23,42,0) 38%)',
          }}
        />

        {isSelected && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-blue-600 px-2 py-0.5 text-[10px] font-bold text-white shadow">
            <svg viewBox="0 0 20 20" className="size-3" fill="currentColor" aria-hidden>
              <path d="M8.143 14.6 3.5 9.957l1.414-1.414 3.229 3.228 6.943-6.942 1.414 1.414z" />
            </svg>
            Gewählt
          </span>
        )}
      </div>

      {/* Name + footprint */}
      <div className="flex flex-col px-2.5 py-2">
        <span className="truncate text-[12.5px] font-semibold text-white">{asset.displayName}</span>
        <span className="truncate text-[11px] text-white/45">{formatAssetFootprint(asset)}</span>
      </div>
    </button>
  )
}
