/**
 * Spatial · Canonical · Storage · uploadParametricBlob (Szenen-Produktion · B2)
 *
 * The upload half of the parametric-blob seam — the missing write path that
 * `loadParametricBlob` (the read half) was always paired with. `encode-
 * ParametricBlob` produces the gzip bytes + content-address SHA; this module
 * lands those bytes in the `spatial-parametric` Storage bucket so the
 * `spatial_create_scene` RPC can record the pointer.
 *
 * Path schema (bucket migration 20260521120049 · storage RLS):
 *   {uploaderUserId}/{sceneId}/parametric-{sha}.json.gz
 *   → foldername[1] = uploader uid (the bucket INSERT policy gate)
 *   → foldername[2] = sceneId      (the bucket SELECT policy gate)
 *
 * Content-addressed: the SHA is in the path, so identical content always
 * lands at the same key. A retry that re-uploads identical bytes is an
 * idempotent success — an "already exists" response is mapped to `ok: true`.
 *
 * Data-source aware: in `in-memory` mode there is no Storage backend, so the
 * logical path is returned unchanged (the InMemory repository just stores the
 * string pointer).
 */

import { supabase } from '../../../supabase.ts'
import { resolveSpatialDataSource } from '../repository/registry.ts'
import { SPATIAL_PARAMETRIC_BUCKET } from './loadParametricBlob.ts'

/** MIME type for the gzip parametric blob — matches the bucket's allowed list. */
export const PARAMETRIC_CONTENT_TYPE = 'application/gzip'

export type ParametricBlobUploadResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

/**
 * Build the content-addressed Storage path for a parametric blob.
 *
 * @param uploaderUserId  the uploading user — MUST be `auth.uid()` so the
 *                        bucket INSERT policy (`foldername[1] = auth.uid()`)
 *                        accepts the write.
 * @param sceneId         the client-generated scene uuid.
 * @param sha256          lowercase-hex SHA-256 of the gzip bytes.
 */
export function buildParametricPath(
  uploaderUserId: string,
  sceneId: string,
  sha256: string,
): string {
  return `${uploaderUserId}/${sceneId}/parametric-${sha256}.json.gz`
}

/** True when a Storage upload failed only because the object already exists. */
function isAlreadyExistsError(error: unknown): boolean {
  const status = (error as { statusCode?: string | number }).statusCode
  if (status === '409' || status === 409) return true
  const message = (error as { message?: string }).message ?? ''
  return /already exists|duplicate|resource already/i.test(message)
}

/**
 * Upload the gzip parametric blob to the `spatial-parametric` bucket. Pure
 * result-type API — never throws.
 */
export async function uploadParametricBlob(
  path: string,
  bytes: Uint8Array,
): Promise<ParametricBlobUploadResult> {
  // In-memory mode has no Storage backend — the path string is the pointer.
  if (resolveSpatialDataSource() !== 'supabase') {
    return { ok: true, path }
  }

  // Copy into a fresh ArrayBuffer: pako's Uint8Array may be SharedArrayBuffer-
  // backed in some build targets, which the Blob constructor rejects.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const blob = new Blob([buffer], { type: PARAMETRIC_CONTENT_TYPE })

  try {
    const { error } = await supabase.storage
      .from(SPATIAL_PARAMETRIC_BUCKET)
      .upload(path, blob, { contentType: PARAMETRIC_CONTENT_TYPE, upsert: false })
    if (error) {
      // Content-addressed: an object already at this path holds byte-identical
      // content (the SHA is in the path). A duplicate upload is an idempotent
      // success, not a failure — this keeps a partial-failure retry clean.
      if (isAlreadyExistsError(error)) {
        return { ok: true, path }
      }
      return { ok: false, error: error.message }
    }
    return { ok: true, path }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Aufmaß-Upload fehlgeschlagen.',
    }
  }
}
