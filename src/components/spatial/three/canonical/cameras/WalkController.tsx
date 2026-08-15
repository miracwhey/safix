/**
 * Spatial · Canonical · Cameras · WalkController (Day 16 · R14 + H16)
 *
 * First-person walk-through camera. Uses the L1 `resolveCameraCollision`
 * helper so the capsule never tunnels through walls or settles outside
 * the walkable polygon. The audit-fix H16 chain (re-test after Y-lift,
 * snap to nearest walkable-polygon vertex) runs inside the L1 helper —
 * this controller only wires the inputs.
 *
 * Binding settings (Decision #7):
 *   - eye-height fixed at 1.70 m
 *   - speed 1.4 m/s
 *   - capsule from `DEFAULT_CAMERA_CAPSULE` (radius 0.25 m, height 1.70 m).
 *     This MUST match the validator's CAMERA_CAPSULE_R used to contract the
 *     walkable polygon; a larger controller capsule wedges in corners every
 *     time the polygon edge sits exactly on the inset distance.
 *   - 3 collision-resolution iterations + Y-clamp fallback + vertex-snap
 *   - door-portal traversal switches `current_room` (Phase 0c stub —
 *     Day 17+ wires the connectivity graph; here we just emit an
 *     onRoomChange callback)
 *
 * Mobile-input parity: a dependency-free custom touch joystick binds to the
 * bottom-left corner and mirrors WASD (forward/right written into the same
 * inputRef as keyboard). The joystick is opt-in via the `mobileJoystick` prop.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { DoubleSide, PerspectiveCamera, Shape, Vector3 } from 'three'

import {
  resolveCameraCollision,
  isPointInWalkable,
  walkableInteriorPoint,
  type CameraObstacle,
} from '../../../../../lib/spatial/canonical/geometry/collision'
import { DEFAULT_CAMERA_CAPSULE, type WalkablePolygon } from '../../../../../lib/spatial/canonical/types/walkable'
import { useCanonicalSceneStore } from '../../../../../lib/spatial/canonical/store/sceneStore'

export interface WalkControllerProps {
  /** Walkable polygon for the active room (from L1 `computeWalkableArea`). */
  walkable: WalkablePolygon
  /** Obstacles (walls + floor-mounted objects) · rotated items carry `rotationY`. */
  obstacles: ReadonlyArray<CameraObstacle>
  /** Starting position in world coords (XZ plane). */
  initialPosition?: [number, number]
  /** Optional callback when the camera crosses a door portal. */
  onRoomChange?: (roomId: string) => void
  /** Enable the custom mobile touch joystick (default false; tap-to-enable). */
  mobileJoystick?: boolean
  /**
   * Tear the joystick down while an edit overlay (measurement / annotation
   * sheet, material picker) is open. The joystick is an imperative
   * `z-index:70` node on `document.body`, a sibling of the viewer portal
   * (`z-[60]`); every edit sheet nests INSIDE that portal so it can never
   * out-stack the joystick. z-reordering can't win, so we suppress instead.
   * The joystick-effect cleanup also zeroes `forward`/`right` → no camera
   * drift while suppressed (default false).
   */
  suppressJoystick?: boolean
}

const EYE_HEIGHT_M = 1.70
// V1.6.1 Round 10 Iteration 2: 90→100 (Maximum). User-Test bestätigt: 100°
// ist die obere Grenze bevor Walls am Bildrand sichtbar krümmen (Fisheye).
// Geht NICHT weiter — über 100° vertikal wird der Raum optisch deformiert
// statt nur grosszügiger zu wirken.
const WALK_FOV_DEG = 100
// V1.6.1 Round 5 (2026-05-28): 1.4 m/s = realistisches Gehtempo, in Räumen
// von 2.5×2.5m aber gefühlt "stuck" — User-Feedback "kann mich nicht im Raum
// bewegen". Bumped auf 2.5 m/s = leicht über-realistisch aber Game-Feel.
const WALK_SPEED_MPS = 2.5
const CAPSULE = DEFAULT_CAMERA_CAPSULE

/** Centroid des walkable-outer-rings (XZ). Mount-time only, kein per-frame. */
function walkableCentroid(poly: WalkablePolygon): { x: number; z: number } | null {
  if (!poly.outer.length) return null
  let sx = 0
  let sz = 0
  for (const p of poly.outer) {
    sx += p.x
    sz += p.z
  }
  return { x: sx / poly.outer.length, z: sz / poly.outer.length }
}

/** XZ-AABB des walkable-outer-rings. */
function walkableBounds(
  poly: WalkablePolygon,
): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  if (!poly.outer.length) return null
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of poly.outer) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  return { minX, maxX, minZ, maxZ }
}

/**
 * Spawn am Raum-Rand statt Centroid (V1.6.1 Round 9): in kleinen Räumen steht
 * der User auf dem Centroid mittig zwischen Wänden und "sieht nur Wand egal
 * wohin er guckt". Wir starten an einer AABB-Ecke + Inset und blicken zur
 * diagonalen Gegenecke — Raum liegt damit vor dem Player, nicht um ihn herum.
 *
 * Capsule-Radius des Resolvers fängt jeden Edge-Case ab (Inset zu klein /
 * Punkt ausserhalb walkable wegen Holes) per vertex-snap-Fallback in
 * `resolveCameraCollision`.
 */
function preferredSpawn(
  poly: WalkablePolygon,
  capsuleRadius: number,
): { position: { x: number; z: number }; lookAt: { x: number; z: number } } | null {
  const bounds = walkableBounds(poly)
  if (!bounds) return null
  const inset = Math.max(capsuleRadius + 0.05, 0.5)
  const dx = bounds.maxX - bounds.minX
  const dz = bounds.maxZ - bounds.minZ
  // Bei sehr kleinen Räumen (< 2 Insets in beiden Achsen) lieber Centroid +
  // Yaw zu längster Achse — sonst kollidiert die Inset-Position selbst nach
  // Resolver-Snap mit der Wand und wir blockieren Movement direkt am Start.
  let position: { x: number; z: number }
  let lookAt: { x: number; z: number }
  if (dx < inset * 2 || dz < inset * 2) {
    const c = walkableCentroid(poly)
    if (!c) return null
    position = c
    lookAt = { x: c.x + (dx >= dz ? 1 : 0), z: c.z + (dx >= dz ? 0 : 1) }
  } else {
    position = { x: bounds.minX + inset, z: bounds.minZ + inset }
    lookAt = { x: bounds.maxX - inset, z: bounds.maxZ - inset }
  }
  // Garantiere, dass der Spawn INNERHALB des Raums liegt. Die AABB-Ecken- /
  // Centroid-Heuristik oben ist nur für konvexe / rechtwinklige Footprints
  // inside-sicher; eine per Ecken-Drag editierte L-/U-Form kann sie in
  // Totraum AUSSERHALB des walkable-Polygons setzen (und der zero-motion-
  // Resolver kann einen nicht-penetrierenden Aussenpunkt nicht reinziehen).
  // Fallback auf einen garantierten Innenpunkt → User spawnt immer im Raum.
  if (!isPointInWalkable({ x: position.x, y: 0, z: position.z }, poly)) {
    const interior = walkableInteriorPoint(poly)
    if (interior) {
      position = { x: interior.x, z: interior.z }
      // lookAt bleibt die Diagonale → der Raum öffnet sich vor dem Player.
    }
  }
  return { position, lookAt }
}

/** Yaw so the camera looks from `from` toward `to` (three.js convention:
 *  yaw=0 = looking -Z). */
function yawFromTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) < 0.01 && Math.abs(dz) < 0.01) return 0
  return Math.atan2(-dx, -dz)
}

export function WalkController({
  walkable,
  obstacles,
  initialPosition = [0, 0],
  onRoomChange: _onRoomChange,
  mobileJoystick = false,
  suppressJoystick = false,
}: WalkControllerProps): ReactElement {
  const { camera, gl } = useThree()
  const inputRef = useRef<{ forward: number; right: number; rotY: number }>({
    forward: 0,
    right: 0,
    rotY: 0,
  })
  const yawRef = useRef(0)
  // R7 Round 7: Pitch separat tracken (nach oben/unten schauen). Clamp
  // verhindert Backflip — bei π/2 würde die Camera senkrecht zeigen, danach
  // flippt three.js die Eulers via gimbal-lock. 0.05 rad ≈ 3° Sicherheit.
  const pitchRef = useRef(0)
  const PITCH_MAX = Math.PI / 2 - 0.05
  // Initial-Yaw zur Raum-Mitte (V1.6.1 Round 5): wenn der User Walk-Mode
  // betritt, soll er nicht auf eine zufällige Wand schauen. Wir richten die
  // Camera einmal beim Mount Richtung Centroid des walkable polygons aus.
  const initialYawRef = useRef<number | null>(null)
  // Mount-only guard for the spawn/position/yaw reset below. Its deps
  // [walkable, obstacles] get a FRESH identity every frame during an object
  // drag (setScene → new resolved → deriveWalkInputs allocates new arrays), so
  // without this the camera would re-spawn into the room corner on every
  // pointermove. Mirror of DollhouseController's `framedRef`.
  const spawnedRef = useRef(false)
  // positionRef.y holds the *capsule-feet* Y (0 by default; the R14 resolver
  // may lift it by STUCK_FALLBACK_Y_LIFT_M to break a corner wedge). The
  // camera-eye Y is rendered as EYE_HEIGHT_M + positionRef.y so the resolver-
  // owned lift survives across frames; otherwise the next frame would feed
  // y=0 back in, the resolver would lift again, and the camera would
  // oscillate (H-D5 audit-fix).
  const positionRef = useRef<{ x: number; y: number; z: number }>({
    x: initialPosition[0],
    y: 0,
    z: initialPosition[1],
  })

  // FOV bump für Walk-Mode (V1.6.1 Round 6). Restore beim unmount damit
  // Dollhouse/Floorplan/AR den ursprünglichen 50° wieder bekommen.
  /* eslint-disable react-hooks/immutability --
     `camera` ist die three.js PerspectiveCamera aus useThree(); `fov` ist ihre
     dokumentierte Mutations-API — es gibt keinen Hook, in den der FOV-Wechsel
     eines imperativen Walk-Controllers verschoben werden könnte. */
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    const previousFov = camera.fov
    camera.fov = WALK_FOV_DEG
    camera.updateProjectionMatrix()
    return () => {
      camera.fov = previousFov
      camera.updateProjectionMatrix()
    }
  }, [camera])
  /* eslint-enable react-hooks/immutability */

  // Initial-Position-Snap + Initial-Yaw (V1.6.1 Round 9, ersetzt Round-5-
  // Centroid-Spawn):
  // 1. Spawn an AABB-Ecke + Inset statt Centroid — User sieht Raum vor sich,
  //    nicht von der Mitte aus nur Wände.
  // 2. Resolver mit zero-motion: snappt Spawn in walkable polygon (vertex-
  //    snap-Fallback wenn Inset trotzdem outside oder zu nah an Wall).
  // 3. Yaw zur diagonal-gegenüber-Ecke: gibt maximalen Tiefenblick durch den
  //    Raum.
  // Bei degeneriert kleinen Räumen fällt `preferredSpawn` auf Centroid +
  // Längsachsen-Yaw zurück.
  useEffect(() => {
    // Run the spawn/position/yaw reset EXACTLY once (mount). Deps stay
    // [walkable, obstacles] so the per-frame resolver keeps live collision
    // data; this guard only stops the corner-teleport on every drag setScene.
    if (spawnedRef.current) return
    const spawn = preferredSpawn(walkable, CAPSULE.radius_m)
    if (spawn) {
      positionRef.current = {
        x: spawn.position.x,
        y: positionRef.current.y,
        z: spawn.position.z,
      }
    }
    const result = resolveCameraCollision({
      capsule: CAPSULE,
      position: positionRef.current,
      intendedMotion: { x: 0, y: 0, z: 0 },
      obstacles,
      walkable,
    })
    positionRef.current = {
      x: result.position.x,
      y: result.position.y,
      z: result.position.z,
    }
    if (spawn && initialYawRef.current === null) {
      const targetYaw = yawFromTo(
        { x: positionRef.current.x, z: positionRef.current.z },
        spawn.lookAt,
      )
      yawRef.current = targetYaw
      initialYawRef.current = targetYaw
    }
    spawnedRef.current = true
    // Frame-loop liest positionRef im nächsten tick; keine direkte camera-
    // mutation hier weil yaw + frame-loop sonst race konkurrieren.
  }, [walkable, obstacles])

  // ── Keyboard input ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const i = inputRef.current
      if (e.code === 'KeyW' || e.code === 'ArrowUp') i.forward = down ? 1 : 0
      else if (e.code === 'KeyS' || e.code === 'ArrowDown') i.forward = down ? -1 : 0
      else if (e.code === 'KeyD' || e.code === 'ArrowRight') i.right = down ? 1 : 0
      else if (e.code === 'KeyA' || e.code === 'ArrowLeft') i.right = down ? -1 : 0
    }
    const onDown = onKey(true)
    const onUp = onKey(false)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // ── Pointer-lock mouse yaw (desktop only) ──────────────────────────────
  // Pointer-lock silently fails on iOS Safari, so it is gated to non-touch
  // devices; touch devices use the swipe-yaw effect below. CD-9: the cleanup
  // releases the lock — without `exitPointerLock` the cursor stays captured
  // after the controller unmounts (mode switch / screen teardown).
  useEffect(() => {
    const isTouch =
      typeof window !== 'undefined' &&
      (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
    if (isTouch) return

    const dom = gl.domElement
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== dom) return
      // Möbel-Geste aktiv (Einrichten) → Look unterdrücken. Synchroner Store-Read
      // statt React-Prop = kein 1-Frame-Race wie beim Dollhouse-enableRotate-Gate.
      if (useCanonicalSceneStore.getState().objectInteractionLocked) return
      yawRef.current -= e.movementX * 0.0025
      // R7: Pitch via Y-axis-movement (clamped).
      pitchRef.current = Math.max(
        -PITCH_MAX,
        Math.min(PITCH_MAX, pitchRef.current - e.movementY * 0.0025),
      )
    }
    const onClick = () => {
      if (document.pointerLockElement !== dom) dom.requestPointerLock()
    }
    dom.addEventListener('click', onClick)
    document.addEventListener('mousemove', onMove)
    return () => {
      dom.removeEventListener('click', onClick)
      document.removeEventListener('mousemove', onMove)
      // CD-9 · release the pointer lock this controller acquired.
      if (document.pointerLockElement === dom) document.exitPointerLock()
    }
  }, [gl, PITCH_MAX])

  // ── Touch swipe-to-look yaw + pitch (mobile) ────────────────────────
  // R7: 1-finger-drag X-axis = yaw, Y-axis = pitch. Vorher nur yaw → User:
  // "ich kann nicht nach oben oder unten schauen". Pitch clamped damit kein
  // Gimbal-Flip beim senkrechten Hoch-/Runtergucken.
  useEffect(() => {
    const dom = gl.domElement
    // Fix2: Look-Finger per identifier tracken statt blind touches[0] zu lesen.
    // Bei 2 Fingern (Joystick + Look) ist touches[0] der Joystick-Finger; geht
    // ein Finger hoch/runter, wechselt touches[0] die Identität → riesiges
    // Delta → Yaw/Pitch springt. Wir adoptieren genau EINEN Finger und folgen
    // nur diesem.
    let lookId: number | null = null
    let lastX: number | null = null
    let lastY: number | null = null
    const onStart = (e: TouchEvent) => {
      if (lookId !== null) return
      const t = e.changedTouches[0]
      if (t) {
        lookId = t.identifier
        lastX = t.clientX
        lastY = t.clientY
      } else {
        lookId = null
        lastX = null
        lastY = null
      }
    }
    const onMove = (e: TouchEvent) => {
      // Den getrackten Finger NUR unter den Fingern auf dem Canvas suchen
      // (targetTouches) — der Joystick-Finger liegt auf seiner eigenen Zone und
      // taucht hier nie auf.
      const t = Array.from(e.targetTouches).find((tt) => tt.identifier === lookId)
      if (!t) return
      // Möbel-Geste aktiv (Einrichten) → Look unterdrücken. lastX/Y trotzdem
      // nachziehen, damit es beim Lösen keinen Sprung gibt. Synchroner Read.
      if (useCanonicalSceneStore.getState().objectInteractionLocked) {
        lastX = t.clientX
        lastY = t.clientY
        return
      }
      if (lastX === null || lastY === null) {
        lastX = t.clientX
        lastY = t.clientY
        return
      }
      yawRef.current -= (t.clientX - lastX) * 0.005
      pitchRef.current = Math.max(
        -PITCH_MAX,
        Math.min(PITCH_MAX, pitchRef.current - (t.clientY - lastY) * 0.005),
      )
      lastX = t.clientX
      lastY = t.clientY
    }
    const onEnd = (e: TouchEvent) => {
      // Nur zurücksetzen wenn WIRKLICH der getrackte Finger beendet wurde —
      // sonst killt das Loslassen des Joystick-Fingers den laufenden Look.
      if (
        lookId !== null &&
        Array.from(e.changedTouches).some((tt) => tt.identifier === lookId)
      ) {
        lookId = null
        lastX = null
        lastY = null
      }
    }
    dom.addEventListener('touchstart', onStart, { passive: true })
    dom.addEventListener('touchmove', onMove, { passive: true })
    dom.addEventListener('touchend', onEnd)
    dom.addEventListener('touchcancel', onEnd)
    return () => {
      dom.removeEventListener('touchstart', onStart)
      dom.removeEventListener('touchmove', onMove)
      dom.removeEventListener('touchend', onEnd)
      dom.removeEventListener('touchcancel', onEnd)
    }
  }, [gl, PITCH_MAX])

  // ── Mobile virtual joystick (custom · opt-in) ──────────────────────────
  // Fix3: nipplejs entfernt. Der dynamische `import('nipplejs')` konnte im
  // Capacitor-WebView scheitern (silent .catch) → kein Joystick; die an
  // document.body gehängte Library-Zone konnte beim WebGL-Remount verwaisen.
  // Ersetzt durch einen dependency-freien, SYNCHRONEN Custom-Touch-Joystick
  // (kein dynamischer Import, keine Library). Imperativ (document.createElement),
  // weil WalkController eine R3F-Komponente ist und kein DOM in den Canvas-Tree
  // rendern kann. Schreibt in DASSELBE inputRef wie Keyboard/Frame-Loop.
  useEffect(() => {
    // suppressJoystick tears the joystick down while an edit overlay is open:
    // the cleanup below (zone.remove() + forward/right = 0) runs when this flips
    // true, so the imperative z-index:70 node stops covering the sheet AND the
    // last joystick input can't keep driving the camera. Flipping it back false
    // re-creates the joystick (suppressJoystick is in the dep array).
    if (!mobileJoystick || suppressJoystick) return
    // Stabile inputRef-Identität einmal greifen, damit das Cleanup nicht
    // inputRef.current liest (sonst react-hooks/exhaustive-deps-Warnung). Das
    // Ref-Objekt wechselt nie die Identität → Reset im Cleanup bleibt korrekt.
    const input = inputRef.current
    // Zone (Liquid-Glass-Look unverändert) + zentrierter Knob.
    // bottom:200px hält Abstand zum Auswahl-Button (R10-Offset beibehalten);
    // background-opacity 0.06 lässt den 3D-View durchscheinen.
    const zone = document.createElement('div')
    // Stable identity for the imperative, body-appended orphan node (it has no
    // React key/ref, so this is the only reliable way to target it — for tests
    // and for any future stray-node cleanup).
    zone.setAttribute('data-walk-joystick', '')
    zone.style.cssText = [
      'position:fixed',
      'bottom:200px',
      'left:24px',
      'width:96px',
      'height:96px',
      // z-index MUSS über dem Fullscreen-Viewer-Portal liegen
      // (SpatialMultiModeViewer rendert via createPortal mit `z-[60]` an
      // document.body; der Joystick hängt ebenfalls an document.body). Mit
      // z-50 lag der Joystick UNTER dem Portal → unsichtbar/unklickbar (Grund
      // warum er im Craftsman-Editor nie erschien, im inline-Customer-Hub
      // [z-0] aber schon). 70 < Toast/Sheet-Ebene, > Viewer.
      'z-index:70',
      'border-radius:50%',
      'background:rgba(255,255,255,0.12)',
      'backdrop-filter:blur(12px)',
      '-webkit-backdrop-filter:blur(12px)',
      'border:1px solid rgba(255,255,255,0.30)',
      'box-shadow:0 4px 14px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.12)',
      'pointer-events:auto',
      'touch-action:none',
    ].join(';')
    const knob = document.createElement('div')
    knob.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:50%',
      'width:36px',
      'height:36px',
      'margin:-18px 0 0 -18px',
      'border-radius:50%',
      'background:rgba(255,255,255,0.9)',
      'pointer-events:none',
      'transform:translate(0px,0px)',
      'transition:transform 0.08s ease-out',
    ].join(';')
    zone.appendChild(knob)
    document.body.appendChild(zone)

    const R = 38 // max. Knob-Auslenkung in px
    let activeId: number | null = null
    const setKnob = (dx: number, dy: number) => {
      knob.style.transform = `translate(${dx}px,${dy}px)`
    }
    const apply = (e: PointerEvent) => {
      const rect = zone.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = e.clientX - cx
      const dy = e.clientY - cy
      const hyp = Math.hypot(dx, dy)
      const mag = Math.min(1, hyp / R)
      const nx = dx / (hyp || 1)
      const ny = dy / (hyp || 1)
      // Konvention wie der alte Handler: Finger nach oben (negatives screen-dy)
      // = vorwärts (forward=1), Finger nach rechts = right=1. Der Frame-Loop
      // rechnet forward/right via Yaw in Weltrichtung um.
      inputRef.current.forward = -ny * mag
      inputRef.current.right = nx * mag
      setKnob(nx * mag * R, ny * mag * R)
    }
    const reset = () => {
      activeId = null
      setKnob(0, 0)
      inputRef.current.forward = 0
      inputRef.current.right = 0
    }
    const onDown = (e: PointerEvent) => {
      if (activeId !== null) return
      activeId = e.pointerId
      zone.setPointerCapture(e.pointerId)
      apply(e)
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return
      apply(e)
    }
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activeId) return
      reset()
    }
    zone.addEventListener('pointerdown', onDown)
    zone.addEventListener('pointermove', onMove)
    zone.addEventListener('pointerup', onUp)
    zone.addEventListener('pointercancel', onUp)
    return () => {
      zone.removeEventListener('pointerdown', onDown)
      zone.removeEventListener('pointermove', onMove)
      zone.removeEventListener('pointerup', onUp)
      zone.removeEventListener('pointercancel', onUp)
      zone.remove()
      input.forward = 0
      input.right = 0
    }
  }, [mobileJoystick, suppressJoystick])

  // ── Floor-Hint Shape (V1.6.1 Round 5) ──────────────────────────────────
  // CAD-Grade Walk: ein subtiler Glow auf der walkable-Fläche zeigt dem
  // User WO er gehen kann. Wichtig wenn die Raum-Geometrie noch unklar ist
  // (Material/Light P2 noch nicht fertig) — Floor-Hint als "this is the
  // ground" Anker. Material ist additive-blendish (transparent, depthWrite
  // off, niedrige opacity) damit Boden + Möbel darüber lesbar bleiben.
  const floorHintShape = useMemo<Shape | null>(() => {
    if (!walkable.outer.length) return null
    // Shape-Y-Negation-Convention (wie FloorAdapter): das Mesh kippt per
    // rotation=[-π/2,0,0] in die XZ-Ebene → World-Z = −Shape-Y. Ohne `-z` läge
    // der Walkable-Hint z-gespiegelt um die World-Origin, also auf der falschen
    // Seite gegenüber dem Player (true frame, +z) und dem korrigierten Floor.
    // Unlit meshBasicMaterial + DoubleSide → Windung egal, nur die z-Negation zählt.
    const shape = new Shape()
    walkable.outer.forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, -p.z)
      else shape.lineTo(p.x, -p.z)
    })
    shape.closePath()
    for (const hole of walkable.holes) {
      if (!hole.length) continue
      const path = new Shape()
      hole.forEach((p, i) => {
        if (i === 0) path.moveTo(p.x, -p.z)
        else path.lineTo(p.x, -p.z)
      })
      path.closePath()
      shape.holes.push(path)
    }
    return shape
  }, [walkable])

  // ── Frame loop ─────────────────────────────────────────────────────────
  /* eslint-disable react-hooks/immutability --
     Die Per-Frame-Mutation der `camera` aus useThree() (position / rotation.order
     / rotation) ist der Kern eines imperativen Walk-Controllers — es gibt keinen
     Hook, in den die Frame-Loop-Kamera-Steuerung verschoben werden könnte. */
  useFrame((_state, delta) => {
    const i = inputRef.current
    const pos = positionRef.current
    if (i.forward === 0 && i.right === 0) {
      camera.position.set(pos.x, EYE_HEIGHT_M + pos.y, pos.z)
      // R7: rotation order YXZ damit Pitch um lokale X-Achse läuft nachdem
      // Yaw um Y rotiert hat (FPS-Standard). Mit Default-XYZ käme der
      // Pitch um die WORLD-X-Achse → strafing-pitch-coupling.
      camera.rotation.order = 'YXZ'
      camera.rotation.set(pitchRef.current, yawRef.current, 0)
      // Probe-Raycasts (SurfaceTapLayer / Edit-Layer) lesen camera.matrixWorld
      // synchron beim Tap. Ohne expliziten Update wäre er bis zum nächsten
      // Render 1 Frame stale → Tap landet minimal versetzt (auch beim reinen
      // Umsehen ändert sich pitch/yaw). Hier aktuell halten.
      camera.updateMatrixWorld()
      return
    }
    const dt = Math.min(delta, 0.05) // clamp big spikes
    const yaw = yawRef.current
    // Local forward = -Z when yaw=0 in three.js; we treat +forward as -Z
    const fx = -Math.sin(yaw) * i.forward + Math.cos(yaw) * i.right
    const fz = -Math.cos(yaw) * i.forward - Math.sin(yaw) * i.right
    const step = WALK_SPEED_MPS * dt
    const intendedMotion = new Vector3(fx * step, 0, fz * step)
    const result = resolveCameraCollision({
      capsule: CAPSULE,
      // Feed the resolver the *capsule-feet* Y from last frame so a Y-lift
      // applied to break a wedge persists; otherwise the resolver would
      // re-lift every frame and the camera would oscillate.
      position: { x: pos.x, y: pos.y, z: pos.z },
      intendedMotion: { x: intendedMotion.x, y: 0, z: intendedMotion.z },
      obstacles,
      walkable,
    })
    positionRef.current = {
      x: result.position.x,
      y: result.position.y,
      z: result.position.z,
    }
    camera.position.set(
      positionRef.current.x,
      EYE_HEIGHT_M + positionRef.current.y,
      positionRef.current.z,
    )
    camera.rotation.order = 'YXZ'
    camera.rotation.set(pitchRef.current, yaw, 0)
    camera.updateMatrixWorld() // s.o. — Matrix für Probe-Raycasts aktuell halten
  })
  /* eslint-enable react-hooks/immutability */

  return floorHintShape ? (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0.015, 0]}
      renderOrder={2}
    >
      <shapeGeometry args={[floorHintShape]} />
      <meshBasicMaterial
        color="#5fa8e8"
        transparent
        opacity={0.085}
        side={DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  ) : (
    <></>
  )
}
