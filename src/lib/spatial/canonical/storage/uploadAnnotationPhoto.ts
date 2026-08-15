/**
 * Spatial · Canonical · Storage · uploadAnnotationPhoto (Phase C · C-10 · Seam 12)
 *
 * Uploads an annotation pin photo to the `spatial-annotation-photos` bucket
 * (migration 120051). Phase B held photos as browser object-URLs that vanished
 * when the editor sheet closed — a silent loss of a problem photo (liability).
 *
 * Data-source aware: in `in-memory` mode (tests / first-run dev) there is no
 * Storage backend, so the local object-URL is returned as the "path" — the
 * caller still gets a stable result shape and never blocks on a missing
 * backend.
 */

import { supabase } from '../../../supabase.ts'
import { resolveSpatialDataSource } from '../repository/registry.ts'
import { stripImageExifIfPossible } from '../../../media/preUploadPipeline.ts'

/** Supabase Storage bucket for annotation pin photos (migration 120051). */
export const SPATIAL_ANNOTATION_PHOTOS_BUCKET = 'spatial-annotation-photos'

export type AnnotationPhotoUploadResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

/** Best-effort extension from a file name / mime type. */
function extensionOf(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : ''
  if (fromName && fromName.length <= 5) return fromName.toLowerCase()
  const fromMime = file.type.split('/')[1]
  return fromMime ? fromMime.toLowerCase() : 'jpg'
}

/**
 * Upload one annotation photo. Path schema `{userId}/{sceneId}/{uuid}.{ext}`
 * matches the bucket RLS (path-owner write, scene-viewer read).
 */
export async function uploadAnnotationPhoto(
  file: File,
  userId: string,
  sceneId: string,
): Promise<AnnotationPhotoUploadResult> {
  // In-memory mode has no Storage backend — keep the local object-URL.
  if (resolveSpatialDataSource() !== 'supabase') {
    return { ok: true, path: URL.createObjectURL(file) }
  }

  // Strip EXIF/GPS before upload — annotation photos document problems inside
  // a customer's home; the raw camera roll carries the address as GPS.
  const safeFile = await stripImageExifIfPossible(file)
  const path = `${userId}/${sceneId}/${crypto.randomUUID()}.${extensionOf(safeFile)}`

  try {
    const { error } = await supabase.storage
      .from(SPATIAL_ANNOTATION_PHOTOS_BUCKET)
      .upload(path, safeFile, {
        contentType: safeFile.type || 'image/jpeg',
        upsert: false,
      })
    if (error) return { ok: false, error: error.message }
    return { ok: true, path }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Foto-Upload fehlgeschlagen.',
    }
  }
}
