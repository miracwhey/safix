/**
 * Spatial · V1.6.1 · CustomerWallFinishSheet
 *
 * Dark Liquid-Glass bottom-sheet to pick a WALL surface finish (Farbe / Putz /
 * Fliesen / Holz / Tapete / Beton / Ziegel) for the tapped wall. Opens from the
 * wall context-sheet ("Wandmaterial wählen"). One-tap-to-apply: tapping a finish
 * writes `Wall.material_id` (live preview via WallAdapter) and closes.
 *
 * Reuses the existing material catalog (`getCatalogMaterialsBySurface('wall')`)
 * + the provider picker's helpers (`materialThumbnailUrl` / `materialFinishLabel`)
 * — same data model the provider MaterialPickerSheet writes, just the customer
 * dark-glass skin and a direct blob-mutation apply path (no variant overrides).
 *
 * S2 polish (V1.6.1): a debounced search field (`useMaterialSearch`) over the
 * wall catalog + a Capacitor selection-haptic on apply. Category pills are
 * intentionally omitted — this is a wall-only sheet, so a pill row would render
 * four dead greyed chips. The grid switches to a flat search-results view while
 * a query is active, and back to the section grouping when cleared.
 *
 * Note: the PBR textures (.ktx2) are not yet shipped on disk, so the rendered
 * wall currently shows the catalog `fallbackColorHex` (a believable flat tint),
 * while the picker grid shows the real material thumbnail. Texturing is a
 * follow-up once the KTX2 asset pipeline lands.
 */

import { useEffect, useMemo } from 'react'

import type { CatalogMaterial } from '../../../lib/spatial/canonical/catalog/material-types'
import { getCatalogMaterialsBySurface } from '../../../lib/spatial/canonical/catalog/material-catalog'
import { useMaterialSearch } from '../../../lib/spatial/hooks/useMaterialSearch'
import { useHaptics } from '../../../hooks/useHaptics'
import {
  materialFinishLabel,
  materialThumbnailUrl,
} from '../../spatial/edit/materialPickerModel'

export interface CustomerWallFinishSheetProps {
  open: boolean
  /** Currently applied finish slug on the wall (for the selected highlight). */
  currentMaterialId?: string | null
  /** Wall label (e.g. "Nord 1") shown in the header. */
  wallLabel?: string
  /** Apply a finish slug to the wall. */
  onSelect: (slug: string) => void
  /** Reset the wall to the room default (clears the override). */
  onReset: () => void
  /** Close without changing anything. */
  onClose: () => void
}

interface FinishSection {
  label: string
  materials: CatalogMaterial[]
}

function groupBySection(materials: CatalogMaterial[]): FinishSection[] {
  const order: string[] = []
  const bySection = new Map<string, CatalogMaterial[]>()
  for (const m of materials) {
    if (!bySection.has(m.section)) {
      bySection.set(m.section, [])
      order.push(m.section)
    }
    bySection.get(m.section)!.push(m)
  }
  return order.map((label) => ({ label, materials: bySection.get(label)! }))
}

export default function CustomerWallFinishSheet({
  open,
  currentMaterialId,
  wallLabel,
  onSelect,
  onReset,
  onClose,
}: CustomerWallFinishSheetProps) {
  const haptics = useHaptics()

  // Synchronous in-process catalog — `useMaterialSearch` works on any
  // CatalogMaterial[], so the wall list feeds both browse + search without
  // switching to the async provider hook.
  const wallMaterials = useMemo(() => getCatalogMaterialsBySurface('wall'), [])
  const sections = useMemo(() => groupBySection(wallMaterials), [wallMaterials])
  const search = useMaterialSearch(wallMaterials)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reset the query when the sheet closes so a re-open starts on the full grid.
  useEffect(() => {
    if (!open) search.clear()
  }, [open, search])

  if (!open) return null

  const applyFinish = (slug: string) => {
    // Light picker tick on apply (sim/web-safe, per-mode throttled in the hook).
    haptics.selection()
    onSelect(slug)
  }

  const renderTile = (material: CatalogMaterial) => {
    const selected = currentMaterialId === material.slug
    return (
      <button
        key={material.slug}
        type="button"
        onClick={() => applyFinish(material.slug)}
        onPointerUp={(e) => {
          if (e.pointerType !== 'mouse') applyFinish(material.slug)
        }}
        aria-label={`${material.displayName} anwenden`}
        aria-pressed={selected}
        className={[
          'flex flex-col gap-1.5 rounded-2xl border p-1.5 text-left transition active:scale-[0.97]',
          selected
            ? 'border-blue-400/70 bg-blue-500/[0.14]'
            : 'border-white/12 bg-white/[0.05] hover:bg-white/[0.10]',
        ].join(' ')}
      >
        <span
          className="block aspect-square w-full overflow-hidden rounded-xl"
          style={{ background: material.fallbackColorHex }}
        >
          <img
            src={materialThumbnailUrl(material)}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={(e) => {
              // Thumbnail missing → keep the flat fallback colour.
              e.currentTarget.style.display = 'none'
            }}
          />
        </span>
        <span className="px-0.5">
          <span className="block truncate text-[11.5px] font-semibold leading-tight">
            {material.displayName}
          </span>
          <span className="block truncate text-[10px] text-white/50">
            {materialFinishLabel(material)}
          </span>
        </span>
      </button>
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wall-finish-title"
      className="fixed inset-0 z-[60] flex items-end justify-center"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Schließen"
        onClick={onClose}
        className="absolute inset-0 bg-black/55"
        style={{ backdropFilter: 'blur(2px)' }}
      />

      {/* Sheet */}
      <div
        className="relative z-[1] flex max-h-[82dvh] w-full max-w-[480px] flex-col rounded-t-3xl px-5 pt-4 text-white shadow-2xl"
        style={{
          background:
            'linear-gradient(180deg, rgba(20,28,48,0.92) 0%, rgba(15,21,37,0.96) 100%)',
          backdropFilter: 'blur(48px) saturate(220%)',
          WebkitBackdropFilter: 'blur(48px) saturate(220%)',
          border: '1px solid rgba(255,255,255,0.14)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
        }}
      >
        {/* Drag-handle */}
        <button
          type="button"
          aria-label="Schließen"
          onClick={onClose}
          onPointerUp={(e) => {
            if (e.pointerType !== 'mouse') onClose()
          }}
          className="mx-auto mb-3 block h-1 w-10 rounded-full bg-white/24"
        />

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="wall-finish-title" className="text-[18px] font-bold leading-tight">
              Wandmaterial {wallLabel ? `· ${wallLabel}` : ''}
            </h2>
            <p className="mt-0.5 text-[12px] text-white/60">
              Tippe ein Material — die Wand ändert sich sofort
            </p>
          </div>
          <button
            type="button"
            onClick={onReset}
            className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-white/80 transition active:scale-95 hover:bg-white/[0.16]"
          >
            Standard
          </button>
        </div>

        {/* Search (dark variant — the shared SearchField is light-skinned) */}
        <div className="mt-3 shrink-0">
          <div className="relative">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              inputMode="search"
              value={search.query}
              onChange={(e) => search.setQuery(e.target.value)}
              placeholder="In Wand-Materialien suchen"
              aria-label="In Wand-Materialien suchen"
              className="h-10 w-full rounded-xl border border-white/12 bg-white/[0.06] pl-9 pr-9 text-[14px] text-white placeholder-white/40 outline-none transition focus:border-blue-400/60 focus:bg-white/[0.09]"
            />
            {search.query.length > 0 && (
              <button
                type="button"
                onClick={search.clear}
                aria-label="Suche löschen"
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-[14px] leading-none text-white/70 transition active:scale-90 hover:bg-white/20"
              >
                ×
              </button>
            )}
          </div>
          {search.isActive && (
            <p className="mt-1.5 px-0.5 text-[11px] text-white/45">
              {search.resultCount} {search.resultCount === 1 ? 'Material' : 'Materialien'}
            </p>
          )}
        </div>

        {/* Finish grid — flat search results while a query is active, else
            grouped by section. */}
        <div className="mt-4 flex-1 overflow-y-auto overscroll-contain pb-2">
          {search.isActive ? (
            search.results.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
                <p className="text-[14px] font-semibold text-white/70">
                  Keine Materialien gefunden
                </p>
                <p className="text-[12px] text-white/40">Versuch einen anderen Suchbegriff</p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2.5">
                {search.results.map(renderTile)}
              </div>
            )
          ) : (
            <div className="flex flex-col gap-5">
              {sections.map((section) => (
                <section key={section.label}>
                  <h3 className="mb-2 px-0.5 text-[13px] font-semibold text-white/90">
                    {section.label}
                  </h3>
                  <div className="grid grid-cols-3 gap-2.5">
                    {section.materials.map(renderTile)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-3 h-12 w-full shrink-0 rounded-2xl bg-white/10 text-[15px] font-bold text-white transition active:scale-[0.98] hover:bg-white/[0.16]"
        >
          Fertig
        </button>
      </div>
    </div>
  )
}
