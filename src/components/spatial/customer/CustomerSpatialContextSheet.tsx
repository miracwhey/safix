/**
 * Spatial · V1.6.1 R11-B · CustomerSpatialContextSheet
 *
 * Object-First Context-Sheet (Mockup 25 V2 · Worker-Walk-Mode-Pattern):
 * öffnet wenn der Customer im 3D-Hub eine Surface (Wand / Boden / Decke /
 * Objekt) ohne aktives Tool antippt. Zeigt die kontextrelevanten Aktionen
 * als grosse Action-Cards.
 *
 * V1.6.1 Scope (enabled):
 *   - 4 Pin-Type-Aktionen (Tür · Fenster · Heizung · Elektro). Tap setzt den
 *     Pin direkt am tapped surface, ohne Zwischen-Tool-Auswahl. Beschleunigt
 *     den häufigsten Customer-Flow ("ich sehe das Ding, ich will's markieren").
 *   - "Wand bearbeiten" (nur wenn kind=wall) → öffnet WallEditSheet (Phase C).
 *   - "Wandmaterial wählen" (kind=wall + Edit-Rechte) → öffnet WallFinishSheet.
 *
 * Deferred (sichtbar als disabled cards mit "Bald verfügbar"-Hint):
 *   - Foto aufnehmen
 *   - Problem markieren
 *
 * Tool-First-Fallback: die existierende `CustomerSpatialToolBar` (Auswahl)
 * bleibt parallel sichtbar — wer lieber Tool-First arbeitet (erst Tool wählen,
 * dann tappen) kriegt KEIN Context-Sheet sondern direkt Pin-Drop + Detail-
 * Sheet wie vorher. Dieses Sheet ergänzt, ersetzt nicht.
 *
 * Pattern + Look erbt von `CustomerPinDetailSheet` (gleiche dark-glass-pill
 * Optik, drag-handle, role=dialog, Escape closes).
 */

import { useEffect } from 'react'

import {
  CUSTOMER_PIN_TYPES,
  getCustomerPinTypeSpec,
} from '../../../lib/spatial/canonical/pins/pinTypeSystem'
import type { CustomerPinType } from '../../../lib/spatial/types'
import type { TappedSurfaceKind } from '../three/canonical/surfaceTap'

export interface CustomerSpatialContextSheetProps {
  open: boolean
  /** Welche Surface der Customer angetappt hat. */
  surfaceKind: TappedSurfaceKind | null
  /** ID der getappten Surface (z.B. wall-id) — als Sub-Title gezeigt. */
  surfaceLabel?: string
  /** Pin direkt am tapped surface setzen (Pin-Type vorgewählt). */
  onPickPinType: (pinType: CustomerPinType) => void
  /** "Wand bearbeiten"-Aktion — nur sichtbar wenn kind=wall. */
  onEditWall?: () => void
  /** "Wandmaterial wählen"-Aktion — nur sichtbar wenn kind=wall + Edit-Rechte. */
  onPickFinish?: () => void
  /** Sheet schließen ohne Aktion. */
  onClose: () => void
}

const KIND_LABELS: Record<TappedSurfaceKind, string> = {
  wall: 'Wand',
  floor: 'Boden',
  ceiling: 'Decke',
  object: 'Objekt',
}

export default function CustomerSpatialContextSheet({
  open,
  surfaceKind,
  surfaceLabel,
  onPickPinType,
  onEditWall,
  onPickFinish,
  onClose,
}: CustomerSpatialContextSheetProps) {
  // Escape closes — Standard Dialog-Convention, keeps the sheet usable even
  // wenn ein vorgelagertes Sheet den Backdrop nicht abfängt.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !surfaceKind) return null

  const kindLabel = KIND_LABELS[surfaceKind]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-context-title"
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
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
        className="relative z-[1] w-full max-w-[480px] rounded-t-3xl px-5 pb-6 pt-5 text-white shadow-2xl sm:rounded-3xl sm:px-6"
        style={{
          background:
            'linear-gradient(180deg, rgba(20,28,48,0.92) 0%, rgba(15,21,37,0.96) 100%)',
          backdropFilter: 'blur(48px) saturate(220%)',
          WebkitBackdropFilter: 'blur(48px) saturate(220%)',
          border: '1px solid rgba(255,255,255,0.14)',
          paddingBottom:
            'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)',
        }}
      >
        {/* Drag-handle */}
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/24" aria-hidden />

        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h2
              id="customer-context-title"
              className="text-[18px] font-bold leading-tight"
            >
              {kindLabel} {surfaceLabel ? `· ${surfaceLabel}` : ''}
            </h2>
            <p className="mt-0.5 text-[12px] text-white/60">
              Was möchtest du hier markieren?
            </p>
          </div>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/8 text-white/75 transition active:scale-95 hover:bg-white/16"
          >
            <svg
              viewBox="0 0 24 24"
              width={14}
              height={14}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M6 6l12 12 M18 6l-12 12" />
            </svg>
          </button>
        </div>

        {/* Wall-Edit (nur bei kind=wall) — primary action above the grid */}
        {surfaceKind === 'wall' && onEditWall && (
          <button
            type="button"
            onClick={() => {
              onEditWall()
              onClose()
            }}
            className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-white/14 bg-white/[0.06] px-4 py-3 text-left transition active:scale-[0.98] hover:bg-white/[0.10]"
          >
            <span
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{
                background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
                boxShadow: '0 4px 10px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.22)',
              }}
              aria-hidden
            >
              <svg
                viewBox="0 0 24 24"
                width={18}
                height={18}
                fill="none"
                stroke="white"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 21V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v15 M3 11h18 M9 4v17 M15 4v17" />
              </svg>
            </span>
            <span className="flex-1">
              <span className="block text-[14px] font-bold leading-tight">
                Wand bearbeiten
              </span>
              <span className="block text-[11.5px] text-white/60">
                Länge · Dicke · Höhe anpassen
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              width={12}
              height={12}
              fill="none"
              stroke="rgba(255,255,255,0.45)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        )}

        {/* Wandmaterial wählen (nur bei kind=wall + Edit-Rechte) */}
        {surfaceKind === 'wall' && onPickFinish && (
          <button
            type="button"
            onClick={() => {
              onPickFinish()
              onClose()
            }}
            className="mt-2.5 flex w-full items-center gap-3 rounded-2xl border border-white/14 bg-white/[0.06] px-4 py-3 text-left transition active:scale-[0.98] hover:bg-white/[0.10]"
          >
            <span
              className="flex h-10 w-10 items-center justify-center rounded-xl"
              style={{
                background: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
                boxShadow: '0 4px 10px rgba(139,92,246,0.42), inset 0 1px 0 rgba(255,255,255,0.22)',
              }}
              aria-hidden
            >
              <svg
                viewBox="0 0 24 24"
                width={18}
                height={18}
                fill="none"
                stroke="white"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8z" />
                <circle cx="7.5" cy="10.5" r="1.2" fill="white" stroke="none" />
                <circle cx="12" cy="7.5" r="1.2" fill="white" stroke="none" />
                <circle cx="16.5" cy="10.5" r="1.2" fill="white" stroke="none" />
              </svg>
            </span>
            <span className="flex-1">
              <span className="block text-[14px] font-bold leading-tight">
                Wandmaterial wählen
              </span>
              <span className="block text-[11.5px] text-white/60">
                Farbe · Putz · Fliesen · Holz · Tapete
              </span>
            </span>
            <svg
              viewBox="0 0 24 24"
              width={12}
              height={12}
              fill="none"
              stroke="rgba(255,255,255,0.45)"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        )}

        {/* Pin-Type-Grid: 4 Aktionen, 2-column auf mobile, 4 auf sm+. */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CUSTOMER_PIN_TYPES.map(pinType => {
            const spec = getCustomerPinTypeSpec(pinType)
            return (
              <button
                key={pinType}
                type="button"
                onClick={() => {
                  onPickPinType(pinType)
                  onClose()
                }}
                aria-label={`${spec.label} markieren`}
                className="flex flex-col items-center gap-2 rounded-2xl border border-white/12 bg-white/[0.05] px-3 py-3 text-center transition active:scale-[0.96] hover:bg-white/[0.10]"
              >
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={{
                    background: spec.color,
                    boxShadow: `0 4px 10px ${spec.colorGlow}, inset 0 1px 0 rgba(255,255,255,0.22)`,
                  }}
                  aria-hidden
                >
                  <svg
                    viewBox="0 0 24 24"
                    width={18}
                    height={18}
                    fill="none"
                    stroke="white"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d={spec.iconPath} />
                  </svg>
                </span>
                <span className="text-[12px] font-semibold leading-tight">
                  {spec.label}
                </span>
              </button>
            )
          })}
        </div>

        {/* Deferred Actions: visually present so customers know what's coming
            in Phase 2, but disabled. Prevents the perception "the app does
            only pins" — sets the Material/Foto/Problem expectation early. */}
        <div className="mt-4 flex items-center gap-2 text-[11px] text-white/50">
          <svg
            viewBox="0 0 24 24"
            width={12}
            height={12}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4 M12 16h.01" />
          </svg>
          <span>
            Foto und Problem-Markierung — bald verfügbar
          </span>
        </div>
      </div>
    </div>
  )
}
