/**
 * JobPhotoRepository · Block C.2
 *
 * Async Repository über die `job_photos`-Tabelle (Migration
 * `20260508000002_job_photos.sql`). Anders als die Optimistic-Cache-
 * Repositories (z.B. SupabaseRatingRepository) nutzt dieses Repo den
 * read-on-demand-Pattern: jeder Aufruf hits Supabase. Für Live-Updates
 * subscribed die UI in C.3 direkt auf das Realtime-Channel der Tabelle.
 *
 * Insert/Delete laufen direkt durch RLS (kein Optimistic-Write); bei
 * Offline-Failures ist die `photoUploadQueue` (IndexedDB) der Replay-Pfad.
 */

import { supabase } from '../../supabase'
import { logError } from '../../observability'
import type { JobPhoto } from '../dokuTypes'

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

export interface AddJobPhotoInput {
  jobId: string
  providerId: string
  uploadedBy: string
  storagePath: string
  clientUuid: string
  widthPx?: number
  heightPx?: number
  sizeBytes?: number
}

export interface JobPhotoRepository {
  listForJob(jobId: string): Promise<JobPhoto[]>
  add(input: AddJobPhotoInput): Promise<JobPhoto>
  delete(photoId: string): Promise<void>
}

export class SupabaseJobPhotoRepository implements JobPhotoRepository {
  async listForJob(jobId: string): Promise<JobPhoto[]> {
    const { data, error } = await supabase
      .from('job_photos')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })
    if (error) {
      logError('worker.job_photos.list_failed', error, { jobId })
      throw error
    }
    return ((data ?? []) as JobPhotoRow[]).map(rowToPhoto)
  }

  async add(input: AddJobPhotoInput): Promise<JobPhoto> {
    const insertRow = {
      job_id: input.jobId,
      provider_id: input.providerId,
      uploaded_by: input.uploadedBy,
      storage_path: input.storagePath,
      client_uuid: input.clientUuid,
      width_px: input.widthPx ?? null,
      height_px: input.heightPx ?? null,
      size_bytes: input.sizeBytes ?? null,
    }
    const { data, error } = await supabase
      .from('job_photos')
      .insert(insertRow)
      .select('*')
      .single()
    if (error) {
      logError('worker.job_photos.add_failed', error, {
        jobId: input.jobId,
        clientUuid: input.clientUuid,
      })
      throw error
    }
    return rowToPhoto(data as JobPhotoRow)
  }

  async delete(photoId: string): Promise<void> {
    const { error } = await supabase
      .from('job_photos')
      .delete()
      .eq('id', photoId)
    if (error) {
      logError('worker.job_photos.delete_failed', error, { photoId })
      throw error
    }
  }
}
