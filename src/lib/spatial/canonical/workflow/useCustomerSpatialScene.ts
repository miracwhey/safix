/**
 * Spatial · Canonical · Workflow · useCustomerSpatialScene (V1.6.1 Phase 3b)
 *
 * Customer-Variante von `useJobSpatialScene`. Resolved den canonical Scene-
 * Header für einen Customer-Scan + hydratisiert das parametric.json-Blob in
 * eine renderbare `RoomScene` — Voraussetzung für `<CanonicalSceneRoot>` im
 * Customer-3D-Hub (Mockup 02 v8 · 3-Modi-Switcher).
 *
 * Pipeline:
 *   1. `findBySourceScan(scanId)` — Scene-Header für den aktiven Scan. RLS
 *      filtert serverseitig (Customer sieht eigene + HW-shared Scans über
 *      `spatial_can_view_scene`).
 *   2. `loadParametricBlob(scene)` — gzip-Blob download + SHA-verify +
 *      schema-migrate + deserialize → `{ roomScene, variants, overrides }`.
 *
 * `blobState` decoupled von `loading` damit Switcher und Viewer ihre eigenen
 * Lifecycle-Zustände rendern können (Switcher-Locked → loading → ready).
 *
 * Customer-LiDAR-Scans die vor V1.6.1 Phase 3b angelegt wurden haben kein
 * `parametric_storage_path` — der Hook resolved dann `scene === null` und
 * der Hub locked die 3-Modi mit ehrlichem Toast.
 *
 * Direct import path (not via spatial workflow barrel) — see
 * `feedback_spatial_barrel_no_session_imports`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getSpatialSceneRepository } from '../repository/registry.ts'
import type { SpatialScene } from '../repository/SpatialSceneRepository.ts'
import { loadParametricBlob } from '../storage/loadParametricBlob.ts'
import type { RoomScene } from '../types/scene-graph.ts'
import type { NodeOverride, Variant } from '../types/variants.ts'

/** Parametric-blob hydration lifecycle. */
export type SpatialBlobState = 'absent' | 'loading' | 'ready' | 'error'

export interface CustomerSpatialSceneState {
  loading: boolean
  error: string | null
  scene: SpatialScene | null
  roomScene: RoomScene | null
  variants: Variant[]
  overrides: NodeOverride[]
  blobState: SpatialBlobState
  blobError: string | null
  /** Force a fresh scene-header + blob hydration (nach Re-Scan / Self-Scan-Success). */
  refetch: () => void
}

interface SceneFetch {
  scanId: string
  scene: SpatialScene | null
  error: string | null
}

interface BlobFetch {
  sceneId: string
  roomScene: RoomScene | null
  variants: Variant[]
  overrides: NodeOverride[]
  error: string | null
  absent: boolean
}

const EMPTY_VARIANTS: Variant[] = []
const EMPTY_OVERRIDES: NodeOverride[] = []

export function useCustomerSpatialScene(
  scanId: string | null,
): CustomerSpatialSceneState {
  const [sceneFetch, setSceneFetch] = useState<SceneFetch | null>(null)
  const [blobFetch, setBlobFetch] = useState<BlobFetch | null>(null)
  const [refetchNonce, setRefetchNonce] = useState(0)

  // 1 · Scene-Header für aktiven Scan resolven. `await Promise.resolve()`
  //     upfront pusht alle setState-Aufrufe off den synchronen Render-Path
  //     (react-hooks/set-state-in-effect) — gleiche Lesson wie
  //     useCustomerActiveScanGltf.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      await Promise.resolve()
      if (cancelled) return
      if (!scanId) {
        setSceneFetch(null)
        setBlobFetch(null)
        return
      }
      try {
        const found = await getSpatialSceneRepository().findBySourceScan(scanId)
        if (!cancelled) setSceneFetch({ scanId, scene: found, error: null })
      } catch (err: unknown) {
        if (cancelled) return
        setSceneFetch({
          scanId,
          scene: null,
          error:
            err instanceof Error
              ? err.message
              : 'Szene konnte nicht geladen werden',
        })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [scanId, refetchNonce])

  const refetch = useCallback(() => {
    setSceneFetch(null)
    setBlobFetch(null)
    setRefetchNonce((n) => n + 1)
  }, [])

  // 2 · parametric.json laden sobald Scene bekannt + renderbar.
  useEffect(() => {
    const scene =
      sceneFetch && sceneFetch.scanId === scanId ? sceneFetch.scene : null
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
          error:
            err instanceof Error
              ? err.message
              : 'Aufmaß konnte nicht geladen werden',
          absent: false,
        })
      })
    return () => {
      cancelled = true
    }
  }, [sceneFetch, scanId])

  return useMemo<CustomerSpatialSceneState>(() => {
    if (!scanId) {
      return {
        loading: false,
        error: null,
        scene: null,
        roomScene: null,
        variants: EMPTY_VARIANTS,
        overrides: EMPTY_OVERRIDES,
        blobState: 'absent',
        blobError: null,
        refetch,
      }
    }

    const sceneForScan =
      sceneFetch && sceneFetch.scanId === scanId ? sceneFetch : null
    const scene = sceneForScan?.scene ?? null

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
      loading: sceneForScan === null,
      error: sceneForScan?.error ?? null,
      scene,
      roomScene: blobForScene?.roomScene ?? null,
      variants: blobForScene?.variants ?? EMPTY_VARIANTS,
      overrides: blobForScene?.overrides ?? EMPTY_OVERRIDES,
      blobState,
      blobError: blobForScene?.error ?? null,
      refetch,
    }
  }, [scanId, sceneFetch, blobFetch, refetch])
}
