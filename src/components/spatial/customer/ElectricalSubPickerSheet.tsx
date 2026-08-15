/**
 * Spatial · V1.6.1 · L0-#2 · ElectricalSubPickerSheet
 *
 * Minimaler Liquid-Glass-BottomSheet, der beim Elektro-Tool zwischen
 * **Steckdose** (electrical_outlet) und **Schalter** (electrical_switch) wählt —
 * bevor der Wand-Tap platziert. Vorher legte der Tap hart eine Steckdose; der
 * Mutator + die DIN-Defaults für `electrical_switch` waren schon da, nur der
 * UI-Entry fehlte.
 *
 * Bewusst KEIN AssetPickerSheet (Such/Kategorien/Grid = Overkill für 2 Optionen)
 * — 2 große Tap-Cards mit Icon + DIN-Höhen-Hinweis. Pattern (Glass/Drag-Handle/
 * Esc/onPointerUp-iOS-Fallback) gespiegelt von CustomerObjectEditSheet.
 */

import { useEffect } from 'react'

import type { CustomerWallMountedKind } from '../../../lib/spatial/canonical/mutations/customerObjectMutator'

export type ElectricalKind = Extract<
  CustomerWallMountedKind,
  'electrical_outlet' | 'electrical_switch'
>

export interface ElectricalSubPickerSheetProps {
  open: boolean
  onSelect: (kind: ElectricalKind) => void
  onClose: () => void
}

interface OptionMeta {
  kind: ElectricalKind
  label: string
  hint: string
  icon: React.ReactNode
}

const OUTLET_ICON = (
  <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <circle cx="9" cy="12" r="1.4" />
    <circle cx="15" cy="12" r="1.4" />
  </svg>
)

const SWITCH_ICON = (
  <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
    <path d="M9 7.5h6v9h-6z" />
    <path d="M9 12h6" />
  </svg>
)

const OPTIONS: OptionMeta[] = [
  {
    kind: 'electrical_outlet',
    label: 'Steckdose',
    hint: 'Schuko · 30 cm über Boden (DIN 18015-2)',
    icon: OUTLET_ICON,
  },
  {
    kind: 'electrical_switch',
    label: 'Schalter',
    hint: 'Wippschalter · 105 cm über Boden (DIN 18015-2)',
    icon: SWITCH_ICON,
  },
]

export default function ElectricalSubPickerSheet({
  open,
  onSelect,
  onClose,
}: ElectricalSubPickerSheetProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="electrical-subpicker-title"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-3 pointer-events-none"
    >
      <div
        className="relative w-full max-w-[440px] rounded-3xl px-5 pb-5 pt-4 text-white shadow-2xl pointer-events-auto"
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

        <h2
          id="electrical-subpicker-title"
          className="text-[16px] font-bold leading-tight"
        >
          Elektro platzieren
        </h2>
        <p className="mt-0.5 text-[11px] text-white/55">Steckdose oder Schalter wählen</p>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {OPTIONS.map((opt) => (
            <button
              key={opt.kind}
              type="button"
              onClick={() => onSelect(opt.kind)}
              onPointerUp={(e) => {
                if (e.pointerType !== 'mouse') onSelect(opt.kind)
              }}
              className="flex flex-col items-start gap-2 rounded-2xl border border-white/12 bg-white/[0.06] px-4 py-4 text-left transition active:scale-[0.98] hover:bg-white/[0.12]"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-400/14 text-amber-200">
                {opt.icon}
              </span>
              <span className="text-[14px] font-semibold">{opt.label}</span>
              <span className="text-[10.5px] leading-snug text-white/55">{opt.hint}</span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onClose}
          onPointerUp={(e) => {
            if (e.pointerType !== 'mouse') onClose()
          }}
          className="mt-4 w-full rounded-full bg-white/[0.06] px-4 py-3 text-[14px] font-semibold text-white/82 transition active:scale-[0.98] hover:bg-white/[0.12]"
        >
          Abbrechen
        </button>
      </div>
    </div>
  )
}
