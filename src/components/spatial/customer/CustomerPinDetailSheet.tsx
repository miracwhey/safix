/**
 * Spatial · V1.6 Phase 1d · CustomerPinDetailSheet
 *
 * Bottom-sheet that confirms a freshly-placed customer pin. Opens from the
 * hub when the customer:
 *
 *   1. Picks a tool in `<CustomerSpatialToolBar>` (door/window/heating/
 *      electrical), and
 *   2. Taps a surface in the live `<SpatialViewer>` (Phase 1d edit-mode
 *      flows the UV anchor + worldXyz here via `onPinPlaced`).
 *
 * The sheet:
 *   - Renders the type icon + label so the customer sees what they're
 *     about to save (cancels miss-taps before persistence).
 *   - Displays the default dimensions from
 *     `pinTypeSystem.getCustomerPinTypeSpec(type).defaultDims`. Dimension
 *     editing lands in a follow-up — Phase 1d MVP confirms type + adds an
 *     optional note (the dim defaults are the right value for >90% of
 *     customer pins per Master-Plan §3 default-Maße locks).
 *   - Save → fires `onSave({ note, customerPinType })`. The host wires
 *     this into `spatialRepository.createScanAnnotation` with the surface
 *     anchor it captured from the viewer.
 *
 * Discipline:
 *   - kind defaults to 'note' (HW-RBAC kind). The `customerPinType` carries
 *     the structural meaning — both can be set on the same row.
 *   - `customerVisible` defaults to `true` for customer-typed pins (HW
 *     should see what their customer flagged on a self-scan; on HW-shared
 *     scans the same pin remains customer-only via the existing RLS
 *     filter on `customer_visible`).
 *
 * A11y: `role="dialog"` + focus trap on the textarea on first paint +
 * Escape closes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import Spinner from '../../system/Spinner'
import {
  getCustomerPinTypeSpec,
  type CustomerPinTypeSpec,
} from '../../../lib/spatial/canonical/pins/pinTypeSystem'
import type { CustomerPinType } from '../../../lib/spatial/types'

export interface CustomerPinDetailSheetSaveInput {
  customerPinType: CustomerPinType
  note: string | null
  /** R11-E: optional File aus Foto-Picker, wird nach Pin-Insert via
   *  `attachPinPhoto` ans annotation gehängt. Null = kein Foto angehängt. */
  photo: File | null
}

export interface CustomerPinDetailSheetProps {
  open: boolean
  /** The pin type the user picked via the toolbar. Drives all visual + dim
   *  defaults — required for an open sheet. */
  pinType: CustomerPinType | null
  onSave: (input: CustomerPinDetailSheetSaveInput) => void
  onCancel: () => void
  /** When `true`, the save button is disabled + shows a busy state so the
   *  customer sees the async write-through to Supabase land. Cancel stays
   *  active so a slow network doesn't trap the sheet open. */
  saving?: boolean
}

function formatCm(m: number): string {
  return `${Math.round(m * 100)} cm`
}

function defaultDimsLabel(spec: CustomerPinTypeSpec): string {
  const { widthM, heightM, depthM } = spec.defaultDims
  const wxh = `${formatCm(widthM)} × ${formatCm(heightM)}`
  return depthM != null ? `${wxh} × ${formatCm(depthM)}` : wxh
}

export default function CustomerPinDetailSheet({
  open,
  pinType,
  onSave,
  onCancel,
  saving = false,
}: CustomerPinDetailSheetProps) {
  const [note, setNote] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  // R11-E: für Photo-Preview erzeugen wir einen ObjectURL — der wird beim
  // Pin-Reset / Sheet-Close gerevoked damit kein Memory-Leak im
  // WebView entsteht.
  const photoPreviewUrl = useMemo(
    () => (photo ? URL.createObjectURL(photo) : null),
    [photo],
  )
  useEffect(() => {
    if (!photoPreviewUrl) return
    return () => URL.revokeObjectURL(photoPreviewUrl)
  }, [photoPreviewUrl])

  // Reset the draft note + photo whenever the sheet opens — a fresh pin
  // should never inherit the previous customer note / attach. Pushed off
  // the synchronous tick (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return
    let alive = true
    void Promise.resolve().then(() => {
      if (!alive) return
      setNote('')
      setPhoto(null)
      textareaRef.current?.focus()
    })
    return () => {
      alive = false
    }
  }, [open])

  // Escape closes from anywhere inside the sheet without competing focus traps.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open || !pinType) return null
  const spec = getCustomerPinTypeSpec(pinType)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-pin-detail-title"
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Schließen"
        onClick={onCancel}
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
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 items-center justify-center rounded-xl"
            style={{
              background: spec.color,
              boxShadow: `0 6px 14px ${spec.colorGlow}, inset 0 1px 0 rgba(255,255,255,0.22)`,
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
              <path d={spec.iconPath} />
            </svg>
          </span>
          <div className="flex-1 min-w-0">
            <h2
              id="customer-pin-detail-title"
              className="text-[19px] font-bold leading-tight"
            >
              {spec.label} markieren
            </h2>
            <p className="text-[12px] text-white/60">
              Standardmaß: {defaultDimsLabel(spec)}
            </p>
          </div>
        </div>

        {/* Optional note */}
        <label
          htmlFor="customer-pin-note"
          className="mt-5 block text-[12px] font-semibold text-white/75"
        >
          Notiz (optional)
        </label>
        <textarea
          ref={textareaRef}
          id="customer-pin-note"
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={3}
          placeholder="z.B. Schwellenwert kontrollieren, Heizkörper schief …"
          className="mt-1.5 w-full resize-none rounded-xl border border-white/14 bg-white/[0.06] px-3 py-2.5 text-[14px] leading-snug text-white placeholder:text-white/40 focus:border-blue-400 focus:outline-none"
        />

        {/* R11-E: Foto-Picker (optional). File-input mit accept=image/*
            triggert iOS Native Picker (Kamera ODER Galerie). Capacitor-Camera
            wäre Plugin-Pfad — file-input ist fenster-portable und reicht für
            V1.6 (Customer-Pin-Foto ist Polish, kein Hot-Path-Capture). */}
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) setPhoto(file)
            // Allow Re-Pick mit gleicher Datei: clear input value.
            e.target.value = ''
          }}
        />
        <div className="mt-4">
          {photo && photoPreviewUrl ? (
            <div className="flex items-center gap-3 rounded-xl border border-white/12 bg-white/[0.05] p-2">
              <img
                src={photoPreviewUrl}
                alt="Foto-Vorschau"
                className="h-14 w-14 rounded-lg object-cover"
              />
              <div className="flex-1 min-w-0">
                <p className="truncate text-[12px] font-semibold text-white/85">
                  {photo.name}
                </p>
                <p className="text-[10.5px] text-white/55">
                  {(photo.size / 1024).toFixed(0)} KB
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPhoto(null)}
                className="rounded-full px-2 py-1 text-[11px] font-bold text-white/70 transition hover:text-white"
                aria-label="Foto entfernen"
              >
                Entfernen
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.05] py-2.5 text-[12.5px] font-semibold text-white/80 transition active:scale-[0.98] hover:bg-white/[0.10]"
            >
              <svg
                viewBox="0 0 24 24"
                width={15}
                height={15}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              Foto hinzufügen
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-2xl border border-white/16 bg-white/[0.04] px-4 py-3 text-[14px] font-semibold text-white/85 transition active:scale-[0.98]"
          >
            Abbrechen
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              onSave({
                customerPinType: spec.key,
                note: note.trim() ? note.trim() : null,
                photo,
              })
            }
            className={
              'flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-[14px] font-bold text-white transition active:scale-[0.98] ' +
              (saving ? 'cursor-not-allowed opacity-70' : '')
            }
            style={{
              background:
                'linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%)',
              boxShadow:
                '0 8px 18px rgba(37,99,235,0.42), inset 0 1px 0 rgba(255,255,255,0.22)',
            }}
            aria-busy={saving || undefined}
          >
            {saving && <Spinner size="sm" tone="onDark" inButton />}
            {saving ? 'Speichere…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  )
}
