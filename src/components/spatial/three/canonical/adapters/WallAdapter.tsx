/**
 * Spatial · Canonical · Adapters · WallAdapter (Zwischen-Latte · A-2)
 *
 * Renders a single canonical `Wall` as a MITERED wall body — replacing the
 * Day-11 `BoxGeometry`. The geometry is derived purely:
 *
 *   wall + WallJoinGraph
 *     → buildWallProfile        (L1 · mitered footprint + micro-bevel)
 *     → extrudeWallProfile      (L1 · footprint lofted by height)
 *     → proceduralMeshToBufferGeometry  (L3 · GPU buffer)
 *
 * The footprint is world-space, so the wall body mesh renders in an identity
 * frame. Openings + wall-mounted objects still need the wall-local frame
 * (centerline along +X), so they stay in a nested translated/rotated group —
 * their coordinate maths is unchanged from Day 11.
 *
 * A co-planar `EdgesGeometry` line layer gives the clean stylized corner/knee
 * outline (corners-edges-design §3.4); the wall material runs `polygonOffset`
 * so the lines never z-fight.
 *
 * Override-polygon walls (iOS 17+ irregular) and zero-length walls have no
 * mitered footprint — the adapter falls back to the Day-11 `BoxGeometry` so
 * such walls still render.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { BoxGeometry, BufferGeometry, EdgesGeometry, type Group } from 'three'

import type { Wall } from '../../../../../lib/spatial/canonical/types/geometry.ts'
import type { WallJoinGraph } from '../../../../../lib/spatial/canonical/geometry/wall-joins.ts'
import { buildWallProfile, extrudeWallProfile } from '../../../../../lib/spatial/canonical/geometry/wall-profile.ts'
import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore.ts'

import { OpeningAdapter, type OpeningRenderMode } from './OpeningAdapter'
import { ObjectAdapter } from './ObjectAdapter'
import { SurfaceMaterial } from '../materials/SurfaceMaterial.tsx'
import { ensureUv2 } from '../materials/surfaceMaterialHooks.ts'
import { proceduralMeshToBufferGeometry } from '../geometry/proceduralMeshToBufferGeometry.ts'
import { wallCSGGeometry } from '../geometry/wallCSGGeometry.ts'
import { PickProxy } from '../PickProxy'

/** Threshold angle (deg) for the EdgesGeometry knee/silhouette extraction. */
const EDGE_THRESHOLD_DEG = 25

interface WallAdapterProps {
  wall: Wall
  /** Derived corner-join topology for the whole room (built once upstream). */
  joinGraph: WallJoinGraph
}

export function WallAdapter({ wall, joinGraph }: WallAdapterProps): ReactElement {
  const length = Math.hypot(
    wall.end_point.x - wall.start_point.x,
    wall.end_point.z - wall.start_point.z,
  )
  const midX = (wall.start_point.x + wall.end_point.x) / 2
  const midZ = (wall.start_point.z + wall.end_point.z) / 2
  const angle = Math.atan2(
    wall.end_point.z - wall.start_point.z,
    wall.end_point.x - wall.start_point.x,
  )
  const cy = wall.base_height_m + wall.height_m / 2

  // Hybrid routing for the wall body:
  //   - openings present → real CSG holes (`wallCSGGeometry`),
  //   - no openings      → plain mitered footprint loft,
  //   - no mitered footprint (override / zero-length) → centered-box fallback
  //     in the wall-local frame, openings painted as decals.
  const { geom, worldSpace, openingMode } = useMemo((): {
    geom: BufferGeometry
    worldSpace: boolean
    openingMode: OpeningRenderMode
  } => {
    if (wall.openings.length > 0) {
      const csg = wallCSGGeometry(wall, joinGraph)
      if (csg) return { geom: csg, worldSpace: true, openingMode: 'csg' }
    } else {
      const spec = buildWallProfile(wall, joinGraph)
      if (spec.footprint.length >= 3) {
        const g = proceduralMeshToBufferGeometry(extrudeWallProfile(spec))
        ensureUv2(g)
        return { geom: g, worldSpace: true, openingMode: 'decal' }
      }
    }
    // Fallback: override / zero-length wall — keep the Day-11 box so the wall
    // still renders; any openings fall back to flush-rectangle decals.
    const box = new BoxGeometry(length, wall.height_m, wall.thickness_m)
    ensureUv2(box)
    return { geom: box, worldSpace: false, openingMode: 'decal' }
  }, [wall, joinGraph, length])

  // EdgesGeometry owns a GPU buffer; rebuild + dispose with the wall geometry.
  const edges = useMemo(() => new EdgesGeometry(geom, EDGE_THRESHOLD_DEG), [geom])

  // ── B-5 · section visibility ───────────────────────────────────────────
  // The wall's whole group is hidden when the user toggled it off, or — in
  // dollhouse mode — when it sits between the orbiting camera and the room
  // interior (front-wall auto-hide). `useFrame` owns `.visible`; a store
  // change pokes the demand loop so the next frame re-applies it.
  const groupRef = useRef<Group>(null)
  const manualHidden = useCanonicalSceneStore((s) => s.hiddenWallIds.includes(wall.id))
  const cameraMode = useCanonicalSceneStore((s) => s.cameraMode)
  // R12.3: Selection-State aus Store. Key-Format `${kind}-${nodeId}` matched
  // den TappedSurface-Schlüssel der Hosts. Demand-Loop wird durch invalidate
  // unten gepoked, damit der Glow-Refresh sichtbar wird im static dollhouse.
  const isSelected = useCanonicalSceneStore(
    (s) => s.selectedSurface === `wall-${wall.id}`,
  )
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => invalidate(), [manualHidden, cameraMode, isSelected, invalidate])

  // Outward normal of the wall on XZ — `(dir.z, 0, -dir.x)` of the centerline.
  const normalX = Math.sin(angle)
  const normalZ = -Math.cos(angle)
  useFrame(({ camera }) => {
    const g = groupRef.current
    if (!g) return
    let hidden: boolean
    if (manualHidden) {
      hidden = true
    } else if (cameraMode !== 'dollhouse') {
      hidden = false
    } else {
      // Auto-hide a wall whose outer face the camera is looking at — it would
      // otherwise block the dollhouse view into the room.
      const toCameraX = camera.position.x - midX
      const toCameraZ = camera.position.z - midZ
      const facingCamera = normalX * toCameraX + normalZ * toCameraZ > 0
      hidden = facingCamera
    }
    g.visible = !hidden
    // R14: setSubtreeRaycastable obsolet. Pick-Layer-Decoupling (PickProxy
    // auf PICK_LAYER + raycaster nur auf PICK_LAYER gebunden) macht die
    // Render-Geometry raycast-unsichtbar. Visibility-Cascade auf der parent
    // group ist die einzige Source-of-Truth für Cutaway — SurfaceTapLayer
    // checked `.visible === false` walk-up vor jedem hit-resolve.
  })

  // BufferGeometry / EdgesGeometry hold GPU-backed buffers three.js never
  // frees automatically — dispose on prop churn + unmount or VRAM leaks.
  useEffect(() => () => {
    geom.dispose()
    edges.dispose()
  }, [geom, edges])

  // R12.3 Highlight (selected wall): SurfaceMaterial bekommt einen
  // emissive-Boost (warmer Liquid-Glass-Glow) und die EdgesGeometry wechselt
  // auf einen helleren Outline-Stroke. Kombination Glow+Outline gibt klares
  // visuelles Feedback ohne extra Post-Processing-Pass.
  const body = (
    <>
      <mesh geometry={geom} castShadow receiveShadow>
        <SurfaceMaterial
          materialId={wall.material_id}
          defaultColor="#e8ebf0"
          defaultRoughness={0.85}
          defaultMetalness={0}
          polygonOffset
          isSelected={isSelected}
        />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial
          color={isSelected ? '#ffffff' : '#3a3f4a'}
          transparent
          opacity={isSelected ? 0.95 : 0.6}
          linewidth={isSelected ? 2 : 1}
        />
      </lineSegments>
    </>
  )

  return (
    <group ref={groupRef} name={`wall-${wall.id}`}>
      {/*
        World-space mitered body renders in an identity frame; the box
        fallback is wall-local, so it goes inside the translated/rotated group.
      */}
      {worldSpace && body}
      <group position={[midX, cy, midZ]} rotation={[0, -angle, 0]}>
        {!worldSpace && body}
        {/*
          R14 PickProxy — single invisible plane that is the wall's ONLY
          raycast target. Sized (length × height) covers the wall body. Sits
          at wall-local (0,0,0), normal facing +Z (outward). Camera doesn't
          render it (PICK_LAYER). Raycaster bound to PICK_LAYER hits it,
          one unambiguous (kind=wall, nodeId=wall.id) per hit.
        */}
        <PickProxy size={[length, wall.height_m]} />
        {wall.openings.map((op) => (
          <OpeningAdapter
            key={op.id}
            opening={op}
            wallLength={length}
            wallHeight={wall.height_m}
            wallThickness={wall.thickness_m}
            mode={openingMode}
          />
        ))}
        {wall.wall_mounted.map((obj) => (
          <ObjectAdapter
            key={obj.id}
            object={obj}
            context={{ wallLength: length, wallHeight: wall.height_m, wallThickness: wall.thickness_m }}
          />
        ))}
      </group>
    </group>
  )
}
