/**
 * Spatial · Workflow · Persist Customer-Scene Mutation (V1.6.1 R13 · Tür-Tool)
 *
 * Persistiert eine lokale Mutation am `RoomScene` eines Customer-Selbst-Scans
 * (Add-Door / Edit-Wall / etc.) durch Re-Upload des `parametric.json`-Blobs
 * und Update des `spatial_scenes`-Records auf den neuen content-addressierten
 * Pfad. Spiegelt die Schritte 4-7 aus `createCustomerManualScene.ts`, aber
 * für ein bereits existierendes Scene-Record statt für eine neue Anlage.
 *
 * Warum nicht `spatial_node_overrides`?
 *   Die Override-Engine resolved nur Deltas auf existierende Nodes
 *   (`canonical/overrides/variant-resolve.ts`). Add-Operationen wie ein neuer
 *   Türeintrag in `wall.openings` können nicht als Override ausgedrückt werden
 *   — siehe `AddDoorCommand.computeAfter` (kein Override-Row). In V1.6.1
 *   nehmen wir deshalb den Blob-Re-Upload-Pfad: einfache Semantik, kein
 *   neuer RPC, kein RLS-Activate-Migration nötig. Der content-addressierte
 *   Storage-Path stellt sicher, dass identische Edits idempotent landen.
 *
 * Persistence-Symmetrie (binding · konsistent mit persistEditCommand):
 *   - Mutation lokal angewendet → Blob-Upload + Scene-Update best-effort
 *   - Upload/Update fail → lokale Mutation BLEIBT angewendet (UI darf nicht
 *     User-Arbeit verlieren). Caller zeigt Toast bei `ok: false`.
 *
 * Layer: workflow/ — importiert Repository (Supabase) UND Storage Helpers.
 * Niemals aus `canonical/index.ts` re-exportieren.
 */

import {
  encodeParametricBlob,
  type ParametricBlobWire,
} from '../canonical/storage/parametric-storage'
import {
  buildParametricPath,
  uploadParametricBlob,
} from '../canonical/storage/uploadParametricBlob'
import { SPATIAL_PARAMETRIC_BUCKET } from '../canonical/storage/loadParametricBlob'
import { resolveSpatialDataSource } from '../canonical/repository/registry'
import { supabase } from '../../supabase'
import { serialize as serializeParametric } from '../canonical/converters/canonical-roundtrip'
import { getSpatialSceneRepository } from '../canonical/repository/registry'
import { emptyValidationReport } from '../canonical/types/validation'
import type { RoomScene } from '../canonical/types/scene-graph'
import type { NodeOverride, Variant } from '../canonical/types/variants'
import type { ValidationReport } from '../canonical/types/validation'
import type { ParametricJson } from '../canonical/converters/canonical-roundtrip'
import { logError, logInfo } from '../../observability'

export interface PersistCustomerSceneMutationInput {
  /** Target scene record id (`spatial_scenes.id`). */
  sceneId: string
  /** Auth user id — used both for storage path and ownership claim. Bei einem
   *  Customer-Selbst-Scan ist dies zugleich der Scene-Owner, d.h. der content-
   *  addressierte Blob-Pfad landet korrekt im eigenen Namespace (Cluster D
   *  Blocker 2 ist damit gegenstandslos, sobald `callerCanEdit` greift). */
  userId: string
  /**
   * Cluster D Workflow-Guard (CLAUDE.md: RBAC-Guards gehören in die Workflow-
   * Schicht, nicht nur in RLS). `false` → die Szene gehört dem Handwerker und
   * ist für den Customer read-only; wir brechen VOR dem Blob-Upload ab, sonst
   * landet ein Orphan-Blob, den erst die RLS-abgelehnte Update-Op + GC wieder
   * entfernt. `undefined` = nicht geprüft (Legacy-Caller) → erlaubt.
   */
  callerCanEdit?: boolean
  /** Mutated RoomScene (e.g. AddDoorCommand applied, edited wall, …). */
  roomScene: RoomScene
  /**
   * Optional roundtrip-Felder. Wenn weggelassen verwenden wir sensible
   * Defaults — die Mutation wird als `source: 'manual'` markiert und das
   * Metadata-Objekt enthält `origin: 'customer_edit'`.
   */
  validationReport?: ValidationReport
  variants?: readonly Variant[]
  overrides?: readonly NodeOverride[]
  source?: ParametricJson['source']
  metadata?: ParametricJson['metadata']
}

export type PersistCustomerSceneMutationResult =
  | {
      ok: true
      parametricPath: string
      parametricSha256: string
      parametricSizeBytes: number
    }
  | {
      ok: false
      reason: 'forbidden' | 'encode_failed' | 'upload_failed' | 'scene_update_failed'
      message: string
    }

/**
 * Persist a Customer-Scan-Scene mutation by re-uploading its parametric blob
 * and updating the scene record. Pure result-type API — never throws.
 */
export async function persistCustomerSceneMutation(
  input: PersistCustomerSceneMutationInput,
): Promise<PersistCustomerSceneMutationResult> {
  const {
    sceneId,
    userId,
    callerCanEdit,
    roomScene,
    validationReport,
    variants,
    overrides,
    source = 'manual',
    metadata,
  } = input

  // 0 · Cluster D RBAC backstop. Reject HW-owned scenes BEFORE the blob upload
  //     so we never create an orphan blob that the RLS-rejected update + GC
  //     would have to clean up. The DB RLS (`spatial_can_edit_scene`) remains
  //     the authoritative guard; this is the workflow-layer enforcement.
  if (callerCanEdit === false) {
    logError(
      'spatial.customerSceneMutation.forbidden',
      new Error('caller not allowed to edit this scene'),
      { sceneId, userId },
    )
    return {
      ok: false,
      reason: 'forbidden',
      message: 'Dieses Aufmaß gehört dem Handwerker und ist schreibgeschützt.',
    }
  }

  // 1 · Re-serialize the parametric document around the mutated scene.
  let encoded: ParametricBlobWire
  try {
    const parametric = serializeParametric({
      scene: roomScene,
      validation_report:
        validationReport ?? emptyValidationReport(roomScene.id, new Date().toISOString()),
      variants: variants ? [...variants] : undefined,
      overrides: overrides ? [...overrides] : undefined,
      source,
      fixup_project_id: null,
      fixup_job_id: null,
      metadata: {
        origin: 'customer_edit',
        ...metadata,
      },
    })
    encoded = await encodeParametricBlob(parametric)
  } catch (err) {
    logError('spatial.customerSceneMutation.encode_failed', err, {
      sceneId,
      userId,
    })
    return {
      ok: false,
      reason: 'encode_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Aufmaß konnte nicht serialisiert werden.',
    }
  }

  // 2 · Upload to the content-addressed path. Identical content → idempotent
  //     success (Storage 409 is mapped to ok=true upstream).
  const parametricPath = buildParametricPath(userId, sceneId, encoded.sha256)
  const uploadResult = await uploadParametricBlob(parametricPath, encoded.bytes)
  if (!uploadResult.ok) {
    logError(
      'spatial.customerSceneMutation.upload_failed',
      new Error(uploadResult.error),
      { sceneId, userId, parametricPath },
    )
    return {
      ok: false,
      reason: 'upload_failed',
      message: uploadResult.error || 'Aufmaß-Upload fehlgeschlagen.',
    }
  }

  // 3 · Update the scene record to point at the new blob. RLS auf
  //     `spatial_scenes` erzwingt: Customer kann nur own scene updaten.
  try {
    await getSpatialSceneRepository().update(sceneId, {
      parametricStoragePath: parametricPath,
      parametricSha256: encoded.sha256,
      parametricSizeBytes: encoded.sizeBytes,
    })
  } catch (err) {
    logError('spatial.customerSceneMutation.scene_update_failed', err, {
      sceneId,
      userId,
      parametricPath,
    })
    // L0.7 · Orphan-Blob-GC: the just-uploaded blob is now unreferenced (no
    // scene-record points at it). Best-effort delete to prevent storage
    // bloat. If delete also fails, log + move on — a pg_cron sweep job
    // catches any stragglers older than 7 days (Plan §L4.3).
    void garbageCollectParametricBlob(parametricPath, { sceneId, userId })
    return {
      ok: false,
      reason: 'scene_update_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Aufmaß konnte nicht aktualisiert werden.',
    }
  }

  logInfo('spatial.customerSceneMutation.persisted', {
    sceneId,
    userId,
    parametricPath,
    sha256: encoded.sha256,
    sizeBytes: encoded.sizeBytes,
  })

  return {
    ok: true,
    parametricPath,
    parametricSha256: encoded.sha256,
    parametricSizeBytes: encoded.sizeBytes,
  }
}

/**
 * L0.7 · Best-effort delete of an orphaned parametric blob (uploaded but
 * never referenced by a scene-record). In-memory mode is a no-op since
 * uploadParametricBlob also no-ops there. Never throws.
 */
async function garbageCollectParametricBlob(
  path: string,
  ctx: { sceneId: string; userId: string },
): Promise<void> {
  if (resolveSpatialDataSource() !== 'supabase') return
  try {
    const { error } = await supabase.storage
      .from(SPATIAL_PARAMETRIC_BUCKET)
      .remove([path])
    if (error) {
      logError('spatial.customerSceneMutation.orphan_blob_delete_failed', new Error(error.message), {
        ...ctx,
        parametricPath: path,
      })
      return
    }
    logInfo('spatial.customerSceneMutation.orphan_blob_gced', {
      ...ctx,
      parametricPath: path,
    })
  } catch (err) {
    logError('spatial.customerSceneMutation.orphan_blob_delete_threw', err, {
      ...ctx,
      parametricPath: path,
    })
  }
}
