/**
 * Spatial · Hub · HubFilterSheet (V1.5 · Phase B-P3)
 *
 * Bottom-sheet opened from the Spatial-Hub header Filter-Icon. Lets the
 * provider narrow the pipeline + activity views via status / date / source
 * chips. Apply commits the value back to the host; the sheet keeps a local
 * draft so closing without "Anwenden" discards changes.
 *
 * Chip-strip JSX mirrors {@link CraftsmanJobsScreen}'s SectionChipStrip
 * (snap-x, active=dark / inactive=light).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { X, RotateCcw } from 'lucide-react'

import {
  DEFAULT_HUB_FILTER,
  type HubFilterDate,
  type HubFilterSource,
  type HubFilterStatus,
  type HubFilterValue,
} from './hubFilterModel'
import { useFocusTrap } from '../../../lib/spatial/hooks/useFocusTrap'

/**
 * Host contract: render conditionally — `{open && <HubFilterSheet … />}`. The
 * sheet seeds its draft from `value` on mount; remounting on every open keeps
 * a transient draft from leaking across opens without a sync-effect.
 */
export interface HubFilterSheetProps {
  value: HubFilterValue
  onApply: (next: HubFilterValue) => void
  onClose: () => void
}

const SHEET_GLASS: React.CSSProperties = {
  background: 'rgba(250,250,253,0.84)',
  backdropFilter: 'blur(64px) saturate(185%)',
  WebkitBackdropFilter: 'blur(64px) saturate(185%)',
  boxShadow: '0 -1px 0 rgba(255,255,255,0.6) inset, 0 -16px 50px rgba(15,23,42,0.18)',
}

const STATUS_CHIPS: { id: HubFilterStatus; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'neu', label: 'Neu' },
  { id: 'quoting', label: 'Angebot' },
  { id: 'aktiv', label: 'Aktiv' },
  { id: 'fertig', label: 'Fertig' },
  { id: 'presales', label: 'Aufmaß' },
]

const DATE_CHIPS: { id: HubFilterDate; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'today', label: 'Heute' },
  { id: 'week', label: 'Diese Woche' },
  { id: 'month', label: 'Dieser Monat' },
]

const SOURCE_CHIPS: { id: HubFilterSource; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'job', label: 'Job' },
  { id: 'presales', label: 'Aufmaß' },
]

export function HubFilterSheet({ value, onApply, onClose }: HubFilterSheetProps) {
  const [draft, setDraft] = useState<HubFilterValue>(value)
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, true)

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const reset = useCallback(() => setDraft(DEFAULT_HUB_FILTER), [])
  const apply = useCallback(() => {
    onApply(draft)
  }, [draft, onApply])

  const dirty =
    draft.status !== value.status ||
    draft.date !== value.date ||
    draft.source !== value.source

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.20)', backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hub-filter-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86dvh] w-full max-w-[460px] flex-col rounded-t-[30px] px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-2.5 outline-none"
        style={SHEET_GLASS}
      >
        <div aria-hidden="true" className="mx-auto mb-2 h-1 w-10 rounded-full bg-slate-900/15" />

        <div className="flex items-start justify-between">
          <div>
            <h2 id="hub-filter-title" className="text-[19px] font-bold text-slate-900">
              Filter
            </h2>
            <p className="mt-0.5 text-[12.5px] text-slate-500">
              Pipeline + Aktivität eingrenzen
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Schließen"
            className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-slate-900/5 hover:text-slate-600 active:scale-90"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-4 flex-1 overflow-y-auto overscroll-contain pb-2">
          <FilterGroup label="Status">
            <ChipStrip
              chips={STATUS_CHIPS}
              value={draft.status}
              onChange={(next) => setDraft((p) => ({ ...p, status: next }))}
            />
          </FilterGroup>
          <FilterGroup label="Zeitraum">
            <ChipStrip
              chips={DATE_CHIPS}
              value={draft.date}
              onChange={(next) => setDraft((p) => ({ ...p, date: next }))}
            />
          </FilterGroup>
          <FilterGroup label="Quelle">
            <ChipStrip
              chips={SOURCE_CHIPS}
              value={draft.source}
              onChange={(next) => setDraft((p) => ({ ...p, source: next }))}
            />
          </FilterGroup>
        </div>

        <div className="flex items-center gap-2.5 border-t border-slate-200/70 pt-3">
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 rounded-[13px] border border-slate-200 bg-white/80 px-3 py-3 text-[13px] font-semibold text-slate-600 active:scale-[0.98]"
          >
            <RotateCcw className="size-4" />
            Zurücksetzen
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!dirty}
            className="flex-1 rounded-[13px] bg-slate-900 py-3 text-[14px] font-bold text-white shadow-md active:scale-[0.98] disabled:opacity-50"
          >
            Anwenden
          </button>
        </div>
      </div>
    </div>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-2 px-0.5 text-[11px] font-bold uppercase tracking-[0.6px] text-slate-500">
        {label}
      </h3>
      {children}
    </section>
  )
}

interface ChipStripProps<T extends string> {
  chips: readonly { id: T; label: string }[]
  value: T
  onChange: (next: T) => void
}

function ChipStrip<T extends string>({ chips, value, onChange }: ChipStripProps<T>) {
  return (
    <div
      role="tablist"
      className="-mx-1 flex snap-x items-center gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
    >
      {chips.map((c) => {
        const active = c.id === value
        return (
          <button
            key={c.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(c.id)}
            className={[
              'inline-flex shrink-0 snap-start items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold ring-1 transition',
              active
                ? 'bg-slate-900 text-white ring-slate-900'
                : 'bg-white/80 text-slate-600 ring-slate-200 hover:bg-white',
            ].join(' ')}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}
