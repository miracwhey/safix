/**
 * Spatial · Canonical · Workflow · usePinReviews (Phase C · C-6 · Seam 13)
 *
 * React hook backing pin-review persistence. Phase B left the Pins-tab
 * accept / reject / trust-all actions as pure haptics with no persistence
 * target. This hook loads the `spatial_pin_reviews` rows for a scene, exposes
 * a `nodeId → review-state` map, and writes reviews back through the
 * repository.
 *
 * Result contract: `review` / `reviewMany` / `retract` resolve to a boolean —
 * `true` only when EVERY targeted write actually persisted. They never reject.
 * A silent precondition early-return resolves `false`; a partial bulk failure
 * still runs `reload()` (so the UI reflects the rows that DID persist) and
 * resolves `false`. The caller must gate any "done"/advance UX on the boolean
 * rather than on the promise merely resolving.
 *
 * All `setState` runs in async continuations (never synchronously in an
 * effect body) so the hook stays `react-hooks/set-state-in-effect`-clean.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSpatialSceneRepository } from '../repository/registry.ts'
import type { PinReview, PinReviewStatus } from '../repository/SpatialSceneRepository.ts'
import type { PinReviewState } from './annotationGrouping.ts'

/** Map the persisted `trusted|flagged` status onto the display review state. */
function statusToState(status: PinReviewStatus): PinReviewState {
  return status === 'trusted' ? 'approved' : 'rejected'
}

export interface PinReviewsApi {
  /** annotationNodeId → review state. A node absent from the map is pending. */
  states: ReadonlyMap<string, PinReviewState>
  /** True while the initial review list is loading. */
  loading: boolean
  /** True while a review write is in flight. */
  busy: boolean
  /** True when the current user may write reviews (owner / worker, org known). */
  canReview: boolean
  /** Persist a review for one pin. Resolves `true` when the write persisted. */
  review: (annotationNodeId: string, status: PinReviewStatus) => Promise<boolean>
  /** Persist a review for many pins (trust-all). `true` when ALL persisted. */
  reviewMany: (annotationNodeIds: string[], status: PinReviewStatus) => Promise<boolean>
  /** Retract a review — the pin returns to 'pending'. `true` when persisted. */
  retract: (annotationNodeId: string) => Promise<boolean>
}

export function usePinReviews(
  sceneId: string,
  providerOrgId: string | null,
  reviewerUserId: string | null,
  reviewerRole: 'owner' | 'worker' | null,
): PinReviewsApi {
  const [reviews, setReviews] = useState<PinReview[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  /** Synchronous in-flight guard — closes the double-submit race a `busy`
   *  state dependency leaves open (two actions in one render frame). */
  const inFlightRef = useRef(false)

  const canReview =
    providerOrgId !== null && reviewerUserId !== null && reviewerRole !== null

  useEffect(() => {
    let cancelled = false
    getSpatialSceneRepository()
      .listPinReviews(sceneId)
      .then((rows) => {
        if (cancelled) return
        setReviews(rows)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sceneId])

  const reload = useCallback(async () => {
    setReviews(await getSpatialSceneRepository().listPinReviews(sceneId))
  }, [sceneId])

  const reviewMany = useCallback(
    async (annotationNodeIds: string[], status: PinReviewStatus): Promise<boolean> => {
      if (!canReview || inFlightRef.current || annotationNodeIds.length === 0) return false
      if (providerOrgId === null || reviewerUserId === null || reviewerRole === null) return false
      inFlightRef.current = true
      setBusy(true)

      let allOk = true
      try {
        const repo = getSpatialSceneRepository()
        for (const annotationNodeId of annotationNodeIds) {
          try {
            await repo.upsertPinReview({
              sceneId,
              providerOrgId,
              annotationNodeId,
              reviewedByUserId: reviewerUserId,
              reviewedByRole: reviewerRole,
              reviewStatus: status,
            })
          } catch {
            // Record the partial failure but keep going — the pins that DO
            // persist must still land, and `reload()` below reflects them.
            allOk = false
          }
        }
      } finally {
        // Always reconcile: a partial bulk failure must still show the rows
        // that persisted, otherwise the UI silently lies about review state.
        try {
          await reload()
        } catch {
          /* next mount / realtime reconciles */
        }
        inFlightRef.current = false
        setBusy(false)
      }
      return allOk
    },
    [canReview, sceneId, providerOrgId, reviewerUserId, reviewerRole, reload],
  )

  const review = useCallback(
    (annotationNodeId: string, status: PinReviewStatus): Promise<boolean> =>
      reviewMany([annotationNodeId], status),
    [reviewMany],
  )

  const retract = useCallback(
    async (annotationNodeId: string): Promise<boolean> => {
      if (!canReview || inFlightRef.current || providerOrgId === null) return false
      inFlightRef.current = true
      setBusy(true)

      let ok = true
      try {
        await getSpatialSceneRepository().deletePinReview(
          sceneId,
          annotationNodeId,
          providerOrgId,
        )
      } catch {
        ok = false
      } finally {
        try {
          await reload()
        } catch {
          /* next mount / realtime reconciles */
        }
        inFlightRef.current = false
        setBusy(false)
      }
      return ok
    },
    [canReview, sceneId, providerOrgId, reload],
  )

  const states = useMemo(() => {
    const map = new Map<string, PinReviewState>()
    for (const r of reviews) map.set(r.annotationNodeId, statusToState(r.reviewStatus))
    return map
  }, [reviews])

  return { states, loading, busy, canReview, review, reviewMany, retract }
}
