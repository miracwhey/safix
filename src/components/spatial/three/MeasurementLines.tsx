/**
 * Spatial Core · Block E2 · 3D Measurement Lines
 *
 * Renders `ScanMeasurement` rows that have a verified or estimated value
 * AND a `surfaceId`. The line is drawn between the two endpoints supplied
 * via the `surfaceEndpoints` map — the Scene owns the resolve logic so this
 * component stays a pure renderer.
 *
 * For Block E2 the Scene's `collectSurfaceEndpoints` populates the map with
 * each mesh's bounding-box diagonal (min-corner → max-corner) keyed by
 * `mesh.name`. That is a visual placeholder only — Block E3 swaps it for a
 * `scan_surfaces.transform`-driven endpoint pair (proper wall-edge geometry,
 * not the bbox diagonal). Measurements whose `surfaceId` is not in the map
 * are silently skipped, which is the safe default.
 *
 * Estimated measurements draw dashed, verified solid — matching the badge
 * convention from `MeasurementDisplay` (`~` for estimated, clean for
 * verified).
 *
 * Out of scope here:
 *   * Click-to-edit (Block F).
 *   * Floating value-labels (Block E3 — needs HTML overlay positioning).
 */

import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import type { ScanMeasurement } from '../../../lib/spatial/types'

export interface MeasurementSegment {
  measurementId: string
  start: [number, number, number]
  end: [number, number, number]
  verified: boolean
}

export interface MeasurementLinesProps {
  measurements: ScanMeasurement[]
  /** Pre-resolved endpoint XYZ keyed by `surfaceId` — passed from the
   *  caller because the scene owns the mesh + transform lookup. */
  surfaceEndpoints: Record<string, { start: [number, number, number]; end: [number, number, number] }>
  visible: boolean
}

export function MeasurementLines(props: MeasurementLinesProps) {
  const segments = useMemo<MeasurementSegment[]>(() => {
    return props.measurements
      .map(m => {
        if (!m.surfaceId) return null
        const ep = props.surfaceEndpoints[m.surfaceId]
        if (!ep) return null
        return {
          measurementId: m.id,
          start: ep.start,
          end: ep.end,
          verified: m.valueVerifiedM != null,
        }
      })
      .filter((s): s is MeasurementSegment => s !== null)
  }, [props.measurements, props.surfaceEndpoints])

  if (!props.visible) return null

  return (
    <group name="measurement-lines">
      {segments.map(seg => (
        <Line
          key={seg.measurementId}
          points={[seg.start, seg.end]}
          color={seg.verified ? '#34d399' : '#fbbf24'}
          lineWidth={seg.verified ? 2 : 1.4}
          dashed={!seg.verified}
          dashSize={0.08}
          gapSize={0.04}
        />
      ))}
    </group>
  )
}
