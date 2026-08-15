import { useCallback, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Plus,
} from 'lucide-react'
import { uploadMediaFile, IMAGE_VIDEO_ACCEPT } from '../../../lib/media/mediaUploadService'
import { addArtifact } from '../../../lib/media/mediaService'
import { logError } from '../../../lib/observability'
import type { ReconciliationEvidenceItem, ReconciliationView } from '../../../lib/reconciliation'
import type { MediaArtifact } from '../../../lib/media/types'

type Props = {
  view: ReconciliationView
  /** Auth user id of the viewer — required to attach uploads. */
  viewerUserId: string | null
  jobId: string
  /** Lifecycle gate — when false, the upload entry is hidden. */
  canUpload: boolean
  compact?: boolean
}

const SHARED_GATE_HINT =
  'Die Beweise des Anbieters werden dir nur zugänglich, wenn die Klärungsstelle sie freigibt.'

function pickIcon(item: ReconciliationEvidenceItem) {
  const cls = 'w-4 h-4'
  if (item.kind === 'image') return <ImageIcon className={cls} />
  if (item.kind === 'audio') return <Mic className={cls} />
  if (item.kind === 'document') return <FileText className={cls} />
  return <Paperclip className={cls} />
}

function formatBytes(value: number | null): string | null {
  if (!value || value <= 0) return null
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatUploadedAt(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`
}

export function EvidenceBlock({
  view,
  viewerUserId,
  jobId,
  canUpload,
  compact,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const handleAdd = useCallback(() => {
    if (!canUpload || uploading || !viewerUserId) return
    setError(null)
    setFeedback(null)
    fileInputRef.current?.click()
  }, [canUpload, uploading, viewerUserId])

  const handleFileChange = useCallback(async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file || !viewerUserId) return
    setUploading(true)
    setError(null)
    try {
      const record = await uploadMediaFile({
        file,
        entityType: 'dispute',
        entityId: view.disputeId,
        ownerUserId: viewerUserId,
        mediaRole: 'evidence',
      })
      // Sync the in-memory store so subscribers re-render without a full
      // hydration round-trip. The DB row is the single source of truth;
      // the in-memory artifact mirrors what the repository will return on
      // next fetch.
      const artifact: MediaArtifact = {
        id: record.id,
        jobId,
        kind: 'dispute_evidence',
        label: file.name,
        filename: file.name,
        mimeType: record.mimeType,
        uploadedAt: record.createdAt,
        uploadedBy: record.ownerUserId,
        disputeId: view.disputeId,
      }
      addArtifact(artifact)
      setFeedback('Beweismittel hochgeladen')
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Upload fehlgeschlagen. Bitte erneut versuchen.'
      setError(message)
      logError('reconciliation.evidence.upload_failed', err, {
        disputeId: view.disputeId,
        jobId,
      })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [view.disputeId, viewerUserId, jobId])

  const ownCount = view.ownEvidence.length
  const sharedCount = view.sharedCounterpartyEvidence.length
  const totalCount = ownCount + sharedCount

  return (
    <section
      className={
        compact
          ? 'rounded-card bg-surface ring-1 ring-edge p-4'
          : 'rounded-card bg-surface ring-1 ring-edge shadow-subtle p-4 mx-4 mb-3'
      }
    >
      <h3 className="text-[11px] font-semibold tracking-[.18em] uppercase text-ink-muted">
        § Beweise
      </h3>
      <p className="mt-2 mb-3 text-[15px] font-semibold leading-snug text-ink">
        {totalCount === 0
          ? 'Noch keine Beweise im Verfahren.'
          : totalCount === 1
            ? '1 Beweis im Verfahren.'
            : `${totalCount} Beweise im Verfahren.`}
      </p>

      {ownCount === 0 ? null : (
        <ul className="space-y-2">
          {view.ownEvidence.map((item) => (
            <EvidenceRow key={item.id} item={item} />
          ))}
        </ul>
      )}

      {sharedCount > 0 ? (
        <div className="mt-3">
          <h4 className="text-[10.5px] font-semibold tracking-[.16em] uppercase text-ink-muted mb-2">
            Vom Anbieter freigegeben
          </h4>
          <ul className="space-y-2">
            {view.sharedCounterpartyEvidence.map((item) => (
              <EvidenceRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-ink-muted">{SHARED_GATE_HINT}</p>
      )}

      {canUpload ? (
        <div className="mt-3 space-y-2">
          <button
            type="button"
            onClick={handleAdd}
            disabled={uploading || !viewerUserId}
            className="flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-brand/40 bg-brand/5 px-3 py-3 text-[14px] font-semibold text-brand active:scale-[0.99] disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {uploading ? 'Beweis wird hochgeladen …' : 'Beweis hinzufügen'}
          </button>
          {/* Voice-note path is intentionally inert in N13.2 — backend
              capability follows in N13.AUDIO. */}
          <button
            type="button"
            disabled
            data-todo="N13.AUDIO"
            aria-disabled="true"
            className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-card border border-dashed border-edge bg-canvas px-3 py-3 text-[13px] font-medium text-ink-muted opacity-60"
          >
            <Mic className="w-4 h-4" />
            Sprachnotiz · folgt mit N13.AUDIO
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_VIDEO_ACCEPT}
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-card bg-danger/10 px-3 py-2 text-[13px] text-danger">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-[1px]" />
          <span>{error}</span>
        </div>
      ) : null}
      {feedback && !error ? (
        <p className="mt-3 text-[12px] text-ok">{feedback}</p>
      ) : null}
    </section>
  )
}

function EvidenceRow({ item }: { item: ReconciliationEvidenceItem }) {
  const size = formatBytes(item.sizeBytes)
  const when = formatUploadedAt(item.uploadedAt)
  // The row is non-interactive until N13.LIGHTBOX adds a viewer.
  // `aria-disabled` keeps the chevron affordance honest for screen readers
  // and `cursor-default` removes the misleading hover hint.
  return (
    <li
      className="flex items-center gap-3 rounded-card border border-edge bg-canvas px-3 py-2 cursor-default"
      data-todo="N13.LIGHTBOX"
      aria-disabled="true"
    >
      <span className="flex w-9 h-9 items-center justify-center rounded-card bg-brand/10 text-brand">
        {pickIcon(item)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-ink">{item.name}</p>
        <p className="text-[11px] font-medium text-ink-muted tabular-nums">
          {[size, when].filter(Boolean).join(' · ')}
        </p>
      </div>
      <ChevronRight className="w-4 h-4 text-ink-muted opacity-40" aria-hidden="true" />
    </li>
  )
}
