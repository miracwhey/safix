/**
 * Spatial · Canonical · Workflow · useJobSpatialScene (Phase B · B-2 → Phase C · C-2)
 *
 * Resolves the spatial scene attached to a job for the Provider
 * Job-Spatial-Detail shell, and hydrates its parametric blob into a
 * renderable `RoomScene`.
 *
 * Phase C (C-2):
 *   - The scene header row is fetched via `findBySourceJob` (Seam 11) —
 *     replaces the Phase-B `listByProviderOrg` + client-side `.find()`. RLS on
 *     `spatial_scenes` enforces org-scoping, so no provider-org id is needed
 *     in this hook any more.
 *   - The parametric blob is downloaded + decoded into a `RoomScene` via
 *     `loadParametricBlob` (Seam 2). `roomScene` / `variants` / `overrides`
 *     are surfaced for the 3D viewer; `blobState` tracks that hydration
 *     independently of the header-row `loading`.
 *
 * Every `setState` runs inside an async continuation (never synchronously in
 * an effect body) so the hook stays `react-hooks/set-state-in-effect`-clean.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJobById } from '../../../jobs/jobsStore.ts'
import type { Job } from '../../../jobs/types.ts'
import { getSpatialSceneRepository } from '../repository/registry.ts'
import type { SpatialScene } from '../repository/SpatialSceneRepository.ts'
import { loadParametricBlob } from '../storage/loadParametricBlob.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type { NodeOverride, Variant } from '../types/variants.ts'

/** Parametric-blob hydration lifecycle. */
export type SpatialBlobState = 'absent' | 'loading' | 'ready' | 'error'

export interface JobSpatialSceneState {
  /** True while the scene header-row query is in flight. */
  loading: boolean
  error: string | null
  job: Job | null
  /** The job's spatial scene header row; null when the job has no scan. */
  scene: SpatialScene | null
  /** Hydrated parametric scene-graph; null until the blob is decoded. */
  roomScene: RoomScene | null
  /** Variant chain from the blob — empty until hydrated. */
  variants: Variant[]
  /** Override stack from the blob — empty until hydrated. */
  overrides: NodeOverride[]
  /** Blob-hydration lifecycle, distinct from `loading`. */
  blobState: SpatialBlobState
  /** Blob-load error message when `blobState === 'error'`. */
  blobError: string | null
  /**
   * Force a fresh scene header + blob hydration round. Call after a write
   * that produced a new scene for this job (B9 worker-walk capture) so the
   * screen lifts out of its empty state without a full page reload.
   */
  refetch: () => void
}

/** A settled scene-header fetch, tagged with the job it answers. */
interface SceneFetch {
  jobId: string
  scene: SpatialScene | null
  error: string | null
}

/** A settled blob hydration, tagged with the scene it answers. */
interface BlobFetch {
  sceneId: string
  roomScene: RoomScene | null
  variants: Variant[]
  overrides: NodeOverride[]
  /** Error message, or null on success / clean "not uploaded yet" absence. */
  error: string | null
  /** True when the blob is genuinely missing (not uploaded) — a clean absence. */
  absent: boolean
}

const EMPTY_VARIANTS: Variant[] = []
const EMPTY_OVERRIDES: NodeOverride[] = []

export function useJobSpatialScene(jobId: string | undefined): JobSpatialSceneState {
  const [sceneFetch, setSceneFetch] = useState<SceneFetch | null>(null)
  const [blobFetch, setBlobFetch] = useState<BlobFetch | null>(null)
  // Bumping this nonce forces a fresh scene-header fetch (the blob fetch
  // follows through the existing effect chain). Used by `refetch()` so a
  // caller that just produced a new scene (B9) can lift the screen out of
  // its empty state without a full page reload.
  const [refetchNonce, setRefetchNonce] = useState(0)

  const job = useMemo(() => (jobId ? (getJobById(jobId) ?? null) : null), [jobId])

  // ── 1 · Resolve the scene header row for this job ──────────────────────────
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    getSpatialSceneRepository()
      .findBySourceJob(jobId)
      .then((found) => {
        if (!cancelled) setSceneFetch({ jobId, scene: found, error: null })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setSceneFetch({
          jobId,
          scene: null,
          error: err instanceof Error ? err.message : 'Szene konnte nicht geladen werden',
        })
      })
    return () => {
      cancelled = true
    }
  }, [jobId, refetchNonce])

  const refetch = useCallback(() => {
    // Drop the cached scene so consumers see `loading` until the new fetch
    // settles — symmetric with the initial mount.
    setSceneFetch(null)
    setBlobFetch(null)
    setRefetchNonce((n) => n + 1)
  }, [])

  // ── 2 · Hydrate the parametric blob once a renderable scene is known ───────
  useEffect(() => {
    // The scene-fetch is only valid for the job it was issued for — ignore a
    // stale result from a previous jobId.
    const scene = sceneFetch && sceneFetch.jobId === jobId ? sceneFetch.scene : null
    if (!scene || !scene.isRenderable) return
    let cancelled = false
    loadParametricBlob(scene)
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setBlobFetch({
            sceneId: scene.id,
            roomScene: result.scene,
            variants: result.variants,
            overrides: result.overrides,
            error: null,
            absent: false,
          })
        } else if (result.reason === 'not_found') {
          // A renderable scene whose blob is not uploaded yet — a clean
          // absence (the 3D tab shows its "model preparing" state), not an
          // error.
          setBlobFetch({
            sceneId: scene.id,
            roomScene: null,
            variants: EMPTY_VARIANTS,
            overrides: EMPTY_OVERRIDES,
            error: null,
            absent: true,
          })
        } else {
          setBlobFetch({
            sceneId: scene.id,
            roomScene: null,
            variants: EMPTY_VARIANTS,
            overrides: EMPTY_OVERRIDES,
            error: result.message,
            absent: false,
          })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setBlobFetch({
          sceneId: scene.id,
          roomScene: null,
          variants: EMPTY_VARIANTS,
          overrides: EMPTY_OVERRIDES,
          error: err instanceof Error ? err.message : 'Aufmaß konnte nicht geladen werden',
          absent: false,
        })
      })
    return () => {
      cancelled = true
    }
  }, [sceneFetch, jobId])

  return useMemo<JobSpatialSceneState>(() => {
    if (!jobId) {
      return {
        loading: false,
        error: 'Kein Job angegeben',
        job: null,
        scene: null,
        roomScene: null,
        variants: EMPTY_VARIANTS,
        overrides: EMPTY_OVERRIDES,
        blobState: 'absent',
        blobError: null,
        refetch,
      }
    }

    const sceneForJob = sceneFetch && sceneFetch.jobId === jobId ? sceneFetch : null
    const scene = sceneForJob?.scene ?? null

    // Blob hydration only applies to the current scene's fetch.
    const blobForScene =
      scene && blobFetch && blobFetch.sceneId === scene.id ? blobFetch : null

    let blobState: SpatialBlobState
    if (!scene || !scene.isRenderable) {
      blobState = 'absent'
    } else if (blobForScene === null) {
      blobState = 'loading'
    } else if (blobForScene.roomScene) {
      blobState = 'ready'
    } else if (blobForScene.absent) {
      blobState = 'absent'
    } else {
      blobState = 'error'
    }

    return {
      loading: sceneForJob === null,
      error: sceneForJob?.error ?? null,
      job,
      scene,
      roomScene: blobForScene?.roomScene ?? null,
      variants: blobForScene?.variants ?? EMPTY_VARIANTS,
      overrides: blobForScene?.overrides ?? EMPTY_OVERRIDES,
      blobState,
      blobError: blobForScene?.error ?? null,
      refetch,
    }
  }, [jobId, sceneFetch, blobFetch, job, refetch])
}
