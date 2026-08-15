/**
 * Spatial · Lane 2.5 · Stream B · createEmptyRoomProject
 *
 * Workflow for the two Privat-Tab Manual-Start CTAs:
 *
 *   - **Vorlage 2×2 m** — 4-wall closed rectangle, default 2 × 2 × 2.5 m.
 *     User adjusts via the DimensionInputSheet (B4).
 *   - **Leerer Raum**  — zero-wall canvas. User draws each wall with the
 *     Tap-to-Place tool (B5).
 *
 * Pipeline:
 *   1. Create a fresh `provider_presales_projects` row (defaults +
 *      'Privat'-friendly title).
 *   2. Build a `RoomScene` from the matching preset (B1).
 *   3. `serialize()` → ParametricJson with `source: 'manual'`.
 *   4. `encodeParametricBlob` → gzip + SHA.
 *   5. `uploadParametricBlob` to `spatial-parametric` (content-addressed).
 *   6. `spatial_create_manual_scene` RPC (B0 migration) writes the scene
 *      row with `origin='manual'` and the presales-project anchor.
 *   7. Bump the presales project to `status='scanned'` so the Hub badges
 *      it the same way as a real scan.
 *
 * Result-typed (no throws). Failures roll back the presales-project row
 * iff the scene-creation step is what failed — a successful project +
 * failed scene leaves a recoverable 'draft' row the user can retry
 * against from the detail screen.
 */

import { supabase } from '../../supabase'
import { logError, logInfo } from '../../observability'
import type { PresalesProject } from '../../../domain/presales/presalesProjectTypes'
import { getPresalesProjectRepository } from '../../presales/repository/registry'
import {
  createProviderPresalesProject,
  type CreateProviderPresalesProjectInput,
} from '../../presales/workflow/createProviderPresalesProject'
import { serialize as serializeParametric } from '../canonical/converters/canonical-roundtrip'
import {
  buildEmptyCanvasPreset,
  buildEmptyRoom2x2Preset,
  PRESET_EMPTY_CANVAS,
  PRESET_EMPTY_ROOM_2X2,
} from '../canonical/presets/presetEmptyRoom'
import {
  encodeParametricBlob,
} from '../canonical/storage/parametric-storage'
import {
  buildParametricPath,
  uploadParametricBlob,
} from '../canonical/storage/uploadParametricBlob'
import { emptyValidationReport } from '../canonical/types/validation'
import type { RoomScene } from '../canonical/types/scene-graph'

export type CreateEmptyRoomVariant = 'empty_room_2x2' | 'empty_canvas'

export interface CreateEmptyRoomProjectInput
  extends CreateProviderPresalesProjectInput {
  variant: CreateEmptyRoomVariant
  /** Defaults to 2 m (variant=empty_room_2x2). Ignored for empty_canvas. */
  widthM?: number
  /** Defaults to 2 m. Ignored for empty_canvas. */
  depthM?: number
  /** Defaults to 2.5 m. */
  ceilingHeightM?: number
}

export type CreateEmptyRoomFailure =
  | 'not_authenticated'
  | 'project_create_failed'
  | 'encode_failed'
  | 'upload_failed'
  | 'scene_create_failed'

export type CreateEmptyRoomResult =
  | {
      ok: true
      project: PresalesProject
      sceneId: string
      scene: RoomScene
      parametricPath: string
      variant: CreateEmptyRoomVariant
    }
  | {
      ok: false
      reason: CreateEmptyRoomFailure
      message: string
      /** Set iff the presales-project was created but a later step failed —
       *  the caller can offer "Open draft" or "Retry from detail". */
      project?: PresalesProject
    }

/**
 * One-call entry point. Calls below are awaited in sequence so a failure
 * stops the chain — there is no partial-success state to clean up beyond
 * the optional rollback noted on the Result type.
 */
export async function createEmptyRoomProject(
  input: CreateEmptyRoomProjectInput,
): Promise<CreateEmptyRoomResult> {
  const projectResult = await createProviderPresalesProject({
    title: input.title,
    locationHint: input.locationHint,
    customerNameDraft: input.customerNameDraft,
    customerEmailDraft: input.customerEmailDraft,
    customerPhoneDraft: input.customerPhoneDraft,
    notes: input.notes,
  })
  if (!projectResult.ok) {
    return {
      ok: false,
      reason: 'project_create_failed',
      message: projectResult.message,
    }
  }
  const project = projectResult.project
  const { data: authUser } = await supabase.auth.getUser()
  const userId = authUser.user?.id
  if (!userId) {
    return {
      ok: false,
      reason: 'not_authenticated',
      message: 'Anmeldung erforderlich.',
      project,
    }
  }

  const sceneId = crypto.randomUUID()
  const meta = input.variant === 'empty_room_2x2'
    ? PRESET_EMPTY_ROOM_2X2
    : PRESET_EMPTY_CANVAS
  const scene = buildSceneFromVariant(sceneId, input)

  let encoded
  try {
    const parametric = serializeParametric({
      scene,
      validation_report: emptyValidationReport(scene.id, new Date().toISOString()),
      source: 'manual',
      fixup_project_id: null,
      fixup_job_id: null,
      metadata: {
        origin: meta.origin,
        preset_variant: input.variant,
        presales_project_id: project.id,
      },
    })
    encoded = await encodeParametricBlob(parametric)
  } catch (err) {
    logError('spatial.manualStart.encode_failed', err, {
      projectId: project.id,
      variant: input.variant,
    })
    return {
      ok: false,
      reason: 'encode_failed',
      message:
        err instanceof Error
          ? err.message
          : 'Aufmaß konnte nicht serialisiert werden.',
      project,
    }
  }

  const parametricPath = buildParametricPath(userId, sceneId, encoded.sha256)
  const uploadResult = await uploadParametricBlob(parametricPath, encoded.bytes)
  if (!uploadResult.ok) {
    logError(
      'spatial.manualStart.upload_failed',
      new Error(uploadResult.error),
      { projectId: project.id, sceneId, variant: input.variant },
    )
    return {
      ok: false,
      reason: 'upload_failed',
      message: uploadResult.error || 'Hochladen fehlgeschlagen.',
      project,
    }
  }

  // spatial_create_manual_scene (B0) — bypasses scan/job authorisation
  // because manual scenes have no scan to authorise against. The RPC checks
  // presales-project ownership server-side.
  const rpc = await supabase.rpc('spatial_create_manual_scene', {
    p_id: sceneId,
    p_presales_project_id: project.id,
    p_parametric_storage_path: parametricPath,
    p_parametric_sha256: encoded.sha256,
    p_parametric_size_bytes: encoded.sizeBytes,
    p_origin: meta.origin,
    p_metadata: {
      preset_variant: input.variant,
    },
    p_schema_version: '1.0',
  })
  if (rpc.error) {
    logError('spatial.manualStart.scene_create_failed', rpc.error, {
      projectId: project.id,
      sceneId,
      variant: input.variant,
    })
    return {
      ok: false,
      reason: 'scene_create_failed',
      message: rpc.error.message || 'Szene konnte nicht angelegt werden.',
      project,
    }
  }

  // Promote the presales row to 'scanned'. Non-fatal: the scene is already
  // in place, so the user can still open the detail screen. A failure here
  // just leaves the row labelled "Entwurf" until the next update kicks it.
  try {
    await getPresalesProjectRepository().update(project.id, {
      status: 'scanned',
      scannedAt: new Date().toISOString(),
    })
  } catch (err) {
    logError('spatial.manualStart.presales_mark_scanned_failed', err, {
      projectId: project.id,
      sceneId,
    })
  }

  logInfo('spatial.manualStart.created', {
    projectId: project.id,
    sceneId,
    variant: input.variant,
    origin: meta.origin,
  })

  return {
    ok: true,
    project,
    sceneId,
    scene,
    parametricPath,
    variant: input.variant,
  }
}

function buildSceneFromVariant(
  sceneId: string,
  input: CreateEmptyRoomProjectInput,
): RoomScene {
  const ceilingHeightM = input.ceilingHeightM ?? 2.5
  if (input.variant === 'empty_canvas') {
    return buildEmptyCanvasPreset({ roomNodeId: sceneId, ceilingHeightM })
  }
  return buildEmptyRoom2x2Preset({
    roomNodeId: sceneId,
    footprintMeters: {
      widthM: input.widthM ?? 2,
      depthM: input.depthM ?? 2,
    },
    ceilingHeightM,
  })
}
