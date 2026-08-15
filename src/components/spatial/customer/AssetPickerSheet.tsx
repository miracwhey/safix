/**
 * Spatial · Customer · AssetPickerSheet (V1.6.1 Möbel-Place-Flow Phase 3)
 *
 * Dark Liquid-Glass bottom-sheet to browse the catalog and pick one asset to
 * place. Interaction (V1.6.1 simplify): browse → TAP a card → the sheet closes
 * and the host activates floor-tap placement. One-tap-to-place (the card tap is
 * the confirmation — the old separate "Weiter" footer step was dead weight for a
 * single-select picker).
 *
 * Host contract: keep MOUNTED and toggle `open` (mirrors MaterialPickerSheet)
 * so transitions stay smooth and selection state resets cleanly per open.
 *
 * Pure UI: it does not mutate the scene. The host's `onSelectAsset` receives the
 * chosen CatalogAsset and owns the place-flow (Phase 4).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CatalogAsset } from '../../../lib/spatial/canonical/catalog/types.ts'
import type { AssetCategory } from '../../../lib/spatial/canonical/snap/asset-snap.ts'
import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'
import { useHaptics } from '../../../hooks/useHaptics'
import { AssetCard } from './AssetCard'
import { ASSET_PICKER_PILLS, buildAssetSections } from './assetPickerModel'

export interface AssetPickerSheetProps {
  open: boolean
  onClose: () => void
  /** The user confirmed a selection — host opens floor-tap placement. */
  onSelectAsset: (asset: CatalogAsset) => void
  /** Category to open on (defaults to 'furniture'). */
  initialCategory?: AssetCategory
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(20,28,48,0.92) 0%, rgba(15,21,37,0.96) 100%)',
  backdropFilter: 'blur(48px) saturate(220%)',
  WebkitBackdropFilter: 'blur(48px) saturate(220%)',
  border: '1px solid rgba(255,255,255,0.14)',
}

export function AssetPickerSheet({
  open,
  onClose,
  onSelectAsset,
  initialCategory = 'furniture',
}: AssetPickerSheetProps) {
  const haptics = useHaptics()
  const panelRef = useRef<HTMLDivElement>(null)

  const [activeCategory, setActiveCategory] = useState<AssetCategory>(initialCategory)
  // #7: client-seitiger In-Memory-Filter über displayName + tags (Katalog ist
  // klein + komplett im Speicher) — ersetzt den toten "bald verfügbar"-Stub.
  const [query, setQuery] = useState('')

  useFocusTrap(panelRef, open)

  // Reset transient state on the open transition — the React "adjust state
  // during render" pattern (no setState-in-effect, no cascading render).
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setActiveCategory(initialCategory)
      setQuery('')
    }
  }

  // Focus the panel when it opens (DOM side-effect only).
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const sections = useMemo(() => buildAssetSections(activeCategory), [activeCategory])
  const visibleSections = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sections
    return sections
      .map((s) => ({
        ...s,
        assets: s.assets.filter(
          (a) =>
            a.displayName.toLowerCase().includes(q) ||
            a.tags.some((t) => t.toLowerCase().includes(q)),
        ),
      }))
      .filter((s) => s.assets.length > 0)
  }, [sections, query])

  const handlePickCategory = useCallback(
    (id: AssetCategory) => {
      if (id === activeCategory) return
      haptics.selection()
      setActiveCategory(id)
      setQuery('')
    },
    [activeCategory, haptics],
  )

  const handleTapAsset = useCallback(
    (asset: CatalogAsset) => {
      haptics.light()
      // 1-Tap-Place: the card tap IS the confirmation — no separate "Weiter"
      // step. The host (`onSelectAsset`) closes the picker, arms floor-tap
      // placement and toasts the next step. No extra onClose() here — single
      // close-owner, mirrors the old #11 contract.
      onSelectAsset(asset)
    },
    [haptics, onSelectAsset],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="asset-picker-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[82dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pt-2.5 text-white outline-none"
        style={{ ...SHEET_GLASS, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)' }}
      >
        {/* Drag handle */}
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
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <h2 id="asset-picker-title" className="text-[19px] font-bold leading-tight">
              Möbel hinzufügen
            </h2>
            <p className="mt-0.5 text-[12px] text-white/55">
              Tippe ein Möbel an — dann auf den Boden tippen
            </p>
          </div>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/8 text-white/75 transition active:scale-95 hover:bg-white/16"
          >
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        {/* Category pills */}
        <div className="mt-3 flex gap-2 overflow-x-auto pb-0.5" role="tablist" aria-label="Kategorie">
          {ASSET_PICKER_PILLS.map((pill) => {
            const active = pill.id === activeCategory
            return (
              <button
                key={pill.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handlePickCategory(pill.id)}
                className={[
                  'shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition',
                  active
                    ? 'bg-blue-600 text-white shadow-[0_6px_18px_rgba(37,99,235,0.42)]'
                    : 'bg-white/10 text-white/70 hover:bg-white/[0.16]',
                ].join(' ')}
              >
                {pill.label}
              </button>
            )
          })}
        </div>

        {/* #7 Suche: client-seitiger Filter über displayName + tags. */}
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/8 bg-white/[0.06] px-3.5 py-2.5">
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="shrink-0 text-white/45" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3-3" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Möbel suchen…"
            aria-label="Möbel suchen"
            className="w-full bg-transparent text-[13px] text-white outline-none placeholder:text-white/35"
          />
          {query.length > 0 && (
            <button
              type="button"
              aria-label="Suche löschen"
              onClick={() => setQuery('')}
              className="shrink-0 text-white/40 transition hover:text-white/75"
            >
              <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12 M18 6l-12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Scrollable grid */}
        <div className="mt-4 flex-1 overflow-y-auto overscroll-contain pb-2">
          {visibleSections.length === 0 ? (
            <div role="status" className="flex flex-col items-center gap-2 rounded-2xl bg-white/5 px-4 py-10 text-center">
              <p className="text-[13px] text-white/60">
                {query.trim()
                  ? `Kein Treffer für „${query.trim()}".`
                  : 'In dieser Kategorie ist noch nichts verfügbar.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {visibleSections.map((section, index) => {
                const labelId = `asset-section-${index}`
                return (
                  <section key={section.label} role="group" aria-labelledby={labelId}>
                    <header id={labelId} className="mb-2 flex items-baseline justify-between px-0.5">
                      <h3 className="text-[13px] font-semibold text-white/90">{section.label}</h3>
                      <span className="text-[12px] tabular-nums text-white/35">{section.assets.length}</span>
                    </header>
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                      {section.assets.map((asset) => (
                        <AssetCard
                          key={asset.slug}
                          asset={asset}
                          isSelected={false}
                          onTap={handleTapAsset}
                        />
                      ))}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer — only "Abbrechen"; picking a card places directly (1-tap). */}
        <div className="mt-3 border-t border-white/8 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="h-12 w-full rounded-2xl bg-white/10 text-[15px] font-bold text-white transition active:scale-[0.98] hover:bg-white/[0.16]"
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  )
}
