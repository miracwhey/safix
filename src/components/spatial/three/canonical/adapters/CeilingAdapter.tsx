/**
 * Spatial · Canonical · Adapters · CeilingAdapter (Day 11 · Block R5 material wiring)
 *
 * Material (Block R5): the hardcoded `<meshStandardMaterial color>` is replaced
 * by `<SurfaceMaterial>`, resolving the ceiling's `material_id` to a catalog
 * PBR material. The ceiling renders double-sided (`side = 2`) so it is visible
 * from below regardless of polygon winding.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { DoubleSide, type Mesh, Shape, ShapeGeometry, type Group } from 'three'

import type { Ceiling } from '../../../../../lib/spatial/canonical/types/geometry.ts'
import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore.ts'

import { ObjectAdapter } from './ObjectAdapter'
import { SurfaceMaterial } from '../materials/SurfaceMaterial.tsx'
import { ensureUv2 } from '../materials/surfaceMaterialHooks.ts'
import { markPickOnly } from '../pickLayer'

interface CeilingAdapterProps {
  ceiling: Ceiling
}

export function CeilingAdapter({ ceiling }: CeilingAdapterProps): ReactElement | null {
  // B-5 · the ceiling is hidden by the ceiling-removing cutaway presets so
  // the dollhouse / floorplan modes can see into the room from above.
  const cutawaySetting = useCanonicalSceneStore((s) => s.cutawaySetting)
  const ceilingHidden =
    cutawaySetting === 'remove_ceiling' ||
    cutawaySetting === 'remove_ceiling_and_high_walls'
  // See FloorAdapter — imperative ShapeGeometry + dispose-on-replace to
  // avoid the R3F declarative-form GPU leak on polygon churn.
  const geometry = useMemo(() => {
    if (ceiling.polygon.length < 3) return null
    const s = new Shape()
    s.moveTo(ceiling.polygon[0].x, ceiling.polygon[0].z)
    for (let i = 1; i < ceiling.polygon.length; i++) {
      s.lineTo(ceiling.polygon[i].x, ceiling.polygon[i].z)
    }
    s.closePath()
    const g = new ShapeGeometry(s)
    // ShapeGeometry ships only `uv`; the catalog material's `aoMap` needs `uv2`.
    ensureUv2(g)
    return g
  }, [ceiling.polygon])
  useEffect(() => () => geometry?.dispose(), [geometry])

  // R14: setSubtreeRaycastable obsolet. PickProxy auf PICK_LAYER + parent
  // `.visible=false` Cascade handhabt Cutaway. SurfaceTapLayer's resolve-
  // walk filtert invisible-Ancestors automatisch.
  const groupRef = useRef<Group>(null)
  const pickRef = useRef<Mesh>(null)
  useEffect(() => {
    markPickOnly(pickRef.current)
  }, [geometry])

  if (!geometry) return null

  return (
    <group ref={groupRef} name={`ceiling-${ceiling.id}`}>
      {/* Die Decken-PLATTE (Render-Mesh + Pick-Proxy) toggelt mit dem Cutaway:
          beim Reinschauen von oben wird sie ausgeblendet (parent `.visible=false`
          → SurfaceTapLayer-Resolve filtert invisible-Ancestors). */}
      <group name={`ceiling-slab-${ceiling.id}`} visible={!ceilingHidden}>
        <mesh
          rotation={[Math.PI / 2, 0, 0]}
          position={[0, ceiling.height_m, 0]}
          geometry={geometry}
        >
          <SurfaceMaterial
            materialId={ceiling.material_id}
            defaultColor="#f5f5f7"
            defaultRoughness={0.9}
            defaultMetalness={0}
            side={DoubleSide}
          />
        </mesh>
        {/* R14 PickProxy für Ceiling — gleiche Geometrie wie Render-Body aber
            auf PICK_LAYER. Nicht sichtbar (camera ignoriert PICK_LAYER), aber
            der einzige Raycast-Target für die Decke. */}
        <mesh
          ref={pickRef}
          rotation={[Math.PI / 2, 0, 0]}
          position={[0, ceiling.height_m, 0]}
          geometry={geometry}
          renderOrder={-1}
        >
          <meshBasicMaterial transparent opacity={0} side={DoubleSide} depthWrite={false} />
        </mesh>
      </group>
      {/* Decken-OBJEKTE (Leuchten/Pendel) hängen NICHT am Cutaway: man schneidet
          die Decke gerade auf, um sie im Dollhouse zu sehen + zu bearbeiten.
          Vorher lagen sie im `visible`-Group → beim Reinschauen verschwanden Mesh
          UND PickProxy → un-selektierbar/un-ziehbar (V1.6.1 Review-Blocker). Jetzt
          immer sichtbar + pickbar, unabhängig von der Platte. */}
      {ceiling.ceiling_mounted.map((obj) => (
        <ObjectAdapter key={obj.id} object={obj} context={{ ceilingY: ceiling.height_m }} />
      ))}
    </group>
  )
}
