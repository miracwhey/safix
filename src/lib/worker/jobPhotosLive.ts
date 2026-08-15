/**
 * Realtime job_photos · Block FU-B
 *
 * Light-touch fetch+subscribe für einen einzelnen Job. Wird im
 * `WorkerDokuDetailScreen` genutzt, um Live-Updates zu sehen wenn ein
 * anderer Team-Member ein Foto added oder ein Foto aus dem Replay-Runner
 * eintrifft.
 *
 * Bewusst KEIN zentraler Store mit Reconnect-Logik à la
 * `SupabaseTimeEntryRepository`. Detail-Screen ist der einzige Konsument,
 * der Hydration-Lifecycle manage'd selbst (mount→fetch→subscribe,
 * unmount→unsubscribe). Für den Owner-Dashboard-Use-Case (Multi-Job-Live-
 * Aggregate) kommt ein separater Realtime-Store in einem späteren Block.
 *
 * Fail-Soft: Realtime-Errors degradieren auf reine fetch-only-Lifecycle.
 * Worker sieht eigene Uploads sofort (Optimistic-Local-Update via
 * onUploaded-Callback aus PhotoCaptureCTA), Cross-Member-Updates sind
 * dann „eventually consistent" auf Re-Mount.
 */

import { supabase } from '../supabase'
import { logBreadcrumb, logError, logInfo } from '../observability'
import {
  SupabaseJobPhotoRepository,
  type JobPhotoRepository,
} from './repository/JobPhotoRepository'
import type { JobPhoto } from './dokuTypes'

interface JobPhotoRow {
  id: string
  job_id: string
  provider_id: string
  uploaded_by: string
  storage_path: string
  client_uuid: string
  width_px: number | null
  height_px: number | null
  size_bytes: number | null
  created_at: string
}

function rowToPhoto(row: JobPhotoRow): JobPhoto {
  return {
    id: row.id,
    jobId: row.job_id,
    providerId: row.provider_id,
    uploadedBy: row.uploaded_by,
    storagePath: row.storage_path,
    clientUuid: row.client_uuid,
    ...(row.width_px != null && { widthPx: row.width_px }),
    ...(row.height_px != null && { heightPx: row.height_px }),
    ...(row.size_bytes != null && { sizeBytes: row.size_bytes }),
    createdAt: new Date(row.created_at).getTime(),
  }
}

export interface SubscribeJobPhotosOptions {
  /** Test-Hook — Repo-Override für Initial-Fetch. */
  repository?: JobPhotoRepository
  /** Test-Hook — channel-Factory-Override für Subscribe-Mocks. */
  channelFactory?: (name: string) => ReturnType<typeof supabase.channel>
}

export type JobPhotosListener = (photos: JobPhoto[]) => void

/**
 * Lädt die initial-Foto-Liste und abonniert INSERT/UPDATE/DELETE für den
 * Job. Liefert eine Cleanup-Funktion zurück, die das Channel schließt.
 *
 * Reihenfolge: erst Subscribe, dann Fetch — verhindert Race-Loss eines
 * Foto-Inserts, der zwischen Fetch-Return und Subscribe-Open landet.
 */
export function subscribeJobPhotosForJob(
  jobId: string,
  listener: JobPhotosListener,
  options: SubscribeJobPhotosOptions = {},
): () => void {
  const repo = options.repository ?? new SupabaseJobPhotoRepository()
  let cancelled = false
  let current: JobPhoto[] = []

  function emit(): void {
    if (cancelled) return
    listener([...current])
  }

  function applyInsert(row: JobPhotoRow): void {
    const photo = rowToPhoto(row)
    if (current.some((p) => p.id === photo.id)) return
    current = [photo, ...current]
    emit()
  }

  function applyUpdate(row: JobPhotoRow): void {
    const photo = rowToPhoto(row)
    const idx = current.findIndex((p) => p.id === photo.id)
    if (idx < 0) {
      current = [photo, ...current]
    } else {
      current = current.map((p) => (p.id === photo.id ? photo : p))
    }
    emit()
  }

  function applyDelete(id: string): void {
    if (!current.some((p) => p.id === id)) return
    current = current.filter((p) => p.id !== id)
    emit()
  }

  // 1. Subscribe first.
  const channelName = `worker-doku-photos-job-${jobId}`
  const channel = (options.channelFactory ?? ((n) => supabase.channel(n)))(channelName)
  channel
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'job_photos', filter: `job_id=eq.${jobId}` },
      (payload: { new: JobPhotoRow }) => {
        if (cancelled) return
        applyInsert(payload.new)
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'job_photos', filter: `job_id=eq.${jobId}` },
      (payload: { new: JobPhotoRow }) => {
        if (cancelled) return
        applyUpdate(payload.new)
      },
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: 'job_photos', filter: `job_id=eq.${jobId}` },
      (payload: { old: { id?: string } }) => {
        if (cancelled) return
        const id = typeof payload.old?.id === 'string' ? payload.old.id : null
        if (id) applyDelete(id)
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logInfo('worker.job_photos.realtime_connected', { jobId })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        logBreadcrumb('worker.job_photos.realtime_error', 'warning', { jobId, status })
      }
    })

  // 2. Initial-Fetch. Race-Loss durch Subscribe-First abgefangen.
  void (async () => {
    try {
      const initial = await repo.listForJob(jobId)
      if (cancelled) return
      // Merge initial + bereits-via-Subscribe eingegangene Rows. ID-set
      // dedup verhindert Duplikate.
      const ids = new Set(current.map((p) => p.id))
      const merged = [...current, ...initial.filter((p) => !ids.has(p.id))]
      // Sortiert nach createdAt desc bleibt stabil.
      merged.sort((a, b) => b.createdAt - a.createdAt)
      current = merged
      emit()
    } catch (err) {
      logError(
        'worker.job_photos.initial_fetch_failed',
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
