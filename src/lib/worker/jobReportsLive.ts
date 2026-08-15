/**
 * Realtime job_reports · Block FU-B
 *
 * Spiegelt `jobPhotosLive.subscribeJobPhotosForJob` für die job_reports-
 * Tabelle. Light-touch fetch+subscribe pro Job, kein zentraler Store.
 */

import { supabase } from '../supabase'
import { logBreadcrumb, logError, logInfo } from '../observability'
import {
  SupabaseJobReportRepository,
  type JobReportRepository,
} from './repository/JobReportRepository'
import type { JobReport } from './dokuTypes'

interface JobReportRow {
  id: string
  job_id: string
  provider_id: string
  authored_by: string
  body: string
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

function rowToReport(row: JobReportRow): JobReport {
  return {
    id: row.id,
    jobId: row.job_id,
    providerId: row.provider_id,
    authoredBy: row.authored_by,
    body: row.body,
    metadata: row.metadata ?? {},
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  }
}

export interface SubscribeJobReportsOptions {
  repository?: JobReportRepository
  channelFactory?: (name: string) => ReturnType<typeof supabase.channel>
}

export type JobReportsListener = (reports: JobReport[]) => void

export function subscribeJobReportsForJob(
  jobId: string,
  listener: JobReportsListener,
  options: SubscribeJobReportsOptions = {},
): () => void {
  const repo = options.repository ?? new SupabaseJobReportRepository()
  let cancelled = false
  let current: JobReport[] = []

  function emit(): void {
    if (cancelled) return
    listener([...current])
  }

  function applyInsert(row: JobReportRow): void {
    const report = rowToReport(row)
    if (current.some((r) => r.id === report.id)) return
    current = [report, ...current]
    emit()
  }

  function applyUpdate(row: JobReportRow): void {
    const report = rowToReport(row)
    const idx = current.findIndex((r) => r.id === report.id)
    if (idx < 0) {
      current = [report, ...current]
    } else {
      current = current.map((r) => (r.id === report.id ? report : r))
    }
    emit()
  }

  function applyDelete(id: string): void {
    if (!current.some((r) => r.id === id)) return
    current = current.filter((r) => r.id !== id)
    emit()
  }

  const channelName = `worker-doku-reports-job-${jobId}`
  const channel = (options.channelFactory ?? ((n) => supabase.channel(n)))(channelName)
  channel
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'job_reports', filter: `job_id=eq.${jobId}` },
      (payload: { new: JobReportRow }) => {
        if (cancelled) return
        applyInsert(payload.new)
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'job_reports', filter: `job_id=eq.${jobId}` },
      (payload: { new: JobReportRow }) => {
        if (cancelled) return
        applyUpdate(payload.new)
      },
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'job_reports', filter: `job_id=eq.${jobId}` },
      (payload: { old: { id?: string } }) => {
        if (cancelled) return
        const id = typeof payload.old?.id === 'string' ? payload.old.id : null
        if (id) applyDelete(id)
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logInfo('worker.job_reports.realtime_connected', { jobId })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logBreadcrumb('worker.job_reports.realtime_error', 'warning', { jobId, status })
      }
    })

  void (async () => {
    try {
      const initial = await repo.listForJob(jobId)
      if (cancelled) return
      const ids = new Set(current.map((r) => r.id))
      const merged = [...current, ...initial.filter((r) => !ids.has(r.id))]
      merged.sort((a, b) => b.createdAt - a.createdAt)
      current = merged
      emit()
    } catch (err) {
      logError(
        'worker.job_reports.initial_fetch_failed',
        err instanceof Error ? err : undefined,
        { jobId },
      )
    }
  })()

  return () => {
    cancelled = true
    void supabase.removeChannel(channel)
  }
}
