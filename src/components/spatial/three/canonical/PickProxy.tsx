/**
 * Spatial · Canonical · Three · PickProxy (V1.6.1 R14)
 *
 * Invisible mesh that lives on PICK_LAYER and acts as the *only* raycast
 * target for a canonical surface (Wall / Floor / Ceiling). Renders nothing
 * the user sees — the visible body lives next to it on layer 0.
 *
 * Why a dedicated proxy instead of raycasting the visible body:
 *   - Walls are 5–15 cm thick boxes (or extruded mitered footprints) with
 *     multiple faces (inner/outer/top/bottom). Raycasts can pierce one wall
 *     and report the FAR wall as nearest-hit. The proxy is a single thin
 *     plane on the inner face → one unambiguous hit per surface.
 *   - The proxy can be sized slightly larger than the body (tap-tolerance)
 *     without changing render geometry.
 *   - Cutaway visibility lives on the parent group (`.visible = false`); the
 *     SurfaceTapLayer's visibility-walk filters those out at hit time.
 */

import { useEffect, useRef, type ReactElement } from 'react'
import { DoubleSide, type Mesh } from 'three'

import { markPickOnly } from './pickLayer'

interface PickProxyProps {
  /**
   * Geometry args passed to <planeGeometry> — `[widthM, heightM]`. The proxy
   * is a simple PlaneGeometry; orientation is set by the caller via the
   * parent group's transform.
   */
  size: [number, number]
}

/**
 * Render a PickProxy plane. Caller is responsible for positioning + rotating
 * the proxy via its parent group's transform. The mesh is `visible` (so the
 * cascade visibility-check in the tap handler can see it) but renders nothing
 * because it sits on PICK_LAYER which the camera does not see.
 *
 * `transparent + opacity 0` on the material is belt-and-suspenders — if a
 * future camera enables PICK_LAYER (debug), the proxy still won't visually
 * occlude the body.
 */
export function PickProxy({ size }: PickProxyProps): ReactElement {
  const meshRef = useRef<Mesh>(null)
  useEffect(() => {
    markPickOnly(meshRef.current)
  }, [])
  return (
    <mesh ref={meshRef} renderOrder={-1}>
      <planeGeometry args={size} />
      {/*
        R15: `side={DoubleSide}` — der Proxy ist eine einseitige PlaneGeometry
        (Normal +Z). Dollhouse-Cutaway versteckt jede Wand, deren AUSSEN-Seite
        die Kamera sieht → die sichtbaren Wände werden von INNEN getroffen, d.h.
        der Ray trifft die RÜCKSEITE des Proxys. Mit dem `FrontSide`-Default
        cullt der Raycaster diesen Hit → korrekte Wand liefert 0 Votes, Tap
        landet auf einer Nachbar-Wand oder feuert gar nicht ("erst 2. Tap").
        Konsumenten dieser Komponente: WallAdapter (vertikal) + ObjectAdapter
        (horizontale Footprint-Plane, hilft beim Möbel-Pick aus flachem Walk-
        Blickwinkel). Decke + Boden mounten EIGENE Inline-Pick-Meshes
        (CeilingAdapter bereits DoubleSide, FloorAdapter FrontSide von oben
        getroffen) — von dieser Änderung NICHT betroffen.
      */}
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
    </mesh>
  )
}
