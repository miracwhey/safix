/**
 * Spatial · Workflow · canEditPresalesFootprint
 *
 * Single source of truth for "may this provider DRAW + reshape walls in the 2D
 * Grundriss of this presales scene?". Lifted verbatim from the inline gate that
 * shipped in {@link CraftsmanPresalesDetailScreen} so the hub quick-viewer
 * ({@link PresalesMultiModeViewerHost}) and the detail screen can never drift —
 * both call THIS helper. A drift here is a security gap (a stricter detail gate
 * + a looser host gate would arm an unauthorised write path), so the unit test
 * pins all branches.
 *
 * Gate (all must hold):
 *   1. a scene exists + a signed-in user,
 *   2. `origin === 'manual'` — `example_room` templates + `roomplan` scans are
 *      read-only geometry (only the owner-drawn manual room is editable),
 *   3. `scene.providerId === userId` — ownership. This is the workflow-layer
 *      RBAC guard (CLAUDE.md): the write also passes through the RLS
 *      `spatial_can_edit_scene` policy (`provider_id = auth.uid()`), but the
 *      guard belongs here too, not only in RLS.
 *   4. the project is not sealed into a job (`converted` / `archived`),
 *   5. real geometry to reshape — `FloorplanDragLayer` has no draw-from-blank
 *      gesture yet, so a 0-wall `empty_canvas` would open a no-op editor.
 */

import type { PresalesProjectStatus } from '../../../domain/presales/presalesProjectTypes'

/** Minimal structural shape — `SpatialScene` satisfies it, kept narrow so the
 *  unit test can construct fixtures without a full scene record. */
export interface FootprintEditableScene {
  origin: 'roomplan' | 'manual' | 'example_room'
  providerId: string | null
}

export function canEditPresalesFootprint(
  scene: FootprintEditableScene | null | undefined,
  userId: string | null | undefined,
  projectStatus: PresalesProjectStatus | null | undefined,
  wallCount: number,
): boolean {
  if (!scene || !userId) return false
  if (scene.origin !== 'manual') return false
  if (scene.providerId !== userId) return false
  if (projectStatus === 'converted' || projectStatus === 'archived') return false
  if (wallCount < 3) return false
  return true
}
