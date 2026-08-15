/**
 * Spatial · Canonical · Three · SectionClipper (Zwischen-Latte · B-5)
 *
 * Applies the horizontal section-slice to the whole canonical scene via a
 * global three.js clipping plane. When `sectionSliderY` is set, everything
 * ABOVE that height is clipped away — the architectural "cut the top off and
 * look in" view; `null` clears the slice.
 *
 * A single global clipping plane (`gl.clippingPlanes`) covers every material
 * without each adapter opting in. In-canvas component — renders nothing.
 */

import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { Plane, Vector3 } from 'three'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore.ts'

export function SectionClipper(): null {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const sectionSliderY = useCanonicalSceneStore((s) => s.sectionSliderY)

  /* eslint-disable react-hooks/immutability --
     `gl` is the three.js WebGLRenderer; `clippingPlanes` + `localClippingEnabled`
     are its documented mutation API for global clipping — there is no hook to
     move this into. */
  useEffect(() => {
    if (sectionSliderY === null) {
      gl.localClippingEnabled = false
      gl.clippingPlanes = []
    } else {
      // Plane `-y + sectionSliderY = 0`; three.js keeps the half-space where
      // `normal·p + constant ≥ 0`, i.e. `y ≤ sectionSliderY`.
      gl.localClippingEnabled = true
      gl.clippingPlanes = [new Plane(new Vector3(0, -1, 0), sectionSliderY)]
    }
    invalidate()
    return () => {
      gl.localClippingEnabled = false
      gl.clippingPlanes = []
      invalidate()
    }
  }, [gl, invalidate, sectionSliderY])
  /* eslint-enable react-hooks/immutability */

  return null
}
