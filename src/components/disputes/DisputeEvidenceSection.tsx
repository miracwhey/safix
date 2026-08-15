import { useRef, useState, useCallback, useEffect } from 'react'
import type { MediaArtifactViewModel } from '../../lib/media'
import type { PersistedMediaRecord } from '../../lib/media/mediaUploadService'
import { uploadMediaFile, fetchMediaForEntity } from '../../lib/media/mediaUploadService'
import { useMediaPrivateUrl } from '../../lib/media/resolveMediaUrl'
import InlineFeedback from '../system/InlineFeedback'
import { useAsyncAction } from '../../hooks/useAsyncAction'
import type { DisputeEvidence } from '../../lib/disputes/types'
import type { Job } from '../../lib/jobs/types'
import DisputeDescriptionEvidenceItem from './DisputeDescriptionEvidenceItem'
import { useMediaPicker } from '../../lib/native/useMediaPicker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UploadConfig = {
  /** The dispute ID used as entityId for the upload */
  disputeId: string
  /** auth.users.id of the person submitting evidence */
  ownerUserId: string
}

type Props = {
  /** Legacy in-memory artifact view models (shown alongside persisted records) */
  artifacts?: MediaArtifactViewModel[]
  /**
   * When provided, enables a real Supabase Storage upload flow.
   * The section manages its own upload state and shows persisted records.
   */
  uploadConfig?: UploadConfig
  /**
   * Description-evidence entries from `dispute.metadata.evidence` jsonb. They
   * ride alongside photo/video artifacts in the same Beweismittel block but
   * use the quoted-statement renderer.
   * (Block N3b — Memory `feedback_disputes_metadata_jsonb_canonical`.)
   */
  descriptionEvidence?: DisputeEvidence[]
  /** Used by the description-evidence renderer to derive Inhaber/Kunde labels. */
  job?: Job
}

// ---------------------------------------------------------------------------
// Persisted evidence row (real upload)
// ---------------------------------------------------------------------------

function PersistedEvidenceItem({ record }: { record: PersistedMediaRecord }) {
  const isImage = record.mediaType === 'image'
  const dateLabel = new Date(record.createdAt).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  // Resolve signed URL from file_path. Fall back to legacy publicUrl for the 9
  // un-migrated project blobs that have no file_path yet (transition safety).
  const effectivePath = record.filePath || null
  const { url: signedUrl, isHydrated } = useMediaPrivateUrl(effectivePath)
  // While the signed URL is being resolved, show nothing for the media area
  // rather than a broken <img> src. Once hydrated, prefer the signed URL;
  // if filePath is empty fall back to the legacy public URL.
  const displayUrl = effectivePath
    ? (isHydrated ? (signedUrl ?? '') : '')
    : record.publicUrl

  return (
    <div className="rounded-[18px] bg-white ring-1 ring-rose-100 overflow-hidden">
      {isImage && (
        effectivePath && !isHydrated ? (
          // Loading skeleton while signed URL is being resolved
          <div className="h-40 w-full animate-pulse bg-slate-100" />
        ) : displayUrl ? (
          <img
            src={displayUrl}
            alt={`Beweismittel vom ${new Date(record.createdAt).toLocaleDateString('de-DE')}`}
            className="h-40 w-full object-cover"
          />
        ) : null
      )}
      {!isImage && (
        <div className="flex h-20 w-full items-center justify-center bg-slate-900">
          {effectivePath && !isHydrated ? (
            <span className="text-[13px] text-slate-400">Wird geladen…</span>
          ) : (
            <button
              type="button"
              onClick={() => { void import('../../lib/platform').then(({ openExternal }) => openExternal(displayUrl, 'tab')) }}
              className="flex items-center gap-2 rounded-full bg-white/20 px-4 py-2 text-[13px] font-semibold text-white"
            >
              <span>▶</span>
              <span>Video ansehen</span>
            </button>
          )}
        </div>
      )}
      <div className="px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] text-slate-500 truncate">{record.filePath.split('/').pop() || 'Datei'}</div>
          <div className="shrink-0 rounded-full bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700">
            Beweismittel
          </div>
        </div>
        <div className="mt-0.5 text-[11px] text-slate-400">{dateLabel}</div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DisputeEvidenceSection({
  artifacts = [],
  uploadConfig,
  descriptionEvidence = [],
  job,
}: Props) {
  const sortedDescriptionEvidence = [...descriptionEvidence].sort(
    (a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt),
  )
  const pickedFileRef = useRef<File | null>(null)
  const [uploadedRecords, setUploadedRecords] = useState<PersistedMediaRecord[]>([])
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { pickMedia, inputProps } = useMediaPicker()

  // Load any evidence already persisted for this dispute (e.g. from a previous
  // session, or uploaded by the other party once the RLS policy allows it).
  const disputeId = uploadConfig?.disputeId
  useEffect(() => {
    if (!disputeId) return
    fetchMediaForEntity('dispute', disputeId, { throwOnError: true })
      .then((records) => { setFetchError(null); setUploadedRecords(records) })
      .catch(() => setFetchError('Beweismittel konnten nicht geladen werden. Bitte Seite neu laden.'))
  }, [disputeId])

  const uploadAction = useCallback(async () => {
    if (!uploadConfig) return
    const file = pickedFileRef.current
    pickedFileRef.current = null
    if (!file) return

    const record = await uploadMediaFile({
      file,
      entityType: 'dispute',
      entityId: uploadConfig.disputeId,
      ownerUserId: uploadConfig.ownerUserId,
      mediaRole: 'evidence',
    })

    setUploadedRecords((prev) => [record, ...prev])
    setSuccessMsg('Beweismittel hochgeladen')
  }, [uploadConfig])

  const { execute, isLoading, error, clearError } = useAsyncAction(uploadAction)

  const handleAddClick = useCallback(async () => {
    if (isLoading) return
    setSuccessMsg(null)
    clearError()
    const file = await pickMedia({ kind: 'image-or-video' })
    if (!file) return
    pickedFileRef.current = file
    void execute()
  }, [isLoading, clearError, pickMedia, execute])

  const totalCount =
    artifacts.length + uploadedRecords.length + sortedDescriptionEvidence.length

  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[12px] font-semibold uppercase tracking-[0.12em] text-slate-400">
          Beweismittel ({totalCount})
        </div>

        {uploadConfig ? (
          <button
            type="button"
            onClick={handleAddClick}
            disabled={isLoading}
            className="rounded-full bg-rose-50 px-3 py-1 text-[12px] font-semibold text-rose-700 transition active:scale-[0.97] disabled:opacity-60"
          >
            {isLoading ? 'Wird hochgeladen…' : '+ Hinzufügen'}
          </button>
        ) : null}
      </div>

      {/* Hidden file input — accepts images and short videos via native picker. */}
      {uploadConfig ? <input {...inputProps} /> : null}

      {/* Fetch error — separate from upload error; shown when initial load fails */}
      {fetchError ? (
        <InlineFeedback error={fetchError} onDismiss={() => setFetchError(null)} />
      ) : null}

      {/* Upload feedback */}
      {error ? (
        <InlineFeedback error={error} onDismiss={clearError} />
      ) : successMsg ? (
        <InlineFeedback success={successMsg} onDismiss={() => setSuccessMsg(null)} />
      ) : null}

      {/* Description-evidence — quoted statements on top of the section */}
      {sortedDescriptionEvidence.length > 0 ? (
        <div className="space-y-2">
          {sortedDescriptionEvidence.map((e) => (
            <DisputeDescriptionEvidenceItem key={e.id} evidence={e} job={job} />
          ))}
        </div>
      ) : null}

      {/* Newly uploaded persisted records (shown with real image previews) */}
      {uploadedRecords.length > 0 ? (
        <div className="space-y-2">
          {uploadedRecords.map((r) => (
            <PersistedEvidenceItem key={r.id} record={r} />
          ))}
        </div>
      ) : null}

      {/* Legacy in-memory artifacts */}
      {artifacts.length === 0 &&
      uploadedRecords.length === 0 &&
      sortedDescriptionEvidence.length === 0 &&
      !fetchError ? (
        <div className="rounded-[18px] bg-slate-50 px-4 py-3 text-[13px] text-slate-400 ring-1 ring-slate-200/70">
          Noch keine Beweismittel beigefügt
        </div>
      ) : (
        <div className="space-y-2">
          {artifacts.map((a) => (
            <div
              key={a.id}
              className="rounded-[18px] bg-white px-4 py-3 ring-1 ring-rose-100"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-slate-900">
                    {a.label}
                  </div>
                  <div className="mt-0.5 truncate text-[12px] text-slate-500">
                    {a.filename}
                  </div>
                  {a.notes ? (
                    <div className="mt-1 text-[12px] text-slate-400">
                      {a.notes}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0 rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                  {a.kindLabel}
                </div>
              </div>
              <div className="mt-2 text-[11px] text-slate-400">
                {a.uploadedAtLabel} · {a.uploadedBy}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
