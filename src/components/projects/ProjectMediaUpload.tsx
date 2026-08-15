/**
 * ProjectMediaUpload — BLOCK 58E: Project Media Integration
 *
 * Allows customers to attach images to a project/request.
 *
 * Upload flow:
 * - customer taps "Foto hinzufügen"
 * - file picker opens (images only: JPEG, PNG, WebP)
 * - file is uploaded via `uploadMediaFile` to Supabase Storage
 *   at `project/{projectId}/{uuid}.{ext}` with `media_role='project_photo'`
 * - uploaded thumbnail is shown immediately (no reload needed)
 * - InlineFeedback shows success / failure
 * - fires `media_project_uploaded` analytics event on success
 *
 * This component is intentionally minimal — no gallery zoom, no delete,
 * no reordering. Its sole purpose is to help the customer communicate
 * what they need clearly.
 */

import { useRef, useState, useCallback } from 'react'
import { uploadMediaFile } from '../../lib/media/mediaUploadService'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import { useMediaPrivateUrl } from '../../lib/media/resolveMediaUrl'
import InlineFeedback from '../system/InlineFeedback'
import Spinner from '../system/Spinner'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { recordAnalyticsEvent } from '../../lib/analytics/analyticsService'
import { useMediaPicker } from '../../lib/native/useMediaPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  projectId: string
  ownerUserId: string
  /**
   * Called after each successful upload so the parent can react
   * (e.g. show an updated image count).
   */
  onUploaded?: (record: PersistedMediaRecord) => void
}

// ---------------------------------------------------------------------------
// Uploaded photo thumbnail (local preview inside this session)
// ---------------------------------------------------------------------------

function UploadedThumb({ record }: { record: PersistedMediaRecord }) {
  const [errored, setErrored] = useState(false)

  // Resolve signed URL for the just-uploaded photo. For newly-uploaded private
  // blobs, file_path is always set; the publicUrl is '' (private bucket).
  // Fall back to publicUrl for any legacy public blobs.
  const effectivePath = record.filePath || null
  const { url: signedUrl, isHydrated } = useMediaPrivateUrl(effectivePath)
  const displayUrl = effectivePath
    ? (isHydrated ? (signedUrl ?? '') : '')
    : record.publicUrl

  return (
    <div className="relative aspect-square overflow-hidden rounded-[14px] bg-slate-100 ring-1 ring-slate-200/70">
      {effectivePath && !isHydrated ? (
        // Loading skeleton while the signed URL is being fetched
        <div className="h-full w-full animate-pulse bg-slate-200" />
      ) : !errored && displayUrl ? (
        <img
          src={displayUrl}
          alt="Projektbild"
          className="h-full w-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-[11px] text-slate-400">{errored ? 'Fehler' : ''}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProjectMediaUpload({ projectId, ownerUserId, onUploaded }: Props) {
  const pickedFileRef = useRef<File | null>(null)
  const [uploadedPhotos, setUploadedPhotos] = useState<PersistedMediaRecord[]>([])
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const { pickMedia, inputProps } = useMediaPicker()

  const uploadAction = useCallback(async () => {
    const file = pickedFileRef.current
    pickedFileRef.current = null
    if (!file) return

    const record = await uploadMediaFile({
      file,
      entityType: 'project',
      entityId: projectId,
      ownerUserId,
      mediaRole: 'project_photo',
    })

    setUploadedPhotos((prev) => [record, ...prev])
    setSuccessMsg('Bild hochgeladen')

    recordAnalyticsEvent({
      eventType: 'media_project_uploaded',
      entityType: 'media',
      entityId: projectId,
      actorUserId: ownerUserId,
      metadata: { projectId },
    })

    onUploaded?.(record)
  }, [projectId, ownerUserId, onUploaded])

  const { execute, isLoading, error, clearError } = useAsyncAction(uploadAction)

  const handlePick = useCallback(async () => {
    if (isLoading) return
    setSuccessMsg(null)
    clearError()
    const file = await pickMedia({ kind: 'image' })
    if (!file) return
    pickedFileRef.current = file
    void execute()
  }, [isLoading, clearError, pickMedia, execute])

  const total = uploadedPhotos.length

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Projektbilder {total > 0 ? `(${total})` : ''}
        </div>
      </div>

      {/* Upload button */}
      <button
        type="button"
        onClick={handlePick}
        disabled={isLoading}
        className="flex w-full items-center justify-center gap-2 rounded-[16px] bg-blue-50 px-3 py-3 text-[13px] font-semibold text-[#2563EB] ring-1 ring-blue-200/60 transition active:scale-[0.97] disabled:opacity-60"
      >
        {isLoading ? (
          <Spinner size="sm" tone="current" inButton />
        ) : (
          <span className="text-[14px]">📸</span>
        )}
        {isLoading ? 'Wird hochgeladen…' : 'Foto hinzufügen'}
      </button>

      {/* Hidden file input — fallback for web + mixed paths. */}
      <input {...inputProps} />

      {/* Feedback */}
      {error ? (
        <InlineFeedback error={error} onDismiss={clearError} />
      ) : successMsg ? (
        <InlineFeedback success={successMsg} onDismiss={() => setSuccessMsg(null)} />
      ) : null}

      {/* Session thumbnails (this session only; reload-safe photos shown by ProjectMediaGrid) */}
      {uploadedPhotos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {uploadedPhotos.map((r) => (
            <UploadedThumb key={r.id} record={r} />
          ))}
        </div>
      )}
    </div>
  )
}
