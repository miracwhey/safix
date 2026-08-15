/**
 * Presales · Workflow · usePresalesDetail (V1.5.1 · Phase L2-E)
 *
 * Resolves a single Pre-Sales-Projekt für die `CraftsmanPresalesDetailScreen`.
 * Mirrors the `useJobSpatialScene` two-phase fetch pattern:
 *
 *   1. Header-Phase (`detailFetch`)
 *      a. PresalesProjectRepository.findById(id)
 *      b. SpatialRepository.listScansForPresalesProject(id) → newest scan
 *      c. SpatialSceneRepository.findBySourceScan(scan.id) → scene
 *   2. Blob-Phase (`blobFetch`)
 *      loadParametricBlob(scene) → hydratierter RoomScene
 *
 * Beide Phasen sind tagged (`projectId` / `sceneId`), damit ein neuer
 * `presalesProjectId` keine stale-Daten der vorherigen Auflösung sieht.
 *
 * `refetch()` bumpt eine Nonce, die einen frischen Header-Pull triggert (z. B.
 * nach einem Re-Scan oder einer Status-Änderung über das Conversion-Modal).
 *
 * Failure-Modell:
 *   - `error`              · Header-Phase-Fehler (Repo-Throw, Project not found
 *                            kommt als `error: 'Aufmaß nicht gefunden.'`)
 *   - `blobState='error'`  · Blob-Hydrierung fehlgeschlagen (Network/Decode)
 *   - `blobState='absent'` · noch kein Scan oder Scene noch nicht renderbar
 *   - `blobState='ready'`  · `roomScene` liegt vor
 *
 * Alle `setState`-Calls laufen in einer asynchronen Continuation
 * (`react-hooks/set-state-in-effect`-clean).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getPresalesProjectRepository } from '../repository/registry'
import { getSpatialRepository } from '../../spatial/repository/registry'
import { getSpatialSceneRepository } from '../../spatial/canonical/repository/registry'
import { loadParametricBlob } from '../../spatial/canonical/storage/loadParametricBlob'
import type { PresalesProject } from '../../../domain/presales/presalesProjectTypes'
import type { Scan } from '../../spatial/types'
import type { SpatialScene } from '../../spatial/canonical/repository/SpatialSceneRepository'
import type { RoomScene } from '../../spatial/canonical/types/scene-graph'
import type { NodeOverride, Variant } from '../../spatial/canonical/types/variants'

/** Parametric-Blob Hydration-Zustand — identisch zur Job-Scene-Variante. */
export type PresalesBlobState = 'absent' | 'loading' | 'ready' | 'error'

export interface PresalesDetailState {
  /** True, solange der Header-Pull (project+scan+scene) läuft. */
  loading: boolean
  /** Hard-Error des Header-Pull (Repo-Throw, project not found, …). */
  error: string | null
  project: PresalesProject | null
  /** Neuester Scan auf dem Pre-Sales-Projekt (Lane-2 Ü-01 Convention). */
  scan: Scan | null
  /** Die `spatial_scenes`-Row des Scans — null bevor promote durchgelaufen ist. */
  scene: SpatialScene | null
  /** Hydratierter Parametric-Blob — null bis Phase 2 settled. */
  roomScene: RoomScene | null
  variants: Variant[]
  overrides: NodeOverride[]
  blobState: PresalesBlobState
  blobError: string | null
  /**
   * Frischen Pull triggern. Drop-in nach einem Re-Scan oder Convert-Modal-
   * Success — bumpt eine Nonce, die `useEffect` neu feuert.
   */
  refetch: () => void
}

interface DetailFetch {
  projectId: string
  project: PresalesProject | null
  scan: Scan | null
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

export function usePresalesDetail(
  presalesProjectId: string | undefined,
): PresalesDetailState {
  const [detailFetch, setDetailFetch] = useState<DetailFetch | null>(null)
  const [blobFetch, setBlobFetch] = useState<BlobFetch | null>(null)
  const [refetchNonce, setRefetchNonce] = useState(0)

  // ── 1 · Header-Pull: project → newest scan → scene ──────────────────────────
  useEffect(() => {
    if (!presalesProjectId) return
    let cancelled = false

    void (async () => {
      try {
        const project = await getPresalesProjectRepository().findById(presalesProjectId)
        if (cancelled) return
        if (!project) {
          setDetailFetch({
            projectId: presalesProjectId,
            project: null,
            scan: null,
            scene: null,
            error: 'Aufmaß nicht gefunden.',
          })
          return
        }
        const scans = await getSpatialRepository().listScansForPresalesProject(
          presalesProjectId,
        )
        if (cancelled) return
        // Repo gibt newest-first zurück — wir picken den ersten.
        const scan = scans[0] ?? null
        let scene: SpatialScene | null = null
        if (scan) {
          scene = await getSpatialSceneRepository().findBySourceScan(scan.id)
          if (cancelled) return
        }
        // Lane-2.5 · Stream B — manual scenes have no scan-row to anchor to,
        // so the scan-keyed lookup above misses them. Fall back to the
        // metadata-anchored lookup before giving up on the scene.
        if (!scene) {
          scene = await getSpatialSceneRepository().findByPresalesProject(
            presalesProjectId,
          )
          if (cancelled) return
        }
        setDetailFetch({
          projectId: presalesProjectId,
          project,
          scan,
          scene,
          error: null,
        })
      } catch (err) {
        if (cancelled) return
        setDetailFetch({
          projectId: presalesProjectId,
          project: null,
          scan: null,
          scene: null,
          error:
            err instanceof Error ? err.message : 'Aufmaß konnte nicht geladen werden.',
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [presalesProjectId, refetchNonce])

  // ── 2 · Blob-Hydrierung ─────────────────────────────────────────────────────
  useEffect(() => {
    const scene =
      detailFetch && detailFetch.projectId === presalesProjectId
        ? detailFetch.scene
        : null
    if (!scene || !scene.isRenderable) return
    let cancelled = false

    void (async () => {
      try {
        const result = await loadParametricBlob(scene)
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
      } catch (err) {
        if (cancelled) return
        setBlobFetch({
          sceneId: scene.id,
          roomScene: null,
          variants: EMPTY_VARIANTS,
          overrides: EMPTY_OVERRIDES,
          error:
            err instanceof Error ? err.message : 'Aufmaß konnte nicht geladen werden.',
          absent: false,
        })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [detailFetch, presalesProjectId])

  const refetch = useCallback(() => {
    // Drop caches so Consumer wieder Loading sehen.
    setDetailFetch(null)
    setBlobFetch(null)
    setRefetchNonce((n) => n + 1)
  }, [])

  return useMemo<PresalesDetailState>(() => {
    if (!presalesProjectId) {
      return {
        loading: false,
        error: 'Kein Aufmaß angegeben.',
        project: null,
        scan: null,
        scene: null,
        roomScene: null,
        variants: EMPTY_VARIANTS,
        overrides: EMPTY_OVERRIDES,
        blobState: 'absent',
        blobError: null,
        refetch,
      }
    }

    const detailForProject =
      detailFetch && detailFetch.projectId === presalesProjectId ? detailFetch : null
    const scene = detailForProject?.scene ?? null
    const blobForScene =
      scene && blobFetch && blobFetch.sceneId === scene.id ? blobFetch : null

    let blobState: PresalesBlobState
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
      loading: detailForProject === null,
      error: detailForProject?.error ?? null,
      project: detailForProject?.project ?? null,
      scan: detailForProject?.scan ?? null,
      scene,
      roomScene: blobForScene?.roomScene ?? null,
      variants: blobForScene?.variants ?? EMPTY_VARIANTS,
      overrides: blobForScene?.overrides ?? EMPTY_OVERRIDES,
      blobState,
      blobError: blobForScene?.error ?? null,
      refetch,
    }
  }, [presalesProjectId, detailFetch, blobFetch, refetch])
}
