/**
 * JobMediaSection — BLOCK 58D: Media Usage Integration
 *
 * Provides the craftsman with a real Supabase Storage upload flow for job
 * documentation photos (progress + completion).
 *
 * Replaces the old fake `addJobPhotoWorkflow` button (which only incremented
 * an in-memory counter) with a real upload pipeline:
 *   - pick file → validate → upload to `job/{jobId}/{uuid}.{ext}`
 *   - persist reference in `media_uploads` with appropriate `media_role`
 *   - display persisted thumbnails immediately, reload-safe
 *
 * Two role buttons:
 *   - "Fortschrittsfoto"  → media_role = 'progress'
 *   - "Abschlussfoto"     → media_role = 'completion'
 *
 * UX: shows loading spinner during upload, InlineFeedback on success/failure.
 */

import { useRef, useState, useCallback, useEffect } from 'react'
import { fetchMediaForEntity } from '../../lib/media/mediaUploadService'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import { useMediaPrivateUrl } from '../../lib/media/resolveMediaUrl'
import { tryUploadOrEnqueue } from '../../lib/media/uploadOrEnqueue'
import { syncJobPhotoCount } from '../../lib/workflow/jobMediaSync'
import InlineFeedback from '../system/InlineFeedback'
import Spinner from '../system/Spinner'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import { useMediaPicker } from '../../lib/native/useMediaPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PhotoRole = 'progress' | 'completion'

type Props = {
  jobId: string
  ownerUserId: string
}

// ---------------------------------------------------------------------------
// Persisted photo item
// ---------------------------------------------------------------------------

function JobPhotoItem({ record }: { record: PersistedMediaRecord }) {
  const [errored, setErrored] = useState(false)
  const roleLabel = record.mediaRole === 'completion' ? 'Abschluss' : 'Fortschritt'
  const isVideo = record.mediaType === 'video'

  // Resolve signed URL from file_path. Fall back to legacy publicUrl for any
  // un-migrated blobs that have an empty file_path (transition safety).
  const effectivePath = record.filePath || null
  const { url: signedUrl, isHydrated } = useMediaPrivateUrl(effectivePath)
  const displayUrl = effectivePath
    ? (isHydrated ? (signedUrl ?? '') : '')
    : record.publicUrl

  return (
    <div className="relative overflow-hidden rounded-[16px] bg-slate-100 ring-1 ring-slate-200/70 aspect-square">
      {effectivePath && !isHydrated ? (
        // Loading skeleton while signed URL is being resolved
        <div className="h-full w-full animate-pulse bg-slate-200" />
      ) : !errored && displayUrl ? (
        isVideo ? (
          <video
            src={displayUrl}
            className="h-full w-full object-cover"
            preload="metadata"
            muted
            playsInline
            onError={() => setErrored(true)}
          />
        ) : (
          <img
            src={displayUrl}
            alt={roleLabel}
            className="h-full w-full object-cover"
            onError={() => setErrored(true)}
          />
        )
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <span className="text-[11px] text-slate-400">{errored ? 'Fehler' : ''}</span>
        </div>
      )}
      {isVideo && !errored && displayUrl && (
        <div className="absolute top-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 pointer-events-none">
          <span className="text-[10px] text-white">▶</span>
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/50 to-transparent px-2 pb-1.5 pt-4">
        <span className="text-[10px] font-semibold text-white">{roleLabel}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function JobMediaSection({ jobId, ownerUserId }: Props) {
  const pickedFileRef = useRef<File | null>(null)
  const pendingRoleRef = useRef<PhotoRole>('progress')
  const [displayRole, setDisplayRole] = useState<PhotoRole>('progress')
  const { pickMedia, inputProps } = useMediaPicker()

  const [uploadedPhotos, setUploadedPhotos] = useState<PersistedMediaRecord[]>([])
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Load persisted photos on mount so the section is reload-safe + sync
  // the canonical job.photoCount counter from the actual media_uploads
  // rows (closes the drift the legacy stub button left behind, which
  // the Worker-Doku-Projection still reads).
  useEffect(() => {
    let cancelled = false
    fetchMediaForEntity('job', jobId).then((records) => {
      if (!cancelled) setUploadedPhotos(records)
    })
    void syncJobPhotoCount(jobId)
    return () => {
      cancelled = true
    }
  }, [jobId])

  const uploadAction = useCallback(async () => {
    const file = pickedFileRef.current
    pickedFileRef.current = null
    if (!file) return

    const mediaRole = pendingRoleRef.current
    const roleLabel = mediaRole === 'completion' ? 'Abschluss' : 'Fortschritt'

    const result = await tryUploadOrEnqueue(
      { file, entityType: 'job', entityId: jobId, ownerUserId, mediaRole },
      { label: `${roleLabel}-${file.type.startsWith('video/') ? 'Video' : 'Foto'} (${file.name})` },
    )

    if (result.status === 'queued') {
      const offlineHint =
        result.reason === 'offline'
          ? 'Offline gespeichert — wird hochgeladen, sobald Verbindung besteht.'
          : 'Verbindung instabil — Upload wird im Hintergrund wiederholt.'
      setSuccessMsg(`${roleLabel}-Foto eingereiht. ${offlineHint}`)
    } else {
      const record = result.record
      setUploadedPhotos((prev) => {
        // Avoid duplicates by checking if the record already exists (e.g. after reload)
        if (prev.some((p) => p.id === record.id)) return prev
        return [record, ...prev]
      })
      const mediumLabel = record.mediaType === 'video' ? 'Video' : 'Foto'
      setSuccessMsg(`${roleLabel}-${mediumLabel} hochgeladen`)
      // Re-sync canonical job.photoCount so the Worker-Doku-Projection
      // and Operations-Tab counters reflect this upload immediately.
      void syncJobPhotoCount(jobId)
    }
  }, [jobId, ownerUserId])

  const { execute, isLoading, error, clearError } = useAsyncAction(uploadAction)

  const handlePick = useCallback(
    async (role: PhotoRole) => {
      if (isLoading) return
      pendingRoleRef.current = role
      setDisplayRole(role)
      setSuccessMsg(null)
      clearError()
      const file = await pickMedia({ kind: 'image-or-video' })
      if (!file) return
      pickedFileRef.current = file
      void execute()
    },
    [isLoading, clearError, pickMedia, execute]
  )

  const total = uploadedPhotos.length

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Job-Doku {total > 0 ? `(${total})` : ''}
        </div>
      </div>

      {/* Upload buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => handlePick('progress')}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 rounded-[16px] bg-slate-50 px-3 py-3 text-[13px] font-semibold text-slate-700 ring-1 ring-slate-200/70 transition active:scale-[0.97] disabled:opacity-60"
        >
          {isLoading && displayRole === 'progress' ? (
            <Spinner size="sm" tone="current" inButton />
          ) : (
            <span className="text-[14px]">📸</span>
          )}
          Fortschritt
        </button>
        <button
          type="button"
          onClick={() => handlePick('completion')}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 rounded-[16px] bg-emerald-50 px-3 py-3 text-[13px] font-semibold text-emerald-700 ring-1 ring-emerald-200/70 transition active:scale-[0.97] disabled:opacity-60"
        >
          {isLoading && displayRole === 'completion' ? (
            <Spinner size="sm" tone="current" inButton />
          ) : (
            <span className="text-[14px]">✅</span>
          )}
          Abschluss
        </button>
      </div>

      {/* Hidden file input — fallback for web + mixed image/video paths.
          No `capture` attribute on purpose: that would force the camera and
          block both gallery picks and existing videos on iOS. The native
          camera path is opted into per-call by useMediaPicker. */}
      <input {...inputProps} />

      {/* Feedback */}
      {error ? (
        <InlineFeedback error={error} onDismiss={clearError} />
      ) : successMsg ? (
        <InlineFeedback success={successMsg} onDismiss={() => setSuccessMsg(null)} />
      ) : null}

      {/* Photo grid */}
      {uploadedPhotos.length === 0 ? (
        <div className="rounded-[16px] bg-slate-50 px-4 py-3 text-center text-[13px] text-slate-400 ring-1 ring-slate-200/70">
          Noch keine Job-Fotos hochgeladen
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {uploadedPhotos.map((r) => (
            <JobPhotoItem key={r.id} record={r} />
          ))}
        </div>
      )}
    </div>
  )
}


