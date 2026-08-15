/**
 * Spatial · Hooks · useSpatialEditPermissions (Phase 2 · Block 2.10)
 *
 * A thin React adapter over the pure workflow-layer guard in
 * `workflow/spatialEditPermissions.ts`. The hook adds NO policy of its own —
 * it only:
 *   1. reads the live SaFix session via {@link useSession},
 *   2. reads the canonical scene's variant list from the scene store,
 *   3. projects both onto the guard's pure inputs,
 *   4. memoises the writable-variant id + a per-variant classifier.
 *
 * All authorization decisions stay in the pure guard so they remain unit-
 * testable without React. Components consume this hook; the edit-mode host
 * feeds `writableVariantId` straight into every constructed command.
 */

import { useMemo } from 'react'

import { useSession } from '../../../hooks/useSession'
import { useCanonicalSceneStore } from '../canonical/store/sceneStore'
import type { VariantId } from '../canonical/types/variants'
import {
  classifyVariantAccess,
  resolveWritableVariantId,
  toSpatialEditUser,
  type SpatialEditScene,
  type SpatialEditUser,
  type VariantAccess,
} from '../workflow/spatialEditPermissions'

export interface SpatialEditPermissions {
  /** The guard's view of the current caller. */
  user: SpatialEditUser
  /**
   * The ONE variant id the current user may write on this scene — `null`
   * when the user has no writable layer (signed out / role with no rights).
   * Commands MUST be constructed with this id, never the active variant id.
   */
  writableVariantId: VariantId | null
  /** `true` when the user has any writable layer (edit-mode is permitted). */
  canEdit: boolean
  /** Classify one variant for the current user — drives the pencil/eye UI. */
  accessOf: (variantId: VariantId) => VariantAccess
}

/**
 * Resolve the current user's spatial-edit permissions against the live
 * canonical scene. Re-computes only when the session or the scene's variant
 * set changes.
 */
export function useSpatialEditPermissions(): SpatialEditPermissions {
  const session = useSession()
  const variants = useCanonicalSceneStore((s) => s.variants)

  // Project the session onto the guard's pure user shape. Keyed on the three
  // fields the guard actually reads so a token-refresh that leaves identity
  // unchanged does not churn the memo.
  const user = useMemo<SpatialEditUser>(
    () => toSpatialEditUser(session),
    [session],
  )

  const scene = useMemo<SpatialEditScene>(
    () => ({ variantIds: variants.map((v) => v.id) }),
    [variants],
  )

  const writableVariantId = useMemo(
    () => resolveWritableVariantId(user),
    [user],
  )

  const accessOf = useMemo(
    () => (variantId: VariantId) => classifyVariantAccess(user, scene, variantId),
    [user, scene],
  )

  return useMemo(
    () => ({
      user,
      writableVariantId,
      canEdit: writableVariantId !== null,
      accessOf,
    }),
    [user, writableVariantId, accessOf],
  )
}
