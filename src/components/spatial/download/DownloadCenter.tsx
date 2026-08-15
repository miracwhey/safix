/**
 * Spatial Core · Block I.5 · Download-Center UI
 *
 * Three request buttons (PDF report, floorplan SVG, mesh-summary JSON).
 * Each button creates a `download_jobs` row via the `request_scan_download`
 * RPC and renders a poll-driven progress indicator. When the worker
 * writes `status = 'ready'`, the hook signs the storage path and we
 * auto-open the download in a new tab (browser will trigger save based
 * on the response Content-Disposition).
 *
 * The component does not own any business logic — it dispatches into the
 * `requestScanDownload` workflow helper and listens via `useDownloadJob`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../../../hooks/useToast'
import {
  requestScanDownload,
  useDownloadJob,
  type DownloadJobKind,
} from '../../../hooks/useDownloadJob'

export interface DownloadCenterProps {
  scanId: string
  /** Hide from customer surfaces — defaults to true for craftsman + operator. */
  enabled?: boolean
}

interface DownloadOption {
  kind: DownloadJobKind
  copy: string
  caption: string
}

const OPTIONS: DownloadOption[] = [
  { kind: 'pdf_report', copy: 'PDF-Report', caption: 'Quality + Maße + Pins als druckbares PDF' },
  { kind: 'floorplan_svg', copy: 'Grundriss SVG', caption: '2D-Top-Down-View aller Wände + Pins' },
  { kind: 'mesh_summary_json', copy: 'Mesh-JSON', caption: 'Wand-/Tür-/Fenster-Klassifikation als JSON' },
]

// Post-review feature-flag (Phase 6 of the P0 batch): the Cloud Run export
// worker that flips download_jobs from 'pending' → 'ready' does not exist
// yet. Showing the buttons live in V1 would leave every click hanging in
// 'pending' forever. The reaper cron (migration 72) will now mark them
// 'failed' after 30 minutes, but the user-facing UX is still broken.
// Until the worker ships in V1.1, render a "Bald verfügbar"-skin and keep
// the click path inert. Operators can still toggle it via props.enabled.
const DOWNLOAD_WORKER_LIVE = false

export function DownloadCenter(props: DownloadCenterProps) {
  const toast = useToast()
  const [activeJobIds, setActiveJobIds] = useState<Record<DownloadJobKind, string | null>>({
    pdf_report: null,
    floorplan_svg: null,
    mesh_summary_json: null,
  })

  const enabled = props.enabled ?? true
  if (!enabled) return null

  if (!DOWNLOAD_WORKER_LIVE) {
    return (
      <div className="space-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
          Export
        </span>
        <div className="grid gap-2 sm:grid-cols-3">
          {OPTIONS.map(opt => (
            <div
              key={opt.kind}
              className="flex flex-col items-start gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-left text-sm opacity-80"
              aria-disabled="true"
            >
              <span className="font-semibold text-neutral-900">{opt.copy}</span>
              <span className="text-[11px] text-neutral-500">{opt.caption}</span>
              <span className="mt-1 inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                Bald verfügbar
              </span>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-neutral-500">
          PDF, Grundriss und Mesh-JSON werden in einem späteren Update freigeschaltet.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
        Export
      </span>
      <div className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map(opt => (
          <DownloadButton
            key={opt.kind}
            scanId={props.scanId}
            option={opt}
            jobId={activeJobIds[opt.kind]}
            onJobStarted={id =>
              setActiveJobIds(prev => ({ ...prev, [opt.kind]: id }))
            }
            onError={message => toast.error(message)}
            onReady={url => {
              window.open(url, '_blank', 'noopener,noreferrer')
              toast.success(`${opt.copy} bereit.`)
            }}
          />
        ))}
      </div>
    </div>
  )
}

interface DownloadButtonProps {
  scanId: string
  option: DownloadOption
  jobId: string | null
  onJobStarted: (jobId: string) => void
  onReady: (url: string) => void
  onError: (message: string) => void
}

function DownloadButton(props: DownloadButtonProps) {
  const [requesting, setRequesting] = useState(false)
  const { job, signedUrl, error } = useDownloadJob(props.jobId)
  const handledTerminalFor = useRef<string | null>(null)

  const isPending =
    job?.status === 'pending' || job?.status === 'processing' || requesting
  const hasReady = job?.status === 'ready' && signedUrl

  // Fire ready / failed callbacks exactly once per terminal transition —
  // doing it in render would spam toasts on every parent re-render and
  // loop the state update.
  useEffect(() => {
    if (!job) return
    const terminalKey = `${job.id}:${job.status}`
    if (handledTerminalFor.current === terminalKey) return
    if (job.status === 'ready' && signedUrl) {
      handledTerminalFor.current = terminalKey
      props.onReady(signedUrl)
    } else if (job.status === 'failed') {
      handledTerminalFor.current = terminalKey
      props.onError(
        `${props.option.copy} fehlgeschlagen: ${job.errorMessage ?? 'unbekannter Fehler'}`,
      )
    }
  }, [job, signedUrl, props])

  useEffect(() => {
    if (error) props.onError(error.message)
  }, [error, props])

  const onClick = useCallback(async () => {
    if (requesting || isPending) return
    setRequesting(true)
    try {
      const jobId = await requestScanDownload({
        scanId: props.scanId,
        kind: props.option.kind,
      })
      props.onJobStarted(jobId)
    } catch (err) {
      props.onError(
        `${props.option.copy} konnte nicht angefordert werden: ${
          err instanceof Error ? err.message : 'unbekannter Fehler'
        }`,
      )
    } finally {
      setRequesting(false)
    }
  }, [requesting, isPending, props])

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={isPending}
      className="flex flex-col items-start gap-1 rounded-lg border border-neutral-200 bg-white p-3 text-left text-sm transition hover:border-emerald-300 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="font-semibold text-neutral-900">{props.option.copy}</span>
      <span className="text-[11px] text-neutral-500">{props.option.caption}</span>
      {isPending ? (
        <span className="mt-1 text-[11px] text-amber-600">
          {job?.status === 'processing' ? 'Wird erzeugt…' : 'Angefragt…'}
        </span>
      ) : null}
      {hasReady ? (
        <span className="mt-1 text-[11px] text-emerald-700">Bereit.</span>
      ) : null}
    </button>
  )
}
