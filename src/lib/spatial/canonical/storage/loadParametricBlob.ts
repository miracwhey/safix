/**
 * Spatial · Canonical · Storage · loadParametricBlob (Phase C · C-2 · Seam 2)
 *
 * The download half of the parametric-blob seam. Phase B left `RoomScene`
 * hydration as a documented gap: `parametric-storage.ts` is a pure
 * encode/decode helper, and `SupabaseSpatialSceneRepository` only ever stores
 * the `parametric_storage_path` POINTER — nothing composed the Storage
 * download. This module is that missing path.
 *
 * Pipeline: `spatial_scenes.parametric_storage_path`
 *   → `supabase.storage.from('spatial-parametric').download(path)`
 *   → gzip bytes
 *   → {@link decodeParametricBlob} (SHA-verify · decompress · parse · migrate)
 *   → {@link deserialize} (extract `scene_graph` / `variants` / `overrides`)
 *   → a renderable {@link RoomScene}.
 *
 * The bucket + its org-aware RLS are created by migration
 * `20260521120049_spatial_parametric_bucket`.
 *
 * Every failure is mapped to a typed {@link ParametricBlobLoadResult} — the
 * caller never sees a raw throw. A scene flagged `is_renderable` whose blob is
 * simply not uploaded yet resolves as `not_found`, which the hook treats as a
 * clean "no model" empty state rather than an error.
 */

import { supabase } from '../../../supabase.ts'
import { deserialize } from '../converters/canonical-roundtrip.ts'
import type { SpatialScene } from '../repository/SpatialSceneRepository.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type { NodeOverride, Variant } from '../types/variants.ts'
import { CanonicalError, SchemaValidationError } from '../types/errors.ts'
import { decodeParametricBlob } from './parametric-storage.ts'

/** Supabase Storage bucket holding the gzip parametric blob (migration 120049). */
export const SPATIAL_PARAMETRIC_BUCKET = 'spatial-parametric'

/** Why a {@link loadParametricBlob} call did not yield a scene. */
export type ParametricBlobLoadFailure =
  /** No object at the path — RLS-hidden, deleted, or not uploaded yet. */
  | 'not_found'
  /** Network / Storage transport failure. */
  | 'download_error'
  /** Stored bytes do not match the scene's `parametric_sha256` content address. */
  | 'sha_mismatch'
  /** Decompression / JSON-parse / schema-migration failure. */
  | 'decode_error'

export type ParametricBlobLoadResult =
  | {
      ok: true
      /** The hydrated, renderable scene-graph. */
      scene: RoomScene
      /** Variant chain stored in the blob — drives the VariantSwitcher. */
      variants: Variant[]
      /** Override stack stored in the blob. */
      overrides: NodeOverride[]
      /** SHA-256 of the downloaded bytes (the content address). */
      sha256: string
    }
  | { ok: false; reason: ParametricBlobLoadFailure; message: string }

/**
 * Download + decode the parametric blob for a scene. Pure result-type API —
 * never throws.
 */
export async function loadParametricBlob(
  scene: SpatialScene,
): Promise<ParametricBlobLoadResult> {
  const path = scene.parametricStoragePath
  if (!path) {
    return { ok: false, reason: 'not_found', message: 'Szene hat keinen Aufmaß-Pfad.' }
  }

  // ── 1 · Download the gzip blob ─────────────────────────────────────────────
  let blob: Blob
  try {
    const { data, error } = await supabase.storage
      .from(SPATIAL_PARAMETRIC_BUCKET)
      .download(path)
    if (error || !data) {
      // Supabase returns an error both for a genuinely missing object and for
      // an RLS-hidden one — from the caller's view both mean "no blob".
      return {
        ok: false,
        reason: 'not_found',
        message: error?.message ?? 'Aufmaß-Datei nicht gefunden.',
      }
    }
    blob = data
  } catch (e) {
    return {
      ok: false,
      reason: 'download_error',
      message: e instanceof Error ? e.message : 'Aufmaß konnte nicht geladen werden.',
    }
  }

  // ── 2 · Decode · verify content address · extract the scene-graph ──────────
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const decoded = await decodeParametricBlob(bytes, {
      expectedSha256: scene.parametricSha256 ?? undefined,
    })
    const { scene: roomScene, variants, overrides } = deserialize(decoded.document)
    return { ok: true, scene: roomScene, variants, overrides, sha256: decoded.sha256 }
  } catch (e) {
    // decodeParametricBlob throws CanonicalError('STORAGE_ERROR', …) for SHA
    // mismatch / decompression / JSON-parse, and SchemaValidationError for a
    // document that fails schema validation after migration.
    if (e instanceof CanonicalError && /SHA mismatch/i.test(e.message)) {
      return { ok: false, reason: 'sha_mismatch', message: e.message }
    }
    if (e instanceof SchemaValidationError) {
      return { ok: false, reason: 'decode_error', message: 'Aufmaß-Daten ungültig.' }
    }
    return {
      ok: false,
      reason: 'decode_error',
      message: e instanceof Error ? e.message : 'Aufmaß-Daten konnten nicht gelesen werden.',
    }
  }
}
