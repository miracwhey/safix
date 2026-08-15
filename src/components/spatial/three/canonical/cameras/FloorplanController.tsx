/**
 * Spatial · Canonical · Cameras · FloorplanController (Day 16)
 *
 * Orthographic top-down view. Pans in floor-XZ plane, snaps to cardinal
 * rotations to match the Block-A SpatialViewer floorplan mode.
 *
 * Mobile-UX (V1.6.1 Bug #10): drei OrbitControls default `touches.ONE` ist
 * `TOUCH.ROTATE`. Bei `enableRotate=false` wird die 1-Finger-Geste **silently
 * discarded** — User kann den Grundriss nicht mit einem Finger verschieben.
 * Wir mappen `ONE → PAN` und `TWO → DOLLY_PAN` damit der Floorplan sich
 * intuitiv wie eine Karte verhält (1-Finger drag = move, 2-Finger pinch =
 * zoom). Maus-LMB ebenfalls auf PAN damit Desktop-Test stimmt.
 *
 * Resize-Verhalten (V1.6.1 Bug #10): Statt die Ortho-Kamera bei jedem
 * size-change neu zu instanziieren (=Pan/Zoom verloren), wird die Camera
 * **einmal** erzeugt (sobald die echten Scene-Bounds vorliegen) und nur ihr
 * Frustum bei Aspect-Änderungen aktualisiert. So bleibt die User-Sicht beim
 * Rotation/Resize stabil.
 */

import { useEffect, useLayoutEffect, useRef, type ComponentRef, type ReactElement } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { MOUSE, OrthographicCamera, TOUCH } from 'three'

import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore'

export interface FloorplanControllerProps {
  target?: [number, number, number]
  initialHalfHeight?: number
}

export function FloorplanController({
  target = [2, 0, 2],
  initialHalfHeight = 4,
}: FloorplanControllerProps): ReactElement {
  const { size, set, camera } = useThree()
  // Footprint-edit (FloorplanDragLayer) locks the camera while a corner is
  // dragged so OrbitControls pan never fights the wall move. Mirrors the
  // DollhouseController lock used by the furniture gesture layers.
  const objectInteractionLocked = useCanonicalSceneStore((s) => s.objectInteractionLocked)
  // The perspective camera in charge BEFORE this controller swaps in the
  // orthographic one. Captured once at mount so the cleanup can restore it —
  // without this the ortho camera leaks into the next mode (set-without-
  // restore bug). `useRef`'s initial value never changes after mount.
  const perspectiveRef = useRef(camera)
  // Ortho-Camera persistent across resize so pan/zoom state survives an
  // orientation change. Built once sobald die echten Bounds vorliegen (Framing
  // aus framingRef unten), nie bei Live-target/initialHalfHeight-Updates.
  const orthoRef = useRef<OrthographicCamera | null>(null)
  // OrbitControls instance — needed to flush leftover pan/zoom momentum the
  // instant a corner/edge is grabbed (see the lock-flush effect below). Ref-Typ
  // aus drei abgeleitet (ComponentRef) statt direkt aus der transitiven
  // three-stdlib-Dependency zu importieren.
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null)
  // Framing-Inputs werden NICHT beim Mount eingefroren, sondern erst sobald die
  // echten Scene-Bounds vorliegen. Grund: im Handwerker-Footprint-Editor wird
  // die Scene post-paint in den Store hydriert (useEffect in CanonicalSceneRoot),
  // während cameraMode 'floorplan' bereits pre-paint gesetzt ist. Beim ERSTEN
  // Render dieses Controllers ist `resolved` daher noch null, und der Parent
  // liefert die Defaults [2,0,2] / halfHeight 4 (cameraTarget/cameraFit-Fallback).
  // Würden wir die einfrieren, öffnete der Grundriss am Ursprung mit falschem
  // Zoom und heilte sich nie selbst. Stattdessen frieren wir im ersten Render
  // mit verfügbaren Bounds ein — danach stabil, damit ein Live-Bounds-Update
  // während eines Wand-Slides die Ortho-Kamera nicht neu baut.
  const resolvedReady = useCanonicalSceneStore((s) => s.resolved !== null)
  const framingRef = useRef<{ target: [number, number, number]; halfHeight: number } | null>(null)
  if (resolvedReady && !framingRef.current) {
    framingRef.current = { target, halfHeight: initialHalfHeight }
  }

  // Mount the ortho camera (replaces perspective) — baut EINMAL sobald die echten
  // Bounds verfügbar sind (resolvedReady false→true), NICHT bei jedem resize und
  // NICHT bei Live-target/initialHalfHeight-Updates.
  useEffect(() => {
    const framing = framingRef.current
    if (!framing) return
    const halfHeight = framing.halfHeight
    const tgt = framing.target
    const aspect = size.width / Math.max(1, size.height)
    const ortho = new OrthographicCamera(
      -halfHeight * aspect,
      halfHeight * aspect,
      halfHeight,
      -halfHeight,
      0.01,
      200,
    )
    ortho.position.set(tgt[0], 20, tgt[2])
    ortho.lookAt(tgt[0], 0, tgt[2])
    ortho.updateProjectionMatrix()
    orthoRef.current = ortho
    set({ camera: ortho })
    const restore = perspectiveRef.current
    return () => {
      // Restore the perspective camera when leaving floorplan mode.
      set({ camera: restore })
      orthoRef.current = null
    }
    // size.width/size.height intentionally NOT in deps — the resize-only effect
    // below updates the existing camera's frustum in place. resolvedReady gatet
    // den einmaligen Bau; target/initialHalfHeight bewusst NICHT in deps (im
    // framingRef eingefroren), sonst baut ein Live-Bounds-Update während eines
    // Wand-Slides die Kamera neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedReady, set])

  // Resize-only: update frustum on size change without rebuilding camera.
  useEffect(() => {
    const ortho = orthoRef.current
    if (!ortho) return
    const aspect = size.width / Math.max(1, size.height)
    // Preserve user's zoom by scaling current frustum extent by aspect.
    const halfHeight = (ortho.top - ortho.bottom) / 2
    ortho.left = -halfHeight * aspect
    ortho.right = halfHeight * aspect
    ortho.updateProjectionMatrix()
  }, [size.width, size.height])

  // ── Momentum flush on grab ──────────────────────────────────────────────
  // FloorplanDragLayer sets `objectInteractionLocked` the instant a corner or
  // edge is grabbed. `enabled={!locked}` then stops OrbitControls' frame loop,
  // but any pan/zoom velocity already accumulated (enableDamping is on for the
  // map-glide feel) would otherwise (a) apply one stale frame in the ~1-frame
  // window before the prop commits and (b) re-apply the instant the lock
  // releases at drag-end — both make the floor drift under the finger. On the
  // rising edge we consume the residual: with damping OFF a single update()
  // ZEROES sphericalDelta/panOffset (instead of decaying them). We snapshot +
  // restore pose/zoom so the one final residual step that update() applies
  // leaves no visible lurch. Navigation glide stays ON whenever unlocked
  // because enableDamping is otherwise untouched.
  useLayoutEffect(() => {
    if (!objectInteractionLocked) return
    const c = controlsRef.current
    if (!c) return
    const cam = c.object as OrthographicCamera
    const pos = cam.position.clone()
    const tgt = c.target.clone()
    const { zoom } = cam
    const prevDamping = c.enableDamping
    c.enableDamping = false
    c.update()
    cam.position.copy(pos)
    c.target.copy(tgt)
    cam.zoom = zoom
    cam.updateProjectionMatrix()
    c.enableDamping = prevDamping
  }, [objectInteractionLocked])

  // Vor verfügbaren Bounds nichts rendern: ohne Framing gäbe es keine sinnvolle
  // Ortho-Kamera (der Build-Effekt oben wartet ebenfalls auf framingRef). Sobald
  // `resolved` ankommt, mountet der Controller mit der echten Sicht — kein
  // Origin-Frame, kein Self-Heal-Rebuild nötig.
  const framing = framingRef.current
  if (!framing) return <></>

  return (
    <OrbitControls
      ref={controlsRef}
      target={framing.target}
      enabled={!objectInteractionLocked}
      enableRotate={false}
      enablePan
      enableZoom
      maxPolarAngle={0}
      minPolarAngle={0}
      enableDamping
      dampingFactor={0.08}
      zoomSpeed={1.4}
      panSpeed={1.1}
      // Ortho-Zoom hat keine "distance" — wir verwenden zoom-faktor-Limits.
      // 0.4 = User kann max. ~2.5× rauszoomen vom initial-Frame, 5 = max
      // ~5× reinzoomen. Verhindert beides "Punkt"-State und "Inside-Wall"-
      // State.
      minZoom={0.4}
      maxZoom={5}
      // 1-Finger drag pannt (Maps/Figma-Konvention). 2-Finger Pinch zoomt
      // + pannt simultan via DOLLY_PAN.
      touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN }}
      // Maus-Mapping: links pannt (statt default rotate — wäre eh disabled
      // → no-op). Rechtsklick auch pan (iPad-Trackpad).
      mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
      // Two-finger zoom on ortho cameras adjusts the frustum extent (drei's
      // OrbitControls converts dolly to zoom). zoomToCursor keeps the pinch
      // anchor point under the user's fingers rather than snapping to the
      // canvas centre — feels much more natural on small touch surfaces.
      zoomToCursor
      makeDefault
    />
  )
}
