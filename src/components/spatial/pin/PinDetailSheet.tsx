/**
 * Spatial Core · Block F.1 · Pin-Detail BottomSheet
 *
 * Single timeline sheet — Photo, Voice, Note interleaved chronologically
 * (Slack/Linear pattern, NOT separate tabs). Drives the full Pin-Editor
 * for both `create` (after a fresh placement) and `edit` (tap on an
 * existing pin) modes.
 *
 * The sheet is layer-pure: it dispatches into `pinWorkflow` helpers but
 * never composes its own repository calls. Errors surface as toasts,
 * never as raw exceptions; offline-queued uploads display a discreet
 * "Foto offline gespeichert" hint.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import BottomSheet from '../../ui/BottomSheet'
import { useMediaPicker } from '../../../lib/native/useMediaPicker'
import { resolveScanAssetUrl } from '../../../hooks/useScanAssetUrl'
import { useToast } from '../../../hooks/useToast'
import { useHaptics } from '../../../hooks/useHaptics'
import { VoiceMemoInlinePlayer } from './VoiceMemoInlinePlayer'
import { VoiceRecorderButton } from './VoiceRecorderButton'
import { PinConfidenceBadge } from './PinConfidenceBadge'
import {
  annotateNoteWithVoice,
  attachPinPhoto,
  attachPinVoiceMemo,
  createPinFromPlacement,
  extractVoiceMemoFromNote,
  noteDisplayPortion,
  setPinCustomerVisible,
  updatePinNote,
} from '../../../lib/spatial/workflow/pinWorkflow'
import type {
  AnchorUv,
  ScanAnnotation,
  ScanAnnotationKind,
} from '../../../lib/spatial/types'
import { defaultCustomerVisibleForKind } from '../../../lib/spatial/types'

export interface PinDetailSheetProps {
  open: boolean
  onClose: () => void
  /** When set, the sheet renders in `edit` mode for the given annotation. */
  annotation: ScanAnnotation | null
  /** Required for `create` mode — the placement payload from the viewer. */
  placement?: {
    scanId: string
    anchorUv: AnchorUv | null
    worldXyz?: { x: number; y: number; z: number } | null
    anchor2d?: { svgX: number; svgY: number } | null
  } | null
  userId: string
  scanId: string
  /** Re-fetch the parent's annotation list after a write lands. */
  onChanged?: () => void
}

const KIND_OPTIONS: { value: ScanAnnotationKind; copy: string }[] = [
  { value: 'damage', copy: 'Schaden' },
  { value: 'note', copy: 'Notiz' },
  { value: 'photo', copy: 'Foto' },
  { value: 'measurement_ref', copy: 'Maßverweis' },
  { value: 'gewerk_marker', copy: 'Gewerk' },
]

export function PinDetailSheet(props: PinDetailSheetProps) {
  const toast = useToast()
  const haptics = useHaptics()
  const picker = useMediaPicker()

  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [draftNote, setDraftNote] = useState(noteDisplayPortion(props.annotation?.note ?? null))
  const [draftKind, setDraftKind] = useState<ScanAnnotationKind>(
    props.annotation?.kind ?? 'damage',
  )
  const [draftGewerk, setDraftGewerk] = useState(props.annotation?.gewerk ?? '')
  const [draftCustomerVisible, setDraftCustomerVisible] = useState<boolean>(
    props.annotation?.customerVisible ?? defaultCustomerVisibleForKind(props.annotation?.kind ?? 'damage'),
  )
  const [recentAnnotation, setRecentAnnotation] = useState<ScanAnnotation | null>(
    props.annotation,
  )
  const [photoSignedUrl, setPhotoSignedUrl] = useState<string | null>(null)

  const activeAnnotation = recentAnnotation ?? props.annotation
  const voiceMemo = useMemo(
    () => extractVoiceMemoFromNote(activeAnnotation?.note ?? null),
    [activeAnnotation],
  )

  const safeAct = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      // Synchronous ref-based lock — React-19 concurrent renders batch
      // setState calls so a useState `busy` flag can be flipped past by
      // a double-click within one frame; a ref commit is immediate.
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      try {
        await fn()
        haptics.success()
      } catch (err) {
        haptics.error()
        toast.error(`${label}: ${err instanceof Error ? err.message : 'unbekannter Fehler'}`)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [haptics, toast],
  )

  const onCreate = useCallback(() => {
    if (!props.placement) return
    void safeAct('Pin speichern fehlgeschlagen', async () => {
      const created = await createPinFromPlacement({
        scanId: props.placement!.scanId,
        userId: props.userId,
        kind: draftKind,
        anchorUv: props.placement!.anchorUv,
        worldXyz: props.placement!.worldXyz ?? null,
        anchor2d: props.placement!.anchor2d ?? null,
        note: draftNote.trim() || null,
        gewerk: draftGewerk.trim() || null,
        customerVisible: draftCustomerVisible,
      })
      setRecentAnnotation(created)
      props.onChanged?.()
      toast.success('Pin gespeichert.')
    })
  }, [props, draftKind, draftNote, draftGewerk, draftCustomerVisible, safeAct, toast])

  const onToggleVisibility = useCallback(
    (next: boolean) => {
      setDraftCustomerVisible(next)
      if (!activeAnnotation) return
      void safeAct('Sichtbarkeit ändern fehlgeschlagen', async () => {
        const updated = await setPinCustomerVisible({
          scanId: props.scanId,
          annotationId: activeAnnotation.id,
          customerVisible: next,
        })
        setRecentAnnotation(updated)
        props.onChanged?.()
        toast.success(next ? 'Pin ist jetzt für die Kundin sichtbar.' : 'Pin ist jetzt privat.')
      })
    },
    [activeAnnotation, props, safeAct, toast],
  )

  const onSaveEdit = useCallback(() => {
    if (!activeAnnotation) return
    void safeAct('Pin aktualisieren fehlgeschlagen', async () => {
      // Preserve any existing voice-marker prefix so editing the display
      // note does not silently destroy the attached audio reference.
      const trimmed = draftNote.trim()
      const finalNote = voiceMemo
        ? annotateNoteWithVoice(voiceMemo.storagePath, voiceMemo.durationMs, trimmed || null)
        : (trimmed || null)
      await updatePinNote({
        scanId: props.scanId,
        annotationId: activeAnnotation.id,
        note: finalNote,
        gewerk: draftGewerk.trim() || null,
      })
      props.onChanged?.()
      toast.success('Pin aktualisiert.')
    })
  }, [activeAnnotation, draftNote, draftGewerk, voiceMemo, props, safeAct, toast])

  const onPickPhoto = useCallback(async () => {
    const annotation = activeAnnotation
    if (!annotation) {
      toast.info('Speichere den Pin zuerst, bevor Du ein Foto hängst.')
      return
    }
    void safeAct('Foto hinzufügen fehlgeschlagen', async () => {
      const file = await picker.pickMedia({ kind: 'image', source: 'prompt' })
      if (!file) return
      const result = await attachPinPhoto({
        scanId: props.scanId,
        annotationId: annotation.id,
        userId: props.userId,
        file,
      })
      setRecentAnnotation(result.annotation)
      props.onChanged?.()
      toast.success('Foto hochgeladen.')
      if (result.annotation.photoAssetId) {
        // Pre-fetch the signed URL so the timeline doesn't show a stub.
        // Cache lookup hits the same `useScanAssetUrl` Map next render.
        void resolveScanAssetUrl(result.annotation.photoAssetId)
          .then(setPhotoSignedUrl)
          .catch(() => {})
      }
    })
  }, [activeAnnotation, picker, props, safeAct, toast])

  const onRecorded = useCallback(
    (file: File, durationMs: number) => {
      const annotation = activeAnnotation
      if (!annotation) {
        toast.info('Speichere den Pin zuerst, bevor Du eine Sprachnotiz aufnimmst.')
        return
      }
      void safeAct('Sprachnotiz speichern fehlgeschlagen', async () => {
        const result = await attachPinVoiceMemo({
          scanId: props.scanId,
          annotationId: annotation.id,
          userId: props.userId,
          file,
          durationMs,
        })
        setRecentAnnotation(result.annotation)
        props.onChanged?.()
        toast.success('Sprachnotiz gespeichert.')
      })
    },
    [activeAnnotation, props, safeAct, toast],
  )

  // Stable id for the voice recorder hook — re-used across rerenders.
  const clientMessageIdRef = useRef<string>('')
  if (!clientMessageIdRef.current) {
    clientMessageIdRef.current = 'pin_voice_' + Math.random().toString(36).slice(2, 12)
  }

  const isCreateMode = !activeAnnotation

  return (
    <BottomSheet
      open={props.open}
      onClose={props.onClose}
      title={isCreateMode ? 'Pin setzen' : 'Pin-Details'}
      description={
        isCreateMode
          ? 'Beschreibe, was an dieser Stelle markiert werden soll.'
          : 'Foto, Sprachnotiz oder Hinweis ergänzen.'
      }
    >
      <div className="space-y-4 px-4 pb-4">
        {!isCreateMode && activeAnnotation ? (
          <div className="flex items-center gap-2">
            <PinConfidenceBadge confidence={activeAnnotation.confidence} compact />
            <span className="text-[11px] text-neutral-500">
              Status: {activeAnnotation.status}
            </span>
          </div>
        ) : null}

        <label className="block text-xs font-medium text-neutral-700">
          Pin-Typ
          <select
            value={draftKind}
            onChange={e => setDraftKind(e.target.value as ScanAnnotationKind)}
            disabled={!isCreateMode}
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          >
            {KIND_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.copy}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs font-medium text-neutral-700">
          Beschreibung
          <textarea
            rows={3}
            value={draftNote}
            onChange={e => setDraftNote(e.target.value)}
            placeholder="z.B. Wasserschaden Wand 2, oben rechts"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm"
          />
        </label>

        <label className="block text-xs font-medium text-neutral-700">
          Gewerk (optional)
          <input
            value={draftGewerk}
            onChange={e => setDraftGewerk(e.target.value)}
            placeholder="z.B. Sanitär, Maler, Elektro"
            className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>

        {/* Visibility toggle — defaults per kind; HW can override in editor.
            In create mode this only seeds the new pin; in edit mode tapping
            either pill writes immediately via setPinCustomerVisible. */}
        <fieldset className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Sichtbarkeit für Kundin
          </legend>
          <div
            role="radiogroup"
            aria-label="Sichtbarkeit für Kundin"
            className="mt-1 flex gap-2"
          >
            <button
              type="button"
              role="radio"
              aria-checked={draftCustomerVisible}
              onClick={() => onToggleVisibility(true)}
              disabled={busy}
              className={
                'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition ' +
                (draftCustomerVisible
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-900'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100')
              }
            >
              <span aria-hidden="true" className="mr-1.5">👁</span>
              Kundin sieht
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!draftCustomerVisible}
              onClick={() => onToggleVisibility(false)}
              disabled={busy}
              className={
                'flex-1 rounded-md border px-3 py-2 text-sm font-medium transition ' +
                (!draftCustomerVisible
                  ? 'border-neutral-700 bg-neutral-900 text-white'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100')
              }
            >
              <span aria-hidden="true" className="mr-1.5">🔒</span>
              Nur Team
            </button>
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">
            {draftCustomerVisible
              ? 'Diese Markierung erscheint in der Kundin-Ansicht des Aufmaßes.'
              : 'Diese Markierung bleibt intern und wird der Kundin nicht angezeigt.'}
          </p>
        </fieldset>

        {/* Timeline — Photo + Voice + Note rendered chronologically when in
            edit mode. Create-mode hides this until the pin is saved. */}
        {activeAnnotation ? (
          <div className="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              Verlauf
            </span>
            {activeAnnotation.photoAssetId ? (
              <PhotoTimelineItem
                signedUrl={photoSignedUrl}
                photoAssetId={activeAnnotation.photoAssetId}
              />
            ) : null}
            {voiceMemo ? (
              <VoiceMemoInlinePlayer
                bucket="project-scans"
                storagePath={voiceMemo.storagePath}
                durationHintSec={Math.round(voiceMemo.durationMs / 1000)}
              />
            ) : null}
            {!activeAnnotation.photoAssetId && !voiceMemo ? (
              <p className="text-xs text-neutral-500">
                Noch keine Anhänge — füge Foto oder Sprachnotiz hinzu.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Single FAB row — keeps the sheet compact, mirrors the
            Slack/Linear ActionSheet pattern (photo / voice / save). */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void onPickPhoto()}
            disabled={busy || !activeAnnotation}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
          >
            📷 Foto
          </button>
          <input {...picker.inputProps} />
          <VoiceRecorderButton
            clientMessageId={() => clientMessageIdRef.current}
            onRecorded={onRecorded}
            disabled={busy || !activeAnnotation}
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md px-3 py-2 text-sm text-neutral-600 hover:text-neutral-900"
          >
            Schließen
          </button>
          {isCreateMode ? (
            <button
              type="button"
              onClick={onCreate}
              disabled={busy}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Pin speichern
            </button>
          ) : (
            <button
              type="button"
              onClick={onSaveEdit}
              disabled={busy}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Speichern
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  )
}

function PhotoTimelineItem(props: { signedUrl: string | null; photoAssetId: string }) {
  if (!props.signedUrl) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-500">
        Foto angehängt ({props.photoAssetId.slice(0, 8)})
      </div>
    )
  }
  return (
    <a
      href={props.signedUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block overflow-hidden rounded-md border border-neutral-200 bg-white"
    >
      <img
        src={props.signedUrl}
        alt="Pin-Foto"
        className="h-32 w-full object-cover"
      />
    </a>
  )
}
