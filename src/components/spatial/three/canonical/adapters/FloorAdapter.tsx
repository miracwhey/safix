/**
 * Spatial · Canonical · Adapters · FloorAdapter (Day 11 · Block R5 material wiring)
 *
 * Material (Block R5): the hardcoded `<meshStandardMaterial color>` is replaced
 * by `<SurfaceMaterial>`, resolving the floor's `material_id` to a catalog PBR
 * material with a progressive fallback → textured upgrade.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { DoubleSide, type Mesh, Shape, ShapeGeometry } from 'three'

import type { Floor } from '../../../../../lib/spatial/canonical/types/geometry.ts'

import { ObjectAdapter } from './ObjectAdapter'
import { SurfaceMaterial } from '../materials/SurfaceMaterial.tsx'
import { ensureUv2 } from '../materials/surfaceMaterialHooks.ts'
import { markPickOnly } from '../pickLayer'

interface FloorAdapterProps {
  floor: Floor
}

export function FloorAdapter({ floor }: FloorAdapterProps): ReactElement | null {
  // Build geometry imperatively (instead of <shapeGeometry args={[shape]}>)
  // so we can pair it with an explicit dispose-on-unmount/replace effect.
  // R3F's declarative form doesn't reliably dispose the old buffer when
  // args change, causing a GPU leak on polygon edits.
  const geometry = useMemo(() => {
    if (floor.polygon.length < 3) return null
    // Shape-Y-Negation-Convention (siehe FloorplanCadOverlay): das Mesh wird per
    // `rotation=[-π/2,0,0]` in die XZ-Ebene gekippt, was World-Z gegenüber Shape-Y
    // negiert — Shape-Vertex (a, b) landet bei World (a, 0, -b). Bauen wir den Shape
    // naiv mit (polygon.x, polygon.z), rendert der Floor z-GESPIEGELT um die
    // World-Origin (Boden außerhalb des Raums in Dollhouse/Walk), während Ceiling
    // (+π/2) + Walls (true frame) + ContactShadow korrekt bei +z liegen. Mit `-z`
    // landet der Floor nach der Rotation bei World +z, deckungsgleich mit den Wänden.
    // Die Negation kehrt die Ring-Windung um → Face-Normale zeigt nach unten →
    // `side={DoubleSide}` (unten) hält den Floor von oben sichtbar (wie die Decke).
    const s = new Shape()
    s.moveTo(floor.polygon[0].x, -floor.polygon[0].z)
    for (let i = 1; i < floor.polygon.length; i++) {
      s.lineTo(floor.polygon[i].x, -floor.polygon[i].z)
    }
    s.closePath()
    const g = new ShapeGeometry(s)
    // ShapeGeometry ships only `uv`; the catalog material's `aoMap` samples
    // `uv2`. Mirror it so AO renders correctly on the floor.
    ensureUv2(g)
    return g
  }, [floor.polygon])
  useEffect(() => () => geometry?.dispose(), [geometry])

  // R14: PickProxy für Floor — gleiche Geometrie wie Render-Body auf
  // PICK_LAYER. Markiert via markPickOnly im useEffect; geometry-dep weil
  // bei Polygon-Edit das Mesh neu mountet.
  const pickRef = useRef<Mesh>(null)
  useEffect(() => {
    markPickOnly(pickRef.current)
  }, [geometry])

  if (!geometry) return null

  return (
    <group name={`floor-${floor.id}`}>
      {/* V1.6.1 Round 6: receiveShadow=false. Vorher pitched der Wall-cast-
          shadow den ganzen Floor in kleinen Räumen → Floor wirkte
          schwarz (Image 2 Bug). ContactShadow im CanonicalSceneRoot
          gibt jetzt den "Bühne"-Effekt ohne Floor-Color zu zerstören. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} geometry={geometry} receiveShadow={false}>
        <SurfaceMaterial
          materialId={floor.material_id}
          defaultColor="#a89478"
          defaultRoughness={0.95}
          defaultMetalness={0}
          side={DoubleSide}
        />
      </mesh>
      {/* R14 PickProxy für Floor — gleiche Geometrie, layer 1 only. */}
      <mesh
        ref={pickRef}
        rotation={[-Math.PI / 2, 0, 0]}
        geometry={geometry}
        renderOrder={-1}
      >
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {floor.floor_mounted.map((obj) => (
        <ObjectAdapter key={obj.id} object={obj} />
      ))}
    </group>
  )
}
