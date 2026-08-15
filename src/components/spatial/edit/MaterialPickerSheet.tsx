/**
 * Spatial · Edit · MaterialPickerSheet (Mockup 42 V5)
 *
 * The provider's Material-Picker bottom-sheet. Opens from the Edit-Mode viewer
 * when a surface is tapped (the Edit-Mode host lands in Phase 2 — Day 24+; the
 * sheet itself ships now per the Day 20 block plan).
 *
 * Interaction model — Tap-to-apply (Mockup 42 §1): tapping a material commits
 * the variant-write via `onApply`, the panel closes, and the {@link
 * MaterialUndoToast} appears for 8 s as the safety net. "Rückgängig" calls
 * `onUndo`.
 *
 * Host contract: keep `<MaterialPickerSheet>` MOUNTED and toggle `open` — the
 * component owns the Undo-Toast + the live region, which must survive the
 * panel closing. Conditionally rendering the whole component would drop the
 * toast on the floor.
 *
 * States covered (Mockup 42 §4): A Browse · B Search · C Applied+Undo ·
 * D Loading · E Error · F Offline · plus the dispute lock-banner. Phase-2
 * locked premium materials (State G) are out of scope for V1.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { CatalogMaterial } from '../../../lib/spatial/canonical/catalog/material-types.ts'
import { useMaterialCatalog } from '../../../lib/spatial/hooks/useMaterialCatalog'
import { useMaterialSearch } from '../../../lib/spatial/hooks/useMaterialSearch'
import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'
import { useToast } from '../../../hooks/useToast'
import { useHaptics } from '../../../hooks/useHaptics'
import { CategoryPillRow } from './CategoryPillRow'
import { SearchField } from './SearchField'
import { MaterialSectionGrid } from './MaterialSectionGrid'
import { MaterialUndoToast } from './MaterialUndoToast'
import {
  CATEGORY_PILLS,
  surfaceTypeToCategory,
  type SurfaceType,
} from './materialPickerModel'

/** The surface a material is being applied to. */
export interface MaterialPickerSurface {
  /** Scene-graph node id of the surface. */
  id: string
  type: SurfaceType
  /** Human-readable label, e.g. "Wand 2 · Süden · 9,1 m²". */
  label: string
}

export interface MaterialPickerSheetProps {
  open: boolean
  surface: MaterialPickerSurface | null
  /** Slug of the material currently applied to the surface. */
  currentMaterialSlug: string | null
  /** Commit the material variant-write. May be async (texture load). */
  onApply: (material: CatalogMaterial) => void | Promise<void>
  /** Revert the most recent apply (wired to the host's apply handle). */
  onUndo: () => void
  onClose: () => void
  /** When set, applying is blocked and a banner explains why (dispute lock). */
  lockReason?: string | null
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.84)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
}

interface UndoToastState {
  materialName: string
  /** Bumped per apply so the toast remounts (timer resets · only one live). */
  nonce: number
}

export function MaterialPickerSheet({
  open,
  surface,
  currentMaterialSlug,
  onApply,
  onUndo,
  onClose,
  lockReason,
}: MaterialPickerSheetProps) {
  const toast = useToast()
  const haptics = useHaptics()

  const category = surface ? surfaceTypeToCategory(surface.type) : null
  const categoryLabel =
    CATEGORY_PILLS.find((p) => p.id === category)?.label ?? 'Material'

  const { materials, sections, status, isHydrated, reload } = useMaterialCatalog(category)
  const search = useMaterialSearch(materials)

  const [applyingSlug, setApplyingSlug] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')
  const [undoToast, setUndoToast] = useState<UndoToastState | null>(null)
  const busyRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const panelOpen = open && surface !== null
  useFocusTrap(panelRef, panelOpen)

  // Reset transient state whenever the sheet (re)opens for a surface.
  useEffect(() => {
    if (!open) return
    setApplyingSlug(null)
    setUndoToast(null)
    busyRef.current = false
    search.clear()
    panelRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, surface?.id])

  // Escape closes the sheet (Mockup 42 §5).
  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panelOpen, onClose])

  const locked = Boolean(lockReason)

  const handleTap = useCallback(
    (material: CatalogMaterial) => {
      if (locked) {
        toast.info(lockReason ?? 'Material-Änderung gesperrt.')
        return
      }
      if (busyRef.current || material.slug === currentMaterialSlug) return
      busyRef.current = true
      setApplyingSlug(material.slug)
      void (async () => {
        try {
          await Promise.resolve(onApply(material))
          haptics.success()
          setAnnounce(`${material.displayName} angewendet`)
          setUndoToast({ materialName: material.displayName, nonce: Date.now() })
          onClose()
        } catch (err) {
          haptics.error()
          toast.error(
            `Material konnte nicht angewendet werden: ${
              err instanceof Error ? err.message : 'unbekannter Fehler'
            }`,
          )
          setApplyingSlug(null)
        } finally {
          busyRef.current = false
        }
      })()
    },
    [locked, lockReason, currentMaterialSlug, onApply, onClose, haptics, toast],
  )

  // Browse mode → grouped sections; search mode → one flat unlabelled section.
  const gridSections = useMemo(() => {
    if (search.isActive) return [{ section: '', materials: search.results }]
    return sections
  }, [search.isActive, search.results, sections])

  return (
    <>
      {panelOpen && surface && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
          onClick={onClose}
          role="presentation"
        >
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby="material-picker-title"
            onClick={(e) => e.stopPropagation()}
            className="flex max-h-[86dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
            style={SHEET_GLASS}
          >
            {/* Drag handle */}
            <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15" />

            {/* Title + close */}
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <h2 id="material-picker-title" className="text-[19px] font-bold text-slate-900">
                  Material
                </h2>
                <p className="truncate text-[13px] text-slate-500">{surface.label}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Schließen"
                className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-slate-400 active:scale-90 hover:bg-slate-900/5 hover:text-slate-600"
              >
                <svg viewBox="0 0 20 20" className="size-5" fill="currentColor">
                  <path d="M10 8.586 6.707 5.293 5.293 6.707 8.586 10l-3.293 3.293 1.414 1.414L10 11.414l3.293 3.293 1.414-1.414L11.414 10l3.293-3.293-1.414-1.414L10 8.586Z" />
                </svg>
              </button>
            </div>

            {/* Category pills (context — non-switchable per §3a) */}
            {category && (
              <div className="mt-3">
                <CategoryPillRow activeCategory={category} />
              </div>
            )}

            {/* Search */}
            <div className="mt-3">
              <SearchField
                value={search.query}
                onChange={search.setQuery}
                onClear={search.clear}
                placeholder={`In ${categoryLabel}-Materials suchen`}
              />
            </div>

            {/* Lock banner */}
            {locked && (
              <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800 ring-1 ring-amber-200">
                🔒 {lockReason}
              </div>
            )}

            {/* Offline banner */}
            {status === 'offline' && (
              <div className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-[12px] font-medium text-slate-600">
                📡 Offline · zuletzt geladene Materials
              </div>
            )}

            {/* Result count (search · non-empty results only — the empty
                state below carries the 0-result message + announcement) */}
            {search.isActive && search.resultCount > 0 && (
              <p className="mt-3 px-0.5 text-[12px] text-slate-500" aria-live="polite">
                {search.resultCount} Treffer für „{search.debouncedQuery}“
              </p>
            )}

            {/* Scroll content */}
            <div className="mt-3 flex-1 overflow-y-auto overscroll-contain pb-2">
              {status === 'loading' && !isHydrated ? (
                <LoadingSkeleton />
              ) : status === 'error' ? (
                <ErrorState onRetry={reload} />
              ) : search.isActive && search.resultCount === 0 ? (
                <SearchEmptyState query={search.debouncedQuery} onClear={search.clear} />
              ) : (
                <MaterialSectionGrid
                  sections={gridSections}
                  currentMaterialSlug={currentMaterialSlug}
                  applyingSlug={applyingSlug}
                  disabled={locked || applyingSlug !== null}
                  onTapMaterial={handleTap}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Undo-Toast — survives the panel close (Mockup 42 State C). */}
      {undoToast && (
        <MaterialUndoToast
          key={undoToast.nonce}
          visible
          materialName={undoToast.materialName}
          onUndo={() => {
            onUndo()
            setUndoToast(null)
          }}
          onDismiss={() => setUndoToast(null)}
        />
      )}

      {/* Persistent polite live-region — outside the panel so the apply
          announcement is still in the DOM after the panel unmounts. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  )
}

function LoadingSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-2xl bg-white/70 ring-1 ring-slate-900/10">
          <div className="aspect-square w-full animate-pulse bg-slate-200" />
          <div className="space-y-1.5 px-2.5 py-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-slate-100" />
          </div>
        </div>
      ))}
    </div>
  )
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl bg-white/70 px-4 py-8 text-center ring-1 ring-slate-900/10">
      <p className="text-[13px] text-slate-600">Materials konnten nicht geladen werden.</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full bg-slate-900 px-4 py-1.5 text-[13px] font-semibold text-white active:scale-95"
      >
        Erneut
      </button>
    </div>
  )
}

function SearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-2xl bg-white/70 px-4 py-8 text-center ring-1 ring-slate-900/10"
    >
      <svg viewBox="0 0 24 24" className="size-8 text-slate-300" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3M8 8l6 6" strokeLinecap="round" />
      </svg>
      <p className="text-[13px] text-slate-600">Keine Treffer für „{query}“</p>
      <button
        type="button"
        onClick={onClear}
        className="rounded-full bg-slate-900 px-4 py-1.5 text-[13px] font-semibold text-white active:scale-95"
      >
        Suche löschen
      </button>
    </div>
  )
}
