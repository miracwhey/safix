/**
 * Spatial · Canonical · Cameras · DollhouseController (Day 16)
 *
 * Tilted top-down isometric view used as the default "preview" mode in
 * the scan-review surface. Wraps drei's OrbitControls with sensible
 * defaults: orbit + zoom enabled, no pan, smooth damping.
 *
 * Mobile-UX (V1.6.1 Bug #8): One-finger drag = rotate (orbit). Two-finger
 * pinch = zoom (dolly). drei's OrbitControls sets `touchAction: 'none'` on
 * the renderer's domElement so the WebView can't claim the gesture as a
 * page-scroll. zoomSpeed is bumped from default (1.0 → 1.4) because small
 * customer rooms (2.5m) feel sluggish with the default — diagonal-derived
 * minDistance/maxDistance limit how far in/out the user can dolly so a
 * pinch never ends in "tiny dot" or "inside-the-wall" territory.
 *
 * Double-tap on the canvas resets the camera to its initial framing
 * (re-applies the `initialDistance` so the user can recover from any
 * orbit + zoom state in one gesture).
 */

import { useCallback, useEffect, useRef, type ReactElement } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'

import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore.ts'

export interface DollhouseControllerProps {
  target?: [number, number, number]
  initialDistance?: number
  /** Minimum dolly distance (closest zoom-in). */
  minDistance?: number
  /** Maximum dolly distance (furthest zoom-out). */
  maxDistance?: number
}

export function DollhouseController({
  target = [2, 0, 2],
  initialDistance = 8,
  minDistance,
  maxDistance,
}: DollhouseControllerProps): ReactElement {
  const { camera, gl } = useThree()
  const controlsRef = useRef<OrbitControlsImpl | null>(null)

  // Phase 5: während einer Möbel-Geste (Drag/Pinch/Dreh-Dial) wird die Kamera
  // gesperrt, damit ein Finger-Drag das Objekt bewegt statt die Szene zu
  // orbiten. Pan ist ohnehin aus; rotate + zoom werden geflippt.
  const interactionLocked = useCanonicalSceneStore((s) => s.objectInteractionLocked)

  // Default min/max scale with the requested initialDistance — V1.6.1
  // Round 5: vorher *0.3/*3 = bei 6m initialDistance min 1.8m max 18m.
  // User-Feedback "min/max bisschen vergrößern, weiter rauszoomen". Jetzt
  // *0.1/*6 = bei 6m init min 0.6m max 36m. Plus absolute floor 0.3m und
  // ceiling 60m für sehr große Räume. Caller kann via explicit props
  // weiter override.
  const effectiveMin = minDistance ?? Math.max(0.3, initialDistance * 0.1)
  const effectiveMax = maxDistance ?? Math.min(60, Math.max(initialDistance * 6, 12))

  // Refs für die "frame the scene initial" Logik. Vorher: useCallback mit
  // dep `initialDistance` → bei jedem cameraFit-recompute (parent-side, läuft
  // wenn `resolved` neu zugewiesen wird, was Realtime/variants triggern) wurde
  // useEffect erneut gefeuert → camera-position-reset → User-Pinch verloren.
  // Jetzt: Mount-only Snap. Re-Snap explizit via double-tap (siehe unten).
  const framedRef = useRef(false)
  const propsRef = useRef({ camera, target, initialDistance, controlsRef })
  // Sync after render — Linter blockiert ref-write während render.
  useEffect(() => {
    propsRef.current = { camera, target, initialDistance, controlsRef }
  })
  const frameInitial = useCallback(() => {
    const { camera: cam, target: t, initialDistance: dist } = propsRef.current
    const [tx, ty, tz] = t
    cam.position.set(tx + dist * 0.6, dist * 0.8, tz + dist * 0.6)
    cam.lookAt(tx, ty, tz)
    cam.updateProjectionMatrix()
    const controls = propsRef.current.controlsRef.current
    if (controls) {
      controls.target.set(tx, ty, tz)
      controls.update()
    }
  }, [])

  useEffect(() => {
    if (framedRef.current) return
    frameInitial()
    framedRef.current = true
  }, [frameInitial])

  // Double-tap to recover initial framing — common iOS expectation when the
  // user rotates/zooms past the scene and can't find their way back.
  //
  // V1.6.1 Round 6 Fix (2026-05-28): Pinch-Ende lieferte 2× pointerup
  // innerhalb weniger ms (jeder Finger einzeln). Vorher: false-positive
  // Double-Tap → frameInitial() → zoom snapped sofort zurück. Jetzt mit
  // pointerId-Set: Double-Tap nur wenn KEIN weiterer Finger aktiv ist UND
  // beide Sequenzen single-pointer waren.
  useEffect(() => {
    const el = gl.domElement
    let lastTap = 0
    const activeTouchPointers = new Set<number>()
    let multiTouchSeenInGesture = false

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      activeTouchPointers.add(event.pointerId)
      if (activeTouchPointers.size > 1) multiTouchSeenInGesture = true
    }
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      activeTouchPointers.delete(event.pointerId)
      // Solange noch ein Finger drauf ist: das war Teil eines Multi-Touch
      // (Pinch). Keine Tap-Detection.
      if (activeTouchPointers.size > 0) return
      const wasMultiTouch = multiTouchSeenInGesture
      multiTouchSeenInGesture = false
      if (wasMultiTouch) return // Pinch-Ende → kein Tap
      const now = performance.now()
      if (now - lastTap < 320) {
        frameInitial()
        lastTap = 0
        return
      }
      lastTap = now
    }
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      activeTouchPointers.delete(event.pointerId)
      if (activeTouchPointers.size === 0) multiTouchSeenInGesture = false
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
    }
  }, [gl, frameInitial])

  return (
    <OrbitControls
      ref={controlsRef}
      target={target}
      enablePan={false}
      enableRotate={!interactionLocked}
      enableZoom={!interactionLocked}
      maxPolarAngle={Math.PI / 2 - 0.1}
      minDistance={effectiveMin}
      maxDistance={effectiveMax}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.75}
      zoomSpeed={1.4}
      makeDefault
    />
  )
}
