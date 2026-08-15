/**
 * Spatial · Verify · Stage 4 — Wunsch-Pins (Phase 3 · Block 3.6)
 *
 * The Customer-Verify Stage-4 renovation-wish pins (Mockup 15 · Phone 4). The
 * customer taps a surface in the 3D preview, picks one of the 4 pin kinds
 * (`damage` / `wish` / `note` / `photo` · Implementation-Spec §Stage-4),
 * captures detail (title / severity / note / photo), and drops a 3D-native
 * pin. No pin limit (Edge-Case §9 — power-user 50 pins OK).
 *
 * ── 3D-native anchor (binding · Block 3.7) ──────────────────────────────────
 * A dropped pin is anchored at creation via `anchor_surface_id` +
 * `anchor_uv` — never a UI chip. The tapped surface's world-hit point is
 * projected onto the host surface's canonical UV by `resolvePinAnchor`; the
 * PinAdapter / PinSet billboard then renders it at the resolved world
 * position and keeps it on the surface under any camera move.
 *
 * ── Photo pin (binding) ─────────────────────────────────────────────────────
 * A `photo` pin attaches an image via the existing SaFix media pipeline
 * (`useMediaPicker` → `uploadMediaFile`) — no bespoke uploader. The persisted
 * media id is stored in the pin's `linked_photo_ids`.
 *
 * Pure presentation + local view-state. Pin creation / move is delegated to
 * the `on*` callbacks (the VerifySheet wires them to `useVerifyFlow`); this
 * component constructs NO command and makes NO DB call directly.
 */

import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react'

import { CanonicalSceneRoot } from '../three/canonical/CanonicalSceneRoot'
import { SurfaceTapLayer } from '../three/canonical/SurfaceTapLayer'
import type { TappedSurface } from '../three/canonical/surfaceTap'
import { VerifyPinPicker, type VerifyPinKind } from './VerifyPinPicker'
import type { VerifyMeasureCorrectionOutcome } from './VerifyStageMeasure'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import type { Pin } from '../../../lib/spatial/canonical/types/annotations'
import type { NodeOverride, Variant, VariantId } from '../../../lib/spatial/canonical/types/variants'
import {
  resolvePinAnchor,
  type ResolvedPinAnchor,
} from '../../../lib/spatial/workflow/pinAnchorProjection'
import type {
  PinDropTarget,
  VerifyPinDetail,
} from '../../../lib/spatial/workflow/spatialVerifyWorkflow'
import { uploadMediaFile } from '../../../lib/media/mediaUploadService'
import { useMediaPicker } from '../../../lib/native/useMediaPicker'
import { useHaptics } from '../../../hooks/useHaptics'

/** A severity option for a `damage` pin. */
const SEVERITY_OPTIONS: ReadonlyArray<{ value: Pin['severity']; label: string }> = [
  { value: 'low', label: 'leicht' },
  { value: 'medium', label: 'mittel' },
  { value: 'high', label: 'stark' },
]

const PIN_KIND_LABEL: Record<VerifyPinKind, string> = {
  damage: 'Schaden',
  wish: 'Wunsch',
  note: 'Notiz',
  photo: 'Foto',
}

export interface VerifyStagePinsProps {
  /** The resolved scene (with `customer_corrections` overrides applied). */
  scene: RoomScene
  /** Override stack — passed to the canonical renderer. */
  overrides: NodeOverride[]
  /** Variant chain — passed to the canonical renderer. */
  variants: Variant[]
  /** The variant the preview renders on (the writable customer layer). */
  activeVariantId: VariantId | null
  /**
   * SaFix project id — the media-upload entity for a `photo` pin's image.
   * `null` disables the photo attach (the `photo` pin still works as a marker).
   */
  projectId?: string | null
  /** auth.users.id — the media-upload owner. */
  ownerUserId?: string | null
  /** Whether there is a verify edit to undo (drives the Undo button). */
  canUndo: boolean
  /** Drop a new pin (3D-native anchored). */
  onAddPin: (drop: PinDropTarget, detail: VerifyPinDetail) => Promise<VerifyMeasureCorrectionOutcome>
  /** Re-anchor an existing pin onto a (possibly different) surface. */
  onMovePin: (pinId: string, drop: PinDropTarget) => Promise<VerifyMeasureCorrectionOutcome>
  /** Undo the most recent verify edit. */
  onUndo: () => void
}

/** The pin-detail draft being captured before the drop is committed. */
interface PinDraft {
  /** Where the customer tapped — the resolved 3D-native anchor. */
  anchor: ResolvedPinAnchor
  /** The raw tapped-surface kind — carried so the drop payload stays typed. */
  surfaceKind: TappedSurface['kind']
}

export function VerifyStagePins({
  scene,
  overrides,
  variants,
  activeVariantId,
  projectId = null,
  ownerUserId = null,
  canUndo,
  onAddPin,
  onMovePin,
  onUndo,
}: VerifyStagePinsProps): ReactElement {
  const haptics = useHaptics()
  const { pickMedia, inputProps } = useMediaPicker()

  // The armed pin kind — the next dropped pin uses this type.
  const [pinKind, setPinKind] = useState<VerifyPinKind>('damage')
  // The in-progress drop draft — set on a surface tap, cleared on save/cancel.
  const [draft, setDraft] = useState<PinDraft | null>(null)
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState<Pin['severity']>('medium')
  const [note, setNote] = useState('')
  const [photoIds, setPhotoIds] = useState<string[]>([])
  const [photoBusy, setPhotoBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  // When set, the NEXT surface tap re-anchors this pin (`MovePinCommand`)
  // instead of opening a fresh drop draft (Implementation-Spec §Stage-4
  // "Pin-Edit/-Move via MovePinCommand").
  const [reanchorPinId, setReanchorPinId] = useState<string | null>(null)
  // Guards a re-entrant tap while a drop / move is being saved.
  const savingRef = useRef(false)

  /** The pins already on the scene — listed for review + re-anchor. */
  const placedPins = useMemo(
    () => scene.pins.filter((p) => p.variant_id !== 'base_roomplan'),
    [scene.pins],
  )

  const resetDraft = useCallback(() => {
    setDraft(null)
    setTitle('')
    setSeverity('medium')
    setNote('')
    setPhotoIds([])
    setPhotoBusy(false)
  }, [])

  // 3D tap → either re-anchor an armed pin (`MovePinCommand`) or open a fresh
  // pin-drop draft. Re-anchor takes priority so a pin selected for move is not
  // shadowed by a new draft.
  const handleTap = useCallback(
    (tapped: TappedSurface) => {
      if (savingRef.current) return
      const anchor = resolvePinAnchor(scene, tapped.kind, tapped.nodeId, tapped.point)
      if (!anchor) {
        setFeedback({ ok: false, text: 'Diese Fläche kann nicht markiert werden.' })
        return
      }
      // Medium-impact haptic on pin-drop (Implementation-Spec §UX-Microdetails).
      haptics.medium()
      setFeedback(null)

      if (reanchorPinId) {
        const pinId = reanchorPinId
        savingRef.current = true
        setBusy(true)
        void onMovePin(pinId, {
          surfaceId: anchor.surfaceId,
          surfaceType: anchor.surfaceType,
          uv: anchor.uv,
        })
          .then((outcome) => {
            setFeedback({
              ok: outcome.ok,
              text: outcome.ok
                ? outcome.messages[0] ?? 'Markierung verschoben.'
                : outcome.messages[0] ?? 'Verschieben nicht möglich.',
            })
            if (outcome.ok) setReanchorPinId(null)
          })
          .finally(() => {
            setBusy(false)
            savingRef.current = false
          })
        return
      }

      setDraft({ anchor, surfaceKind: tapped.kind })
    },
    [scene, haptics, reanchorPinId, onMovePin],
  )

  const handlePickPhoto = useCallback(async () => {
    if (photoBusy || !projectId || !ownerUserId) return
    setPhotoBusy(true)
    try {
      const file = await pickMedia({ kind: 'image' })
      if (!file) return
      const record = await uploadMediaFile({
        file,
        entityType: 'project',
        entityId: projectId,
        ownerUserId,
        mediaRole: 'spatial_pin_photo',
      })
      setPhotoIds((prev) => [...prev, record.id])
      setFeedback({ ok: true, text: 'Foto angehängt.' })
    } catch {
      setFeedback({ ok: false, text: 'Foto konnte nicht hochgeladen werden.' })
    } finally {
      setPhotoBusy(false)
    }
  }, [photoBusy, projectId, ownerUserId, pickMedia])

  const handleSavePin = useCallback(async () => {
    if (!draft || busy) return
    savingRef.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const detail: VerifyPinDetail = {
        pinType: pinKind,
        title: title.trim() || undefined,
        // Severity is only meaningful for a damage pin (Implementation-Spec).
        severity: pinKind === 'damage' ? severity : undefined,
        note: note.trim() || undefined,
        photoIds: photoIds.length > 0 ? photoIds : undefined,
      }
      const drop: PinDropTarget = {
        surfaceId: draft.anchor.surfaceId,
        surfaceType: draft.anchor.surfaceType,
        uv: draft.anchor.uv,
      }
      const outcome = await onAddPin(drop, detail)
      setFeedback({
        ok: outcome.ok,
        text: outcome.ok
          ? outcome.messages[0] ?? 'Markierung gesetzt.'
          : outcome.messages[0] ?? 'Markierung nicht möglich.',
      })
      if (outcome.ok) resetDraft()
    } finally {
      setBusy(false)
      savingRef.current = false
    }
  }, [draft, busy, pinKind, title, severity, note, photoIds, onAddPin, resetDraft])

  return (
    <div data-testid="verify-stage-pins">
      {/* Hidden media-picker input — web + mixed-path fallback. */}
      <input {...inputProps} />

      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em] text-slate-900">
            Was soll passieren?
          </h2>
          <p className="mb-4 mt-1.5 text-[14px] leading-snug text-slate-500">
            Tipp auf eine Stelle im 3D-Modell. Wo ist was kaputt, was soll neu?
          </p>
        </div>
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          data-testid="verify-pins-undo"
          aria-label="Letzte Änderung rückgängig"
          className="mt-0.5 shrink-0 rounded-full bg-slate-900/[0.05] px-3 py-1.5 text-[12px] font-semibold text-slate-600 transition active:scale-95 disabled:opacity-35"
        >
          ↺ Rückgängig
        </button>
      </div>

      <div className="mb-3 overflow-hidden rounded-[18px] bg-slate-900 shadow-[0_8px_24px_rgba(10,15,28,0.15)]">
        <CanonicalSceneRoot
          scene={scene}
          overrides={overrides}
          variants={variants}
          activeVariantId={activeVariantId}
          className="aspect-[4/3] w-full"
        >
          <SurfaceTapLayer enabled onTap={handleTap} />
        </CanonicalSceneRoot>
      </div>

      <VerifyPinPicker selected={pinKind} onSelect={setPinKind} />

      {/* Pin-detail capture — appears once a surface is tapped. */}
      {draft ? (
        <div
          className="mb-3 rounded-[14px] border border-slate-900/[0.08] bg-white p-3.5"
          data-testid="verify-pin-detail"
        >
          <p className="mb-2 text-[13px] font-bold text-slate-900">
            {PIN_KIND_LABEL[pinKind]} markieren
          </p>

          <label
            htmlFor="verify-pin-title"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-[1px] text-slate-400"
          >
            Titel
          </label>
          <input
            id="verify-pin-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={pinKind === 'damage' ? 'z.B. Schimmel an der Decke' : 'Kurzer Titel'}
            data-testid="verify-pin-title"
            className="mb-2.5 w-full rounded-[10px] border border-slate-900/10 bg-slate-900/[0.02] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-orange-400"
          />

          {pinKind === 'damage' && (
            <>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-[1px] text-slate-400">
                Schwere
              </p>
              <div className="mb-2.5 flex gap-1.5" role="radiogroup" aria-label="Schwere">
                {SEVERITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={severity === opt.value}
                    onClick={() => setSeverity(opt.value)}
                    data-testid={`verify-pin-severity-${opt.value}`}
                    className={[
                      'flex-1 rounded-[10px] px-2 py-2 text-[12px] font-bold transition',
                      severity === opt.value
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-900/[0.05] text-slate-600',
                    ].join(' ')}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </>
          )}

          <label
            htmlFor="verify-pin-note"
            className="mb-1 block text-[11px] font-semibold uppercase tracking-[1px] text-slate-400"
          >
            Notiz (optional)
          </label>
          <textarea
            id="verify-pin-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            data-testid="verify-pin-note"
            className="mb-2.5 w-full resize-none rounded-[10px] border border-slate-900/10 bg-slate-900/[0.02] px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-orange-400"
          />

          {/* Photo attach — the `photo` pin shows it primarily; the others
              keep it as an optional add. Disabled without a project entity. */}
          <button
            type="button"
            onClick={() => void handlePickPhoto()}
            disabled={photoBusy || !projectId || !ownerUserId}
            data-testid="verify-pin-add-photo"
            className="mb-2.5 flex w-full items-center justify-center gap-2 rounded-[10px] bg-slate-900/[0.05] px-3 py-2 text-[12px] font-bold text-slate-700 transition active:scale-[0.98] disabled:opacity-40"
          >
            {photoBusy
              ? 'Foto wird hochgeladen …'
              : photoIds.length > 0
                ? `${photoIds.length} Foto(s) angehängt · weiteres`
                : '+ Foto anhängen'}
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={resetDraft}
              disabled={busy}
              data-testid="verify-pin-cancel"
              className="flex-1 rounded-[10px] bg-slate-900/[0.05] px-3 py-2.5 text-[13px] font-bold text-slate-600 transition active:scale-[0.98] disabled:opacity-40"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={() => void handleSavePin()}
              disabled={busy || photoBusy}
              data-testid="verify-pin-save"
              className="flex-[2] rounded-[10px] bg-slate-900 px-3 py-2.5 text-[13px] font-bold text-white transition active:scale-[0.98] disabled:opacity-40"
            >
              {busy ? 'Wird gespeichert …' : 'Pin speichern'}
            </button>
          </div>
        </div>
      ) : (
        <p className="mb-3 rounded-xl bg-slate-900/[0.03] px-3 py-3 text-center text-[12px] text-slate-500">
          Tipp auf eine Wand, den Boden oder ein Objekt, um eine Markierung zu
          setzen. Kein Limit — markiere alles, was wichtig ist.
        </p>
      )}

      {/* Placed-pins review list. */}
      {placedPins.length > 0 && (
        <>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[1px] text-slate-400">
            {placedPins.length === 1 ? '1 Markierung' : `${placedPins.length} Markierungen`}
          </p>
          <ul className="space-y-1.5" data-testid="verify-pins-list">
            {placedPins.map((pin) => {
              const armed = reanchorPinId === pin.id
              return (
                <li key={pin.id}>
                  <button
                    type="button"
                    onClick={() =>
                      setReanchorPinId((cur) => (cur === pin.id ? null : pin.id))
                    }
                    aria-pressed={armed}
                    disabled={busy}
                    data-testid={`verify-pin-row-${pin.id}`}
                    className={[
                      'flex w-full items-center justify-between rounded-[10px] px-3 py-2.5 text-left text-[13px] transition active:scale-[0.99] disabled:opacity-50',
                      armed ? 'bg-orange-500/15 ring-1 ring-orange-400' : 'bg-slate-900/[0.03]',
                    ].join(' ')}
                  >
                    <span className="font-semibold text-slate-900">
                      {pin.title?.trim() ||
                        PIN_KIND_LABEL[pin.pin_type as VerifyPinKind] ||
                        'Markierung'}
                    </span>
                    <span className="text-[11px] uppercase tracking-[0.5px] text-slate-400">
                      {armed
                        ? 'Tippe auf neue Stelle'
                        : PIN_KIND_LABEL[pin.pin_type as VerifyPinKind] ?? pin.pin_type}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {feedback && (
        <p
          role="status"
          data-testid="verify-pins-feedback"
          className={[
            'mt-2 rounded-lg px-3 py-2 text-center text-[12px] font-medium',
            feedback.ok
              ? 'bg-teal-700/10 text-teal-800'
              : 'bg-rose-500/10 text-rose-800',
          ].join(' ')}
        >
          {feedback.text}
        </p>
      )}
    </div>
  )
}
