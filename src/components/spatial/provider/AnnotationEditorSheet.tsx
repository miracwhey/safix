/**
 * AnnotationEditorSheet — Annotation-Editor leaf screen (Mockup 29 · Phase B · B-4)
 *
 * One editor, three annotation types (Notiz / Foto / Problem) selectable via a
 * segmented control at the top.  The type is pre-set by the caller (e.g. the
 * 3D-tab toolbar pre-selects "Problem" when the user taps the Problem tool).
 *
 * Persists via `getSpatialSceneRepository().appendEditHistory(...)` — best-effort
 * audit append; local close happens immediately.
 *
 * Prop surface mirrors MeasurementEditorSheet so the 3D-tab toolbar wires both
 * sheets in the same pattern.
 *
 * Phase-C seam: the `photos` field is UI-only — it holds local object-URLs from
 * the browser file-picker.  Actual upload (Supabase Storage → `spatial_pins`
 * table column `photo_urls`) is Phase C scope.  A documented comment marks the
 * gap inline.
 */

import { useCallback, useMemo, useState } from 'react'

import BottomSheet from '../../ui/BottomSheet'
import { getSpatialSceneRepository } from '../../../lib/spatial/canonical/repository/registry'
import type { SpatialScene } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import { uploadAnnotationPhoto } from '../../../lib/spatial/canonical/storage/uploadAnnotationPhoto'
import { getSession } from '../../../lib/session'
import { useHaptics } from '../../../hooks/useHaptics'

/** A picked photo — local preview URL kept alongside the File for upload. */
interface PhotoEntry {
  url: string
  file: File
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AnnotationType = 'note' | 'photo' | 'issue'
export type AnnotationUrgency = 'low' | 'medium' | 'high'

export interface AnnotationEditorSheetProps {
  open: boolean
  onClose: () => void
  scene: SpatialScene
  /** Node / element label shown in the subtitle. */
  elementLabel?: string
  /**
   * Real scene-graph node id of the selected element — the audit `baseNodeId`
   * (C-3 hit-testing). Falls back to `elementLabel` when no node is selected.
   */
  baseNodeId?: string
  /** Pre-selected annotation type.  User can switch after opening. */
  initialType?: AnnotationType
  /**
   * Variant layer id for the edit-history audit append.
   * Must be the `provider_annotations_{role}` string, NOT a user/auth UUID.
   */
  variantId: string
  /** Called on save.  Parent may also listen to persistence directly. */
  onSave: (annotation: {
    type: AnnotationType
    text: string
    urgency: AnnotationUrgency | null
    isPublic: boolean
  }) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level glyphs (react-hooks/static-components rule)
// ─────────────────────────────────────────────────────────────────────────────

function NoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 2.5h9v6h-5l-2.5 2.5v-2.5h-1.5v-6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PhotoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="1.5" y="3.5" width="11" height="8.5" rx="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="7" cy="7.7" r="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.7 3.5 5.7 1.8h2.6l1 1.7" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function IssueIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M7 1.5 1 12h12L7 1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M7 5.2v2.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="10" r="0.8" fill="currentColor" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 5v10M5 10h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_TABS: { key: AnnotationType; label: string }[] = [
  { key: 'note', label: 'Notiz' },
  { key: 'photo', label: 'Foto' },
  { key: 'issue', label: 'Problem' },
]

const URGENCY_OPTS: { key: AnnotationUrgency; label: string }[] = [
  { key: 'low', label: 'Niedrig' },
  { key: 'medium', label: 'Mittel' },
  { key: 'high', label: 'Hoch' },
]

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function titleFor(type: AnnotationType): string {
  switch (type) {
    case 'note': return 'Pin setzen'
    case 'photo': return 'Foto hinzufügen'
    case 'issue': return 'Problem melden'
  }
}

function saveLabelFor(type: AnnotationType): string {
  switch (type) {
    case 'note': return 'Pin speichern'
    case 'photo': return 'Foto speichern'
    case 'issue': return 'Problem melden'
  }
}

function urgencyColor(key: AnnotationUrgency, selected: boolean) {
  if (!selected) return 'border-edge bg-white text-ink-sub'
  switch (key) {
    case 'low': return 'border-ok bg-[#D1FAE5] text-ok'
    case 'medium': return 'border-warn bg-[#FEF3C7] text-warn'
    case 'high': return 'border-danger bg-[#FEE2E2] text-danger'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function AnnotationEditorSheet({
  open,
  onClose,
  scene,
  elementLabel,
  baseNodeId,
  initialType = 'note',
  variantId,
  onSave,
}: AnnotationEditorSheetProps) {
  const haptics = useHaptics()

  const [type, setType] = useState<AnnotationType>(initialType)
  const [text, setText] = useState('')
  const [urgency, setUrgency] = useState<AnnotationUrgency>('medium')
  const [isPublic, setIsPublic] = useState(false)
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Reset type when the caller changes `initialType` and the sheet re-opens.
  // We DON'T reset on every `initialType` change to preserve edits in progress.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setType(initialType)
      setText('')
      setUrgency('medium')
      setIsPublic(false)
      setPhotos([])
      setSaveError(null)
    }
  }

  const canSave = useMemo(() => {
    if (type === 'photo') return photos.length > 0 || text.trim().length > 0
    return text.trim().length > 0
  }, [type, photos, text])

  // ── Photo picker — Files kept for the C-10 Storage upload ────────────────

  const handleAddPhoto = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    // image/* + video/* wildcards keep HEIC/HEVC pickable (memory: iOS picker).
    input.accept = 'image/*'
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      setPhotos((prev) => [
        ...prev,
        ...files.map((f) => ({ url: URL.createObjectURL(f), file: f })),
      ])
    }
    input.click()
  }, [])

  // ── Save ──────────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (!canSave || saving) return
    setSaving(true)
    setSaveError(null)

    const annotation = {
      type,
      text,
      urgency: type === 'issue' ? urgency : null,
      isPublic,
    }

    try {
      // C-10 Seam 12: upload photos to Storage BEFORE the sheet closes — a
      // problem photo must not be silently lost when the sheet dismisses.
      let photoPaths: string[] = []
      if (photos.length > 0) {
        const userId = getSession().user?.id
        if (!userId) throw new Error('Nicht angemeldet')
        const results = await Promise.all(
          photos.map((p) => uploadAnnotationPhoto(p.file, userId, scene.id)),
        )
        const failed = results.find((r) => !r.ok)
        if (failed) throw new Error('Foto-Upload fehlgeschlagen')
        photoPaths = results.flatMap((r) => (r.ok ? [r.path] : []))
      }

      // C-10: audit append is AWAITED before close — a failure keeps the
      // sheet open with a visible error (CLAUDE.md core-flow rule).
      await getSpatialSceneRepository().appendEditHistory({
        sceneId: scene.id,
        variantId,
        baseNodeId: baseNodeId ?? elementLabel ?? 'unknown',
        overrideFields: {
          annotation_type: type,
          text,
          urgency: annotation.urgency,
          is_public: isPublic,
          photo_paths: photoPaths,
        },
        command: 'set',
        parametricSha256Before: scene.parametricSha256,
        parametricSha256After: null,
      })
      haptics.success()
      onSave(annotation)
      onClose()
    } catch {
      setSaveError('Konnte nicht gespeichert werden — bitte erneut versuchen.')
    } finally {
      setSaving(false)
    }
  }, [canSave, saving, type, text, urgency, isPublic, photos, variantId, scene, baseNodeId, elementLabel, onSave, onClose, haptics])

  const isIssue = type === 'issue'

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      maxWidth={480}
      hideHandle
      className="!px-0 !pt-0 !pb-0 !rounded-t-[26px]"
    >
      {/* Handle */}
      <div className="mx-auto mb-1 mt-2 h-[5px] w-9 rounded-full bg-slate-900/20" aria-hidden="true" />

      {/* Header */}
      <div className="flex items-center justify-between px-4 pb-3 pt-1.5">
        <div>
          <p className="text-[16px] font-[750] text-ink">{titleFor(type)}</p>
          {elementLabel && (
            <p className="mt-[1px] text-[11.5px] text-ink-muted">{elementLabel}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Schließen"
          className="flex h-7 w-7 items-center justify-center rounded-full bg-canvas text-ink-sub"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Type segmented control */}
      <div
        className="mx-4 flex gap-[3px] rounded-[11px] bg-edge-soft p-[3px]"
        role="tablist"
        aria-label="Annotationstyp"
      >
        {TYPE_TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={type === key}
            onClick={() => { haptics.selection(); setType(key) }}
            className={[
              'flex flex-1 items-center justify-center gap-[5px] rounded-[8px] py-2 text-[12px] font-[650] transition',
              type === key
                ? 'bg-white text-ink shadow-subtle'
                : 'text-ink-sub',
            ].join(' ')}
          >
            {key === 'note' && <NoteIcon />}
            {key === 'photo' && <PhotoIcon />}
            {key === 'issue' && <IssueIcon />}
            {label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 pb-2 pt-3.5">

        {/* Photo row — visible for photo + issue types */}
        {(type === 'photo' || type === 'issue') && (
          <div className="mb-3.5">
            <p className="mb-[7px] text-[11px] font-[700] text-ink-sub">Foto</p>
            <div className="flex gap-[9px]">
              {photos.map((photo, i) => (
                <div
                  key={photo.url}
                  className="relative h-[86px] w-[86px] shrink-0 overflow-hidden rounded-[11px] border border-edge"
                >
                  <img
                    src={photo.url}
                    alt={`Foto ${i + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Foto ${i + 1} entfernen`}
                    className="absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ink/70 text-white"
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
                      <path d="M2 2l4 4M6 2 2 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={handleAddPhoto}
                aria-label="Foto hinzufügen"
                className="flex h-[86px] w-[86px] shrink-0 flex-col items-center justify-center gap-1 rounded-[11px] border-[1.5px] border-dashed border-edge bg-canvas text-brand"
              >
                <PlusIcon />
                <span className="text-[10px] font-[700]">Foto</span>
              </button>
            </div>
          </div>
        )}

        {/* Urgency picker — issue type only */}
        {isIssue && (
          <div className="mb-3.5">
            <p className="mb-[7px] text-[11px] font-[700] text-ink-sub">Dringlichkeit</p>
            <div className="flex gap-[7px]" role="group" aria-label="Dringlichkeit">
              {URGENCY_OPTS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={urgency === key}
                  onClick={() => { haptics.selection(); setUrgency(key) }}
                  className={[
                    'flex-1 rounded-[10px] border-[1.5px] py-[9px] text-center text-[12px] font-[700] transition',
                    urgencyColor(key, urgency === key),
                  ].join(' ')}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Text field */}
        <div className="mb-3.5">
          <p className="mb-[7px] text-[11px] font-[700] text-ink-sub">
            {type === 'photo' ? 'Bildunterschrift' : type === 'issue' ? 'Beschreibung' : 'Notiz'}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              type === 'issue'
                ? 'Was ist das Problem? Was muss beachtet werden?'
                : type === 'photo'
                  ? 'Optionale Bildunterschrift ...'
                  : 'Notiz für das Team ...'
            }
            rows={type === 'note' ? 4 : 3}
            aria-label={type === 'issue' ? 'Problem-Beschreibung' : 'Notiz'}
            className="w-full resize-none rounded-card border border-edge bg-canvas px-3 py-[11px] text-[13px] leading-[1.45] text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/10"
          />
        </div>

        {/* Visibility toggle */}
        <div className="flex items-center gap-[11px] rounded-card border border-edge bg-canvas px-3 py-[11px]">
          <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] bg-[#EEF2FB] text-brand">
            <EyeIcon />
          </div>
          <div className="flex-1">
            <p className="text-[12.5px] font-[650] text-ink">Für Kunden sichtbar</p>
            <p className="mt-[1px] text-[10.5px] text-ink-muted">
              {isPublic ? 'An — Kunde sieht diese Annotation' : 'Aus — nur intern fürs Team'}
            </p>
          </div>
          {/* iOS-style toggle */}
          <button
            type="button"
            role="switch"
            aria-checked={isPublic}
            onClick={() => { haptics.selection(); setIsPublic((v) => !v) }}
            className={[
              'relative h-[26px] w-[44px] shrink-0 rounded-chip transition-colors',
              isPublic ? 'bg-ok' : 'bg-edge',
            ].join(' ')}
            aria-label="Sichtbarkeit umschalten"
          >
            <span
              className={[
                'absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-[left]',
                isPublic ? 'left-[20px]' : 'left-[2px]',
              ].join(' ')}
            />
          </button>
        </div>
      </div>

      {/* Footer CTA */}
      <div className="border-t border-edge bg-white px-4 pb-[max(26px,env(safe-area-inset-bottom))] pt-[11px]">
        {saveError && (
          <p className="mb-2 text-center text-[12px] font-[600] text-danger">{saveError}</p>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          aria-label={saveLabelFor(type)}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-[13px] py-3.5 text-[14.5px] font-[700] text-white transition',
            !canSave || saving
              ? 'cursor-not-allowed bg-ink-muted'
              : isIssue
                ? 'bg-danger shadow-[0_8px_20px_-8px_rgba(220,38,38,0.5)] active:scale-[0.98]'
                : 'bg-brand shadow-brand-glow active:scale-[0.98]',
          ].join(' ')}
        >
          {isIssue ? (
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M7.5 1.5 1 13h13L7.5 1.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M7.5 5.8v3.1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="7.5" cy="11" r="0.95" fill="currentColor" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M3 8 6 11l6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          {saving
            ? photos.length > 0
              ? 'Fotos werden hochgeladen …'
              : 'Wird gespeichert …'
            : saveLabelFor(type)}
        </button>
      </div>
    </BottomSheet>
  )
}
