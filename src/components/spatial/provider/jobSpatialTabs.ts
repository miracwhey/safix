/**
 * Provider Job-Spatial-Detail · 5-tab shell definitions (Phase B · B-2).
 * The shell (Mockup 20) and tabs 21-24 share this tab vocabulary.
 *
 * Phase C (C-2): the shared tab props now also carry the hydrated parametric
 * scene (`roomScene` / `variants` / `overrides`) and its load lifecycle so the
 * 3D / BoM / Compare tabs render from real geometry, not a stub.
 */

import type { Job } from '../../../lib/jobs/types'
import type { SpatialScene } from '../../../lib/spatial/canonical/repository/SpatialSceneRepository'
import type { SpatialBlobState } from '../../../lib/spatial/canonical/workflow/useJobSpatialScene'
import type { RoomScene } from '../../../lib/spatial/canonical/types/scene-graph'
import type { NodeOverride, Variant } from '../../../lib/spatial/canonical/types/variants'

/** Props every Job-Spatial-Detail tab component receives from the shell. */
export interface JobSpatialTabProps {
  job: Job
  scene: SpatialScene
  /** Hydrated parametric scene-graph; null until the blob is decoded (C-2). */
  roomScene: RoomScene | null
  /** Variant chain from the parametric blob — empty until hydrated. */
  variants: Variant[]
  /** Override stack from the parametric blob — empty until hydrated. */
  overrides: NodeOverride[]
  /** Blob-hydration lifecycle, distinct from the shell's header-row load. */
  blobState: SpatialBlobState
  /** Human-readable blob-load error when `blobState === 'error'`. */
  blobError: string | null
  /**
   * Retry the parametric-blob hydration (F-10 / F-11). Surfaces a button in
   * the 3D tab's loading-very-slow state and in the error state so the user
   * doesn't have to leave + re-enter the screen to recover from a single
   * stalled fetch. Optional — tabs without a retry-capable hook stay silent.
   */
  onRetry?: () => void
  /**
   * Switch the Job-Spatial-Detail shell to another tab. Phase C (C-5):
   * taking a customer measurement correction routes the provider to the
   * Stückliste tab to re-check the affected positions.
   */
  onSelectTab: (tab: JobSpatialTabKey) => void
}

export type JobSpatialTabKey = '3d' | 'bom' | 'pins' | 'compare' | 'rescan'

export interface JobSpatialTabDef {
  key: JobSpatialTabKey
  label: string
}

export const JOB_SPATIAL_TABS: JobSpatialTabDef[] = [
  { key: '3d', label: '3D-Modell' },
  { key: 'bom', label: 'Stückliste' },
  { key: 'pins', label: 'Pins' },
  { key: 'compare', label: 'Vergleich' },
  { key: 'rescan', label: 'Re-Scan' },
]

/** Narrow an untrusted `?tab=` query value to a valid tab key. */
export function parseJobSpatialTab(raw: string | null): JobSpatialTabKey {
  return JOB_SPATIAL_TABS.some((t) => t.key === raw) ? (raw as JobSpatialTabKey) : '3d'
}
