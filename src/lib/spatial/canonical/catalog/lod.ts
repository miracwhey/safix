/**
 * Spatial · Canonical · Catalog · Level-of-Detail
 *
 * LOD strategy for catalog assets (asset-source-map §7). Real GLB models ship
 * three decimated variants; the renderer steps between them by camera
 * distance. Procedural box-placeholders are already trivially cheap and use a
 * single level.
 *
 * Pure L1 — distance maths + path derivation only, no three.js.
 */

import type { LODLevel } from '../types/asset.ts'

/** Camera-distance breakpoints (meters) between the three LOD bands. */
export const LOD_DISTANCE_THRESHOLDS = Object.freeze({
  /** LOD0 (full detail) is used up to this distance. */
  lod0MaxM: 2,
  /** LOD1 (reduced) is used up to this distance; LOD2 beyond. */
  lod1MaxM: 8,
})

/** Decimation ratio of each reduced LOD relative to LOD0's triangle count. */
export const LOD_DECIMATION_RATIO = Object.freeze({
  lod1: 0.25,
  lod2: 0.08,
})

/**
 * `distance_m_max` of the farthest LOD band — a large FINITE sentinel, not
 * `Infinity`. `JSON.stringify(Infinity)` is `null`, which would desync the
 * InMemory catalog (Infinity) from the Supabase catalog (null) and break the
 * non-null `LODLevel.distance_m_max` type. 1e6 m is unreachable in any room.
 */
export const LOD_FAR_DISTANCE_M = 1_000_000

export type LodLevel = 0 | 1 | 2

/** Pick the LOD band for a camera distance (asset-source-map §7). */
export function selectLodLevel(cameraDistanceM: number): LodLevel {
  // A non-finite distance (NaN / Infinity) → cheapest band.
  if (!Number.isFinite(cameraDistanceM)) return 2
  if (cameraDistanceM <= LOD_DISTANCE_THRESHOLDS.lod0MaxM) return 0
  if (cameraDistanceM <= LOD_DISTANCE_THRESHOLDS.lod1MaxM) return 1
  return 2
}

/**
 * Derive the storage path of a decimated LOD variant from the LOD0 path:
 * `models/foo.glb` → `models/foo-lod1.glb`. LOD0 returns the path unchanged.
 */
export function lodGlbPath(gltf0Path: string, level: LodLevel): string {
  if (level === 0) return gltf0Path
  const slash = gltf0Path.lastIndexOf('/')
  const dot = gltf0Path.lastIndexOf('.')
  // Only treat a dot as the extension when it sits in the file component —
  // a dotted directory (`v1.2/foo`) must not be split.
  if (dot <= slash) return `${gltf0Path}-lod${level}`
  return `${gltf0Path.slice(0, dot)}-lod${level}${gltf0Path.slice(dot)}`
}

/**
 * Build the 3-entry {@link LODLevel} profile for a GLB asset from its LOD0
 * path + LOD0 triangle budget. Procedural placeholders skip this — they pass
 * a single-level profile or none at all.
 */
export function buildLodProfile(gltf0Path: string, polycountLod0: number): LODLevel[] {
  return [
    {
      level: 0,
      glb_url: lodGlbPath(gltf0Path, 0),
      poly_count: polycountLod0,
      distance_m_max: LOD_DISTANCE_THRESHOLDS.lod0MaxM,
    },
    {
      level: 1,
      glb_url: lodGlbPath(gltf0Path, 1),
      poly_count: Math.round(polycountLod0 * LOD_DECIMATION_RATIO.lod1),
      distance_m_max: LOD_DISTANCE_THRESHOLDS.lod1MaxM,
    },
    {
      level: 2,
      glb_url: lodGlbPath(gltf0Path, 2),
      poly_count: Math.round(polycountLod0 * LOD_DECIMATION_RATIO.lod2),
      distance_m_max: LOD_FAR_DISTANCE_M,
    },
  ]
}
