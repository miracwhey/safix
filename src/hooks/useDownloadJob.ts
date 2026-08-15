/**
 * Spatial Core · Block I.5 · Download-Job Hook
 *
 * Hydration-aware hook for a single `download_jobs` row. Polls every 2s
 * while `status` ∈ {pending, processing} and resolves a signed URL when
 * the Cloud Run worker marks the row `ready`. Resolves to `error` when
 * the worker writes `failed`.
 *
 * Polling cadence is 2s by master-plan default. The hook stops polling
 * the moment the job transitions to `ready` / `failed` to keep idle
 * detail screens off the network.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

const POLL_INTERVAL_MS = 2_000
const SIGNED_URL_TTL_SEC = 60 * 15
const BUCKET = 'project-scans'

export type DownloadJobKind = 'pdf_report' | 'floorplan_svg' | 'mesh_summary_json'
export type DownloadJobStatus = 'pending' | 'processing' | 'ready' | 'failed'

export interface DownloadJobRow {
  id: string
  scanId: string
  requestedBy: string
  kind: DownloadJobKind
  status: DownloadJobStatus
  storagePath: string | null
  expiresAt: string | null
  errorMessage: string | null
  requestedAt: string
  completedAt: string | null
}

export interface UseDownloadJobReturn {
  job: DownloadJobRow | null
  isHydrated: boolean
  error: Error | null
  signedUrl: string | null
  refresh: () => void
}

interface RawDownloadJobRow {
  id: string
  scan_id: string
  requested_by: string
  kind: DownloadJobKind
  status: DownloadJobStatus
  storage_path: string | null
  expires_at: string | null
  error_message: string | null
  requested_at: string
  completed_at: string | null
}

function mapJob(raw: RawDownloadJobRow): DownloadJobRow {
  return {
    id: raw.id,
    scanId: raw.scan_id,
    requestedBy: raw.requested_by,
    kind: raw.kind,
    status: raw.status,
    storagePath: raw.storage_path,
    expiresAt: raw.expires_at,
    errorMessage: raw.error_message,
    requestedAt: raw.requested_at,
    completedAt: raw.completed_at,
  }
}

export function useDownloadJob(jobId: string | null): UseDownloadJobReturn {
  const [job, setJob] = useState<DownloadJobRow | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const lastSignedFor = useRef<string | null>(null)

  const refresh = useCallback(() => setTick(t => t + 1), [])

  const isTerminal = useMemo(
    () => job?.status === 'ready' || job?.status === 'failed',
    [job?.status],
  )

  // Single-shot fetch driven by `tick`. The effect is a no-op when
  // `jobId` is null — callers gate by rendering the consuming component
  // only when they have a job to inspect, so the unset path stays cheap
  // and side-effect-free.
  useEffect(() => {
    if (!jobId) return
    let alive = true
    void supabase
      .from('download_jobs')
      .select('*')
      .eq('id', jobId)
      .single()
      .then(({ data, error }) => {
        if (!alive) return
        if (error) {
          setError(new Error(error.message))
          setIsHydrated(true)
          return
        }
        setJob(data ? mapJob(data as RawDownloadJobRow) : null)
        setError(null)
        setIsHydrated(true)
      })
    return () => {
      alive = false
    }
  }, [jobId, tick])

  // 2s polling while non-terminal. Cleared the moment status transitions
  // to ready / failed so an idle detail screen does not poll forever.
  useEffect(() => {
    if (!jobId || isTerminal) return
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [jobId, isTerminal, refresh])

  // Mint a signed URL once the worker writes the storage_path. Cache the
  // last URL by storage_path so a re-render does not re-sign.
  useEffect(() => {
    if (!job || job.status !== 'ready' || !job.storagePath) return
    if (lastSignedFor.current === job.storagePath) return
    lastSignedFor.current = job.storagePath
    void supabase.storage
      .from(BUCKET)
      .createSignedUrl(job.storagePath, SIGNED_URL_TTL_SEC)
      .then(({ data, error }) => {
        if (error || !data?.signedUrl) {
          setError(new Error(error?.message ?? 'failed to sign download url'))
          return
        }
        setSignedUrl(data.signedUrl)
      })
  }, [job])

  return { job, isHydrated, error, signedUrl, refresh }
}

/** RPC wrapper — single call site for `request_scan_download`. Returns
 *  the new job id. */
export async function requestScanDownload(input: {
  scanId: string
  kind: DownloadJobKind
}): Promise<string> {
  const { data, error } = await supabase.rpc('request_scan_download', {
    p_scan_id: input.scanId,
    p_kind: input.kind,
  })
  if (error) throw new Error(error.message)
  if (typeof data !== 'string') throw new Error('request_scan_download: unexpected payload')
  return data
}
