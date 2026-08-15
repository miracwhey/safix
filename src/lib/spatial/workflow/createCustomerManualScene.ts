/**
 * Spatial · CAD Lane V1.5.1 · createCustomerManualScene
 *
 * Workflow for the Customer-Self-Scan entry-point (Mockup 05 →
 * `CustomerNewRoomSheet`): the Customer picks one of four room presets
 * (Bad / Küche / Wohnzimmer / Schlafzimmer), optionally tweaks the
 * dimensions via the steppers, and lands a fresh scene on their
 * "Meine Räume" tab.
 *
 * Mirrors {@link createEmptyRoomProject} (the HW-presales analogue) but
 * targets Customer-Self-Scan rows instead. Two structural differences:
 *
 *   - NO presales-project anchor — the scan stands alone on its
 *     `owner_type='customer'` row (Lane 3 Block 1 schema). `job_id`,
 *     `project_id`, `presales_project_id` all stay NULL.
 *   - The scene is inserted via `spatial_create_scene` (with V1.5.1's
 *     captured-by fallback patch — migration 20260525214248) instead of
 *     the presales-bound `spatial_create_manual_scene` RPC.
 *
 * Pipeline:
 *   1. Auth check — caller must be the `auth.uid()` that owns the scan.
 *   2. `repo.createScan({ ownerType: 'customer', source: 'manual' })` —
 *      lands the scan row first so the scene's `source_scan_id` can point
 *      at a real row. The scans-INSERT RLS policy gates this on
 *      `captured_by = auth.uid() AND owner_type = 'customer'`.
 *   3. Build a `RoomScene` from the matching preset (overridable dims).
 *   4. `serialize()` → ParametricJson with `source='manual'`.
 *   5. `encodeParametricBlob()` → gzip + SHA.
 *   6. `uploadParametricBlob()` to `spatial-parametric`.
 *   7. `spatial_create_scene` RPC writes the scene row. Customer-owner
 *      derivation falls through to `scans.captured_by` (M0 patch).
 *
 * Result-typed (no throws). A failure mid-pipeline leaves whatever
 * persistent rows we already wrote in place — the scan can be retried
 * against the same id, and the RPC is idempotent on `source_scan_id`.
 */

import type { PostgrestError } from '@supabase/supabase-js'

import { supabase } from '../../supabase'
import { logError, logInfo } from '../../observability'
import { serialize as serializeParametric } from '../canonical/converters/canonical-roundtrip'
import {
  buildCustomerRoomFromPreset,
  CUSTOMER_ROOM_PRESETS,
  type CustomerRoomPresetKind,
} from '../canonical/presets/presetCustomerRooms'
import {
  encodeParametricBlob,
} from '../canonical/storage/parametric-storage'
import {
  buildParametricPath,
  uploadParametricBlob,
} from '../canonical/storage/uploadParametricBlob'
import { emptyValidationReport } from '../canonical/types/validation'
import type { RoomScene } from '../canonical/types/scene-graph'
import { getSpatialRepository } from '../repository/registry'
import type { Scan } from '../types'

export interface CreateCustomerManualSceneInput {
  /** Which preset the Customer picked in the picker (Mockup 05 state 1). */
  presetKind: CustomerRoomPresetKind
  /** Display label — defaults to the preset's `label` when omitted. */
  name?: string
  /** Override width (X axis, metres). Falls back to the preset default. */
  widthM?: number
  /** Override length (Z axis, metres). Falls back to the preset default. */
  lengthM?: number
  /** Override ceiling height (Y axis, metres). Falls back to the preset default. */
  heightM?: number
}

export type CreateCustomerManualSceneFailure =
  | 'not_authenticated'
  | 'scan_create_failed'
  | 'encode_failed'
  | 'upload_failed'
  | 'scene_create_failed'

export interface CreateCustomerManualSceneSuccess {
  ok: true
  sceneId: string
  scan: Scan
  scene: RoomScene
  parametricPath: string
  presetKind: CustomerRoomPresetKind
  name: string
}

export interface CreateCustomerManualSceneError {
  ok: false
  reason: CreateCustomerManualSceneFailure
  message: string
  /** Set iff the scan row was already inserted before a later step failed —
   *  the caller can offer "Retry" against the same scan id. */
  scan?: Scan
}

export type CreateCustomerManualSceneResult =
  | CreateCustomerManualSceneSuccess
  | CreateCustomerManualSceneError

export async function createCustomerManualScene(
  input: CreateCustomerManualSceneInput,
): Promise<CreateCustomerManualSceneResult> {
  const preset = CUSTOMER_ROOM_PRESETS[input.presetKind]
  const name = (input.name ?? preset.label).trim() || preset.label

  const { data: authUser } = await supabase.auth.getUser()
  const userId = authUser.user?.id
  if (!userId) {
    return {
      ok: false,
      reason: 'not_authenticated',
      message: 'Anmeldung erforderlich.',
    }
  }

  // 2 · Land the scan row first. The scene's `source_scan_id` requires a
  //     real scans.id to point at, and the M0-fallback only fires when the
  //     scan's owner_type='customer' — both depend on this row existing.
  let scan: Scan
  try {
    scan = await getSpatialRepository().createScan({
      source: 'manual',
      capturedBy: userId,
      ownerType: 'customer',
      scanStartedAt: Date.now(),
      deviceMeta: { client: 'customer_manual_v15_1' },
    })
  } catch (err) {
    logError('spatial.customerManual.scan_create_failed', err, {
      userId,
      presetKind: input.presetKind,
    })
    return {
      ok: false,
      reason: 'scan_create_failed',
      message: pgErrorMessage(err) ?? 'Raum konnte nicht angelegt werden.',
    }
  }

  // 3 · Build the RoomScene from the preset (with stepper overrides applied).
  const sceneId = crypto.randomUUID()
  const scene: RoomScene = {
    ...buildCustomerRoomFromPreset({
      sceneId,
      presetKind: input.presetKind,
      overrideDims: {
        widthM: input.widthM,
        lengthM: input.lengthM,
        heightM: input.heightM,
      },
    }),
    name,
  }

  // 4-5 · Serialise + encode the parametric document.
  let encoded: Awaited<ReturnType<typeof encodeParametricBlob>>
  try {
    const parametric = serializeParametric({
      scene,
      validation_report: emptyValidationReport(scene.id, new Date().toISOString()),
      source: 'manual',
      fixup_project_id: null,
      fixup_job_id: null,
      metadata: {
        origin: 'customer_self_scan',
        preset_kind: input.presetKind,
        preset_label: preset.label,
        captured_by: userId,
        scan_id: scan.id,
      },
    })
    encoded = await encodeParametricBlob(parametric)
  } catch (err) {
    logError('spatial.customerManual.encode_failed', err, {
      userId,
      scanId: scan.id,
      presetKind: input.presetKind,
    })
    return {
      ok: false,
      reason: 'encode_failed',
      message: err instanceof Error ? err.message : 'Raum konnte nicht serialisiert werden.',
      scan,
    }
  }

  // 6 · Upload the gzip blob — content-addressed by the SHA.
  const parametricPath = buildParametricPath(userId, sceneId, encoded.sha256)
  const uploadResult = await uploadParametricBlob(parametricPath, encoded.bytes)
  if (!uploadResult.ok) {
    logError(
      'spatial.customerManual.upload_failed',
      new Error(uploadResult.error),
      { userId, scanId: scan.id, sceneId, presetKind: input.presetKind },
    )
    return {
      ok: false,
      reason: 'upload_failed',
      message: uploadResult.error || 'Hochladen fehlgeschlagen.',
      scan,
    }
  }

  // 7 · Create the scene row. The M0-patched spatial_create_scene RPC falls
  //     back to scans.captured_by for customer_id when the scan is
  //     owner_type='customer' and no project/job carries an owner.
  const rpc = await supabase.rpc('spatial_create_scene', {
    p_id: sceneId,
    p_parametric_storage_path: parametricPath,
    p_parametric_sha256: encoded.sha256,
    p_parametric_size_bytes: encoded.sizeBytes,
    p_source_scan_id: scan.id,
    p_source_job_id: null,
    p_schema_version: '1.0',
    p_validation_state: 'passed',
    p_is_renderable: true,
    p_requires_user_confirmation: false,
    p_metadata: {
      origin: 'customer_self_scan',
      preset_kind: input.presetKind,
      computed_area_m2: scene.computed_area_m2,
      category: scene.category,
    },
  })
  if (rpc.error) {
    logError('spatial.customerManual.scene_create_failed', rpc.error, {
      userId,
      scanId: scan.id,
      sceneId,
      presetKind: input.presetKind,
    })
    return {
      ok: false,
      reason: 'scene_create_failed',
      message: rpc.error.message || 'Szene konnte nicht angelegt werden.',
      scan,
    }
  }

  logInfo('spatial.customerManual.created', {
    userId,
    scanId: scan.id,
    sceneId,
    presetKind: input.presetKind,
  })

  return {
    ok: true,
    sceneId,
    scan,
    scene,
    parametricPath,
    presetKind: input.presetKind,
    name,
  }
}

function pgErrorMessage(err: unknown): string | null {
  if (!err) return null
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const pg = err as Pick<PostgrestError, 'message'>
    if (typeof pg.message === 'string' && pg.message.length > 0) return pg.message
  }
  return err instanceof Error ? err.message : null
}
