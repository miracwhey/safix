/**
 * Spatial · Canonical · Three · ModeBackground (V1.6.1 Round 6)
 *
 * Mode-aware Canvas-Background. Vor Round 6 war der Canvas-Background
 * default-schwarz → 3D-Modell "schwebte im Nichts", keine Tiefe; Floor
 * verschmolz mit Background; 2D-Grundriss wirkte düster statt wie Papier.
 *
 * Jetzt:
 *   - `dollhouse` / `walk` → Vertical-Gradient deep-blue (Premium-Look,
 *     matcht SaFix Profile-Card-Gradient)
 *   - `floorplan`           → off-white "Papier" (Architekten-Look)
 *   - `ar_compare`          → null (Camera-feed dahinter)
 *
 * Implementation via r3f `attach="background"` JSX statt scene.background-
 * Mutation — keine eslint-react-hooks/immutability Verletzung.
 */

import { useEffect, useMemo, type ReactElement } from 'react'
import { CanvasTexture } from 'three'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore.ts'

function buildVerticalGradient(top: string, bottom: string): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height)
    grad.addColorStop(0, top)
    grad.addColorStop(1, bottom)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const tex = new CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

export function ModeBackground(): ReactElement | null {
  const mode = useCanonicalSceneStore((s) => s.cameraMode)
  const gradient = useMemo(() => buildVerticalGradient('#0c1525', '#1a2540'), [])
  const floorplanGradient = useMemo(
    () => buildVerticalGradient('#FAF7F0', '#EDE6D6'),
    [],
  )
  useEffect(
    () => () => {
      gradient.dispose()
      floorplanGradient.dispose()
    },
    [gradient, floorplanGradient],
  )

  if (mode === 'floorplan') {
    // R8-C: warm-beige Architekten-Plan-Background (Mockup 13 V5 State B,
    // Planner-5D / Apple-Maps style). Vorher cool off-white #eef1f6 wirkte
    // klinisch; FAF7F0 → EDE6D6 Gradient gibt CAD-Wärme.
    return <primitive object={floorplanGradient} attach="background" />
  }
  if (mode === 'dollhouse' || mode === 'walk') {
    return <primitive object={gradient} attach="background" />
  }
  return null
}

export default ModeBackground
