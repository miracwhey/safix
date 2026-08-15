/**
 * Spatial · V1.6.1 R11-C · CustomerWallEditSheet
 *
 * Bottom-Sheet zur Bearbeitung einer einzelnen Wand. Öffnet aus dem
 * Object-First Context-Sheet ("Wand bearbeiten") oder direkt aus der
 * Tool-Bar ("Wand"-Tool + Surface-Tap auf eine Wand).
 *
 * Editierbare Felder (V1.6.1 Scope, matched ResizeWallCommand-Contract):
 *   - **thickness_m** — Wand-Dicke (1-50 cm, Default aus wall.thickness_m
 *     oder 15 cm Fallback).
 *   - **height_m** — Wand-Höhe (1.5-4.0 m, Default aus wall.height_m oder
 *     2.5 m Fallback). Render-Engine validiert Out-of-Range silent → wir
 *     clampen schon im UI.
 *
 * Read-only:
 *   - **length_m** — wird aus start_point/end_point berechnet, nicht direkt
 *     editierbar. Zeigen wir nur als Info ("Länge: 3,20 m"). Eine echte
 *     Längen-Verstellung müsste einen Endpunkt verschieben — out-of-scope
 *     für V1.6 Customer (nur HW kann Wall-Punkte verschieben).
 *
 * Save (R11-C-Stub):
 *   Aktuell ist die Customer-Persistierung der Wand-Dimensionen NICHT voll
 *   verkabelt — die canonical Override-Pipeline gehört noch der HW-Variant-
 *   Editier-Welt. Diese Sheet fragt nur den neuen Werten ab und leitet sie
 *   an `onSave` weiter; der Caller (CustomerSpatialHubScreen) zeigt einen
 *   Toast "Speichern in Kürze verfügbar" bis Phase 1e den `updateCustomer
 *   WallDims()`-Workflow + RPC liefert. UI ist voll funktional, nur die
 *   Persistierung ist stub.
 *
 * Read-only-Banner (`canEdit=false`): Bei HW-geteilten Scans ohne Schreib-
 * recht zeigen wir das Sheet ohne Save-Button + Banner "Dieser Scan gehört
 * dem Handwerker — Bearbeitung nur lesend".
 */

import { useEffect, useState } from 'react'

import Spinner from '../../system/Spinner'

export interface CustomerWallEditSheetSaveInput {
  thicknessM: number
  heightM: number
}

export interface CustomerWallEditSheetProps {
  open: boolean
  /** Wall-id (z.B. "w_south") — Sub-Title-Label. */
  wallLabel?: string
  /** Aktueller Wert für length_m, read-only Anzeige. */
  currentLengthM?: number
  /** Aktueller Wert für thickness_m. Default: 0.15 */
  currentThicknessM?: number
  /** Aktueller Wert für height_m. Default: 2.5 */
  currentHeightM?: number
  /** `false` ⇒ Read-Only-Banner + kein Save-Button. */
  canEdit?: boolean
  saving?: boolean
  onSave: (input: CustomerWallEditSheetSaveInput) => void
  onCancel: () => void
}

const THICKNESS_MIN_CM = 1
const THICKNESS_MAX_CM = 50
const THICKNESS_STEP_CM = 1
const HEIGHT_MIN_CM = 150
const HEIGHT_MAX_CM = 400
const HEIGHT_STEP_CM = 5

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function formatLengthM(m: number): string {
  return `${m.toFixed(2).replace('.', ',')} m`
}

export default function CustomerWallEditSheet({
  open,
  wallLabel,
  currentLengthM,
  currentThicknessM = 0.15,
  currentHeightM = 2.5,
  canEdit = true,
  saving = false,
  onSave,
  onCancel,
}: CustomerWallEditSheetProps) {
  const [thicknessCm, setThicknessCm] = useState(() => Math.round(currentThicknessM * 100))
  const [heightCm, setHeightCm] = useState(() => Math.round(currentHeightM * 100))

  // Re-init beim Öffnen einer anderen Wand — der State darf nicht zwischen
  // verschiedenen Wand-Edits hängen bleiben. Pushed off the synchronous tick
  // (react-hooks/set-state-in-effect convention from CustomerPinDetailSheet).
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setThicknessCm(Math.round(currentThicknessM * 100))
      setHeightCm(Math.round(currentHeightM * 100))
    })
    return () => {
      alive = false
    }
  }, [open, currentThicknessM, currentHeightM])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const adjustThickness = (delta: number) =>
    setThicknessCm(prev => clamp(prev + delta, THICKNESS_MIN_CM, THICKNESS_MAX_CM))
  const adjustHeight = (delta: number) =>
    setHeightCm(prev => clamp(prev + delta, HEIGHT_MIN_CM, HEIGHT_MAX_CM))

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-wall-edit-title"
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
    >
      <button
        type="button"
        aria-label="Schließen"
        onClick={onCancel}
        className="absolute inset-0 bg-black/55"
        style={{ backdropFilter: 'blur(2px)' }}
      />

      <div
        className="relative z-[1] w-full max-w-[480px] rounded-t-3xl px-5 pb-6 pt-5 text-white shadow-2xl sm:rounded-3xl sm:px-6"
        style={{
          background:
            'linear-gradient(180deg, rgba(20,28,48,0.92) 0%, rgba(15,21,37,0.96) 100%)',
          backdropFilter: 'blur(48px) saturate(220%)',
          WebkitBackdropFilter: 'blur(48px) saturate(220%)',
          border: '1px solid rgba(255,255,255,0.14)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)',
        }}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/24" aria-hidden />

        <div className="flex items-start gap-3">
          <span
            className="flex h-11 w-11 items-center justify-center rounded-xl"
            style={{
              background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
              boxShadow: '0 6px 14px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.22)',
            }}
            aria-hidden
          >
            <svg
              viewBox="0 0 24 24"
              width={20}
              height={20}
              fill="none"
              stroke="white"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 21V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v15 M3 11h18 M9 4v17 M15 4v17" />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <h2
              id="customer-wall-edit-title"
              className="text-[18px] font-bold leading-tight"
            >
              Wand bearbeiten
            </h2>
            <p className="text-[12px] text-white/60">
              {wallLabel ? `Wand · ${wallLabel}` : 'Wand'}
              {currentLengthM != null && ` · Länge ${formatLengthM(currentLengthM)}`}
            </p>
          </div>
        </div>

        {!canEdit && (
          <div className="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/[0.08] p-3 text-[12px] text-amber-100/85">
            Dieser Scan gehört dem Handwerker — Bearbeitung nur lesend.
          </div>
        )}

        {/* Thickness Stepper */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between">
            <label htmlFor="wall-thickness" className="text-[12px] font-semibold text-white/75">
              Wand-Dicke
            </label>
            <span className="text-[11px] text-white/55">
              {THICKNESS_MIN_CM}–{THICKNESS_MAX_CM} cm
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => adjustThickness(-THICKNESS_STEP_CM)}
              disabled={!canEdit || thicknessCm <= THICKNESS_MIN_CM}
              className="h-11 w-11 rounded-xl border border-white/14 bg-white/[0.06] text-[18px] font-bold text-white transition active:scale-95 disabled:opacity-40"
              aria-label="Dicke verringern"
            >
              −
            </button>
            <div className="flex-1 rounded-xl border border-white/14 bg-white/[0.04] py-2.5 text-center">
              <span id="wall-thickness" className="text-[18px] font-bold tabular-nums text-white">
                {thicknessCm}
              </span>
              <span className="ml-1 text-[12px] text-white/55">cm</span>
            </div>
            <button
              type="button"
              onClick={() => adjustThickness(THICKNESS_STEP_CM)}
              disabled={!canEdit || thicknessCm >= THICKNESS_MAX_CM}
              className="h-11 w-11 rounded-xl border border-white/14 bg-white/[0.06] text-[18px] font-bold text-white transition active:scale-95 disabled:opacity-40"
              aria-label="Dicke erhöhen"
            >
              +
            </button>
          </div>
        </div>

        {/* Height Stepper */}
        <div className="mt-4">
          <div className="flex items-baseline justify-between">
            <label htmlFor="wall-height" className="text-[12px] font-semibold text-white/75">
              Wand-Höhe
            </label>
            <span className="text-[11px] text-white/55">
              {(HEIGHT_MIN_CM / 100).toFixed(1).replace('.', ',')}–
              {(HEIGHT_MAX_CM / 100).toFixed(1).replace('.', ',')} m
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => adjustHeight(-HEIGHT_STEP_CM)}
              disabled={!canEdit || heightCm <= HEIGHT_MIN_CM}
              className="h-11 w-11 rounded-xl border border-white/14 bg-white/[0.06] text-[18px] font-bold text-white transition active:scale-95 disabled:opacity-40"
              aria-label="Höhe verringern"
            >
              −
            </button>
            <div className="flex-1 rounded-xl border border-white/14 bg-white/[0.04] py-2.5 text-center">
              <span id="wall-height" className="text-[18px] font-bold tabular-nums text-white">
                {(heightCm / 100).toFixed(2).replace('.', ',')}
              </span>
              <span className="ml-1 text-[12px] text-white/55">m</span>
            </div>
            <button
              type="button"
              onClick={() => adjustHeight(HEIGHT_STEP_CM)}
              disabled={!canEdit || heightCm >= HEIGHT_MAX_CM}
              className="h-11 w-11 rounded-xl border border-white/14 bg-white/[0.06] text-[18px] font-bold text-white transition active:scale-95 disabled:opacity-40"
              aria-label="Höhe erhöhen"
            >
              +
            </button>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-2xl border border-white/16 bg-white/[0.04] px-4 py-3 text-[14px] font-semibold text-white/85 transition active:scale-[0.98]"
          >
            Abbrechen
          </button>
          {canEdit && (
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                onSave({
                  thicknessM: thicknessCm / 100,
                  heightM: heightCm / 100,
                })
              }
              className={
                'flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-bold text-white transition active:scale-[0.98] ' +
                (saving ? 'cursor-not-allowed opacity-70' : '')
              }
              style={{
                background: 'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
                boxShadow: '0 8px 18px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.22)',
              }}
              aria-busy={saving || undefined}
            >
              {saving && <Spinner size="sm" tone="onDark" inButton />}
              {saving ? 'Speichere…' : 'Speichern'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
