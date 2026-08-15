/**
 * Worker-Doku Photo-Capture-Service · Block C.2
 *
 * Orchestriert den Foto-Upload-Pfad: nimmt einen `File` (vom UI-Picker
 * oder Capacitor Camera), läuft preUploadPipeline (EXIF-Strip + JPEG-
 * Komprimierung), uploaded nach Storage `worker-doku-photos`, und legt
 * eine Row in `job_photos` an.
 *
 * Bei Netzwerk-Failure wird der post-Pipeline-Blob in die Offline-Queue
 * (`photoUploadQueue`) gelegt; der Replay-Runner versucht's später erneut.
 *
 * Service kümmert sich NICHT um Camera-Triggering — das passiert im UI
 * via `useMediaPicker` (existing). Der Service nimmt den File entgegen.
 */

import { supabase } from '../supabase'
import { logError, logInfo, logWarning } from '../observability'
import { runPreUploadPipeline } from '../media/preUploadPipeline'
import {
  SupabaseJobPhotoRepository,
  type JobPhotoRepository,
} from './repository/JobPhotoRepository'
import { enqueuePhotoUpload } from './photoUploadQueue'
import type { CapturePhotoResult } from './dokuTypes'

const STORAGE_BUCKET = 'worker-doku-photos'
const DEFAULT_REPO: JobPhotoRepository = new SupabaseJobPhotoRepository()

export interface UploadJobPhotoInput {
  jobId: string
  providerId: string
  uploadedBy: string
  file: File
}

export interface UploadJobPhotoOptions {
  /** Test-Hook: Repo-Override für Mock-Tests. */
  repository?: JobPhotoRepository
  /** Test-Hook: deterministisches UUID für Storage-Path-Predictability. */
  generateClientUuid?: () => string
}

function defaultUuid(): string {
  // crypto.randomUUID() in modern browsers; fallback for very old runtimes.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC4122 v4 fallback. Test-Env nur — Production-Browser hat randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function buildStoragePath(jobId: string, clientUuid: string): string {
  return `jobs/${jobId}/${clientUuid}.jpg`
}

/**
 * Versucht den vollen Foto-Upload-Pfad. Bei Storage- oder DB-Fehler wird
 * der post-Pipeline-Blob in die Offline-Queue enqueued und es wird ein
 * Result mit `wasReencoded: true/false` geliefert — aber **mit `photo:
 * null` Marker für die UI**, damit sie ein „queued"-Tile rendert.
 *
 * Im Erfolgsfall wird die Photo-Row aus der DB zurückgegeben (inkl.
 * server-vergebener id, created_at).
 */
export async function uploadJobPhoto(
  input: UploadJobPhotoInput,
  options: UploadJobPhotoOptions = {},
): Promise<CapturePhotoResult> {
  const repo = options.repository ?? DEFAULT_REPO
  const generateUuid = options.generateClientUuid ?? defaultUuid

  // 1. Pre-Upload-Pipeline: EXIF-Strip + Compression. Bei reject (z.B.
  // Magic-Byte-Mismatch) → throw, Caller zeigt Fehlermeldung.
  const pipeline = await runPreUploadPipeline(input.file)
  if (!pipeline.ok) {
    throw new Error(pipeline.reason)
  }
  const file = pipeline.file
  const wasReencoded = pipeline.diagnostics.compressed

  const clientUuid = generateUuid()
  const storagePath = buildStoragePath(input.jobId, clientUuid)

  // 2. Storage-Upload. Bei Failure → Queue.
  const { error: storageError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false,
    })

  if (storageError) {
    logWarning('worker.photo_capture.storage_failed_enqueueing', {
      jobId: input.jobId,
      storagePath,
      error: storageError.message,
    })
    await enqueuePhotoUpload({
      clientUuid,
      jobId: input.jobId,
      providerId: input.providerId,
      uploadedBy: input.uploadedBy,
      storagePath,
      blob: file,
      contentType: file.type || 'image/jpeg',
      sizeBytes: file.size,
    })
    throw new Error(
      'Foto wurde gespeichert und wird hochgeladen, sobald die Verbindung wieder steht.',
    )
  }

  // 3. DB-Insert. Bei Failure → Storage-Cleanup + Queue.
  try {
    const photo = await repo.add({
      jobId: input.jobId,
      providerId: input.providerId,
      uploadedBy: input.uploadedBy,
      storagePath,
      clientUuid,
      sizeBytes: file.size,
    })
    logInfo('worker.photo_capture.uploaded', {
      jobId: input.jobId,
      photoId: photo.id,
      sizeBytes: file.size,
      reencoded: wasReencoded,
    })
    return {
      photo,
      wasReencoded,
      diagnostics: {
        originalSize: pipeline.diagnostics.originalSize,
        finalSize: pipeline.diagnostics.finalSize,
      },
    }
  } catch (dbError) {
    // 23505 = unique violation auf (job_id, client_uuid). In dem Fall ist
    // die Row bereits da (= Idempotenz-Hit, z.B. Race zwischen sync-Capture
    // und Replay-Runner). Der Storage-Blob ist legitim — KEIN Cleanup,
    // KEIN Re-Enqueue, sonst würden wir die echte Datei zerstören. Hart
    // werfen, damit der UI sichtbar wird, dass etwas Ungewöhnliches lief.
    const code = (dbError as { code?: string } | null)?.code
    if (code === '23505') {
      logWarning('worker.photo_capture.idempotent_collision', {
        jobId: input.jobId,
        clientUuid,
        storagePath,
      })
      throw new Error(
        'Foto wurde bereits hochgeladen. Bitte Liste aktualisieren.',
      )
    }

    // Sonst: Storage-Object remove versuchen, damit kein verwaister Blob
    // bleibt. Failure beim Cleanup wird nur geloggt, nicht throw —
    // primärer Pfad ist die Queue-Persistenz für Replay.
    try {
      await supabase.storage.from(STORAGE_BUCKET).remove([storagePath])
    } catch (cleanupError) {
      logWarning('worker.photo_capture.cleanup_failed', {
        storagePath,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      })
    }
    logError(
      'worker.photo_capture.db_failed_enqueueing',
      dbError instanceof Error ? dbError : undefined,
      { jobId: input.jobId, storagePath },
    )
    await enqueuePhotoUpload({
      clientUuid,
      jobId: input.jobId,
      providerId: input.providerId,
      uploadedBy: input.uploadedBy,
      storagePath,
      blob: file,
      contentType: file.type || 'image/jpeg',
      sizeBytes: file.size,
    })
    throw new Error(
      'Foto wurde gespeichert und wird hochgeladen, sobald die Verbindung wieder steht.',
    )
  }
}
