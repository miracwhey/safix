/**
 * Spatial · Canonical · Three · RotationDial (V1.6.1 Phase 5c)
 *
 * A flat ring on the floor around the selected floor object's base, with a
 * draggable handle knob. Dragging the knob rotates the object live in 15°
 * steps (`rotation_around_y_deg`). 3D-in-scene (perspectively correct), NOT a
 * DOM overlay.
 *
 * Mounted as a SIBLING of the gesture/tap layers (never inside them) so the
 * knob's r3f pointer events stay isolated from the drag/pinch layer. The knob
 * is a normal layer-0 mesh, so r3f's internal event raycaster hits it (the
 * pick proxies live on PICK_LAYER and are invisible to it).
 *
 * While dragging, the camera is locked (`objectInteractionLocked`) so the
 * DollhouseController stops orbiting. Release final-validates implicitly (the
 * orchestrator re-validates each step and holds the last valid angle on a
 * rejected rotation) and commits via `onTransformCommit`.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { Plane, Raycaster, Vector2, Vector3 } from 'three'

import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore'
import { setFurnitureRotationDeg } from '../../../../lib/spatial/canonical/workflow/customerFurnitureOrchestrator'
import type { RoomScene } from '../../../../lib/spatial/canonical/types/scene-graph'

const FLOOR_PLANE = new Plane(new Vector3(0, 1, 0), 0)

export interface RotationDialProps {
  /** Selected floor object id the dial rotates. */
  objectId: string
  /** Called on knob release with the live scene → host schedules persist. */
  onTransformCommit?: (scene: RoomScene) => void
}

export function RotationDial({ objectId, onTransformCommit }: RotationDialProps): ReactElement | null {
  const { camera, gl, invalidate } = useThree()
  const object = useCanonicalSceneStore(
    (s) => s.scene?.floor.floor_mounted.find((o) => o.id === objectId) ?? null,
  )
  const setStoreScene = useCanonicalSceneStore((s) => s.setScene)
  const setObjectInteractionLocked = useCanonicalSceneStore((s) => s.setObjectInteractionLocked)
  const [raycaster] = useState(() => new Raycaster())
  const draggingRef = useRef(false)
  // Active DOM-listener teardown — invoked on knob-up AND on unmount (so a
  // selection-clear mid-drag never leaks listeners or a locked camera).
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cleanupRef.current?.()
    },
    [],
  )

  if (!object) return null

  const cx = object.transform?.position?.x ?? 0
  const cz = object.transform?.position?.z ?? 0
  const sx = object.transform?.scale?.x ?? 1
  const sz = object.transform?.scale?.z ?? 1
  const halfW = (object.dimensions.width_m * sx) / 2
  const halfD = (object.dimensions.depth_m * sz) / 2
  const radius = Math.hypot(halfW, halfD) + 0.18
  const rad = ((object.rotation_around_y_deg ?? 0) * Math.PI) / 180
  // Knob tracks the object's local +X under Ry(θ): (cosθ, 0, −sinθ).
  const knobLocalX = radius * Math.cos(rad)
  const knobLocalZ = -radius * Math.sin(rad)

  const floorPointAt = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const rect = gl.domElement.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    if (w <= 0 || h <= 0) return null
    const ndc = new Vector2(((clientX - rect.left) / w) * 2 - 1, -(((clientY - rect.top) / h) * 2 - 1))
    raycaster.setFromCamera(ndc, camera)
    const target = new Vector3()
    if (!raycaster.ray.intersectPlane(FLOOR_PLANE, target)) return null
    return { x: target.x, z: target.z }
  }

  const onKnobDown = (event: ThreeEvent<PointerEvent>): void => {
    event.stopPropagation()
    draggingRef.current = true
    setObjectInteractionLocked(true)
    const el = gl.domElement

    const onMove = (ev: PointerEvent): void => {
      if (!draggingRef.current) return
      const fp = floorPointAt(ev.clientX, ev.clientY)
      if (!fp) return
      // Invert the knob mapping: knob at (cosθ, −sinθ) ⇒ θ = atan2(−dz, dx).
      const angleDeg = (Math.atan2(-(fp.z - cz), fp.x - cx) * 180) / Math.PI
      const base = useCanonicalSceneStore.getState().scene
      if (!base) return
      const result = setFurnitureRotationDeg({ scene: base, objectId, deg: angleDeg })
      if (result.kind === 'updated') {
        setStoreScene(result.scene)
        invalidate()
      }
      // rejected (rotated footprint leaves the room) → hold the last valid angle.
    }

    const teardown = (): void => {
      draggingRef.current = false
      setObjectInteractionLocked(false)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      cleanupRef.current = null
    }
    const onUp = (): void => {
      teardown()
      const committed = useCanonicalSceneStore.getState().scene
      if (committed) onTransformCommit?.(committed)
    }

    cleanupRef.current = teardown
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  return (
    <group position={[cx, 0, cz]} name={`rotation-dial-${objectId}`}>
      {/* Ring flat on the floor (non-interactive — only the knob is grabbable). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]} raycast={() => null} renderOrder={2}>
        <ringGeometry args={[radius - 0.02, radius + 0.02, 64]} />
        <meshBasicMaterial color="#ffd479" transparent opacity={0.5} depthTest={false} />
      </mesh>
      {/* Drag handle. */}
      <mesh position={[knobLocalX, 0.05, knobLocalZ]} onPointerDown={onKnobDown} renderOrder={3}>
        <sphereGeometry args={[0.06, 20, 20]} />
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </mesh>
    </group>
  )
}
