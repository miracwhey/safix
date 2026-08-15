/**
 * Spatial · Canonical · Workflow · buildAufmassSnapshot
 *
 * Pure logic — zero React, zero side-effects.
 *
 * Builds the compact, render-ready {@link SpatialAufmassSnapshot} that a
 * Spatial-Offer carries on `spatial_metadata.aufmass` so the Offer-PDF can draw
 * the floor-plan (jsPDF vector lines) + a measurement table without re-loading
 * the scene. Reuses the Block-1 surface/perimeter helpers so the figures match
 * the BoM exactly (net wall area, skirting length, room metrics).
 */

import type { RoomScene } from '../types/scene-graph.ts'
import type {
  SpatialAufmassSnapshot,
  SpatialAufmassMeasurement,
} from '../../../offers/types'
import {
  computeBomPlan,
  computeWallSurfaceArea,
  computeFloorPerimeterForBom,
} from './bomAutoItems.ts'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function buildAufmassSnapshot(scene: RoomScene): SpatialAufmassSnapshot {
  const plan = computeBomPlan(scene)
  const peri = computeFloorPerimeterForBom(scene.floor.polygon, scene.walls)

  const measurements: SpatialAufmassMeasurement[] = [
    {
      label: 'Bodenfläche',
      kind: 'floor',
      unit: 'm2',
      value: round2(scene.computed_area_m2),
    },
  ]

  if (peri.skirtingM > 0) {
    measurements.push({
      label: 'Sockelleiste',
      kind: 'skirting',
      unit: 'lfm',
      value: peri.skirtingM,
    })
  }

  scene.walls.forEach((wall, idx) => {
    const area = computeWallSurfaceArea(wall)
    measurements.push({
      label: wall.name ?? `Wand ${idx + 1}`,
      kind: 'wall',
      unit: 'm2',
      value: area.netM2,
      grossM2: area.grossM2,
      openingsM2: area.openingsM2,
    })
  })

  return {
    floorPolygon: plan.floorPolygon.map((p) => ({ xPct: round2(p.xPct), yPct: round2(p.yPct) })),
    areaM2: round2(scene.computed_area_m2),
    volumeM3: round2(scene.computed_volume_m3),
    ceilingHeightM: round2(scene.ceiling.height_m),
    wallCount: scene.walls.length,
    perimeterM: peri.perimeterM,
    measurements,
  }
}
