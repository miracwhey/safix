/**
 * Spatial · Canonical · Three · SurfaceTapLayer (V1.6.1 R14 · multi-probe)
 *
 * In-Canvas r3f component that captures a TAP and reports the resolved
 * canonical node. R14 rewrites the pick pipeline from "trust r3f's cached
 * event.intersections" to "RUN A FRESH RAYCAST every tap":
 *
 *   1. pointerdown → 9-Point-Probe via the canonical raycaster against the
 *      CURRENT scene state. Bypasses the frame-lag race where r3f's
 *      pointer-event-handler ran against a stale intersection cache from a
 *      prior render frame (Cutaway-Toggle / Wall-Visibility flip between
 *      frames was the dominant source of "tapped wand A, wand B selected").
 *   2. Each probe sample resolves to a (kind, nodeId) via the existing
 *      visibility-walk in `resolveTappedSurface` — invisible-parent meshes
 *      contribute null and are skipped.
 *   3. Aggregate samples via `voteWinner` — most-voted surface wins (ties by
 *      nearest distance). Robust against finger-fat + DPR-3 scaling drift.
 *
 * Debug mode (`?picking=debug` or `localStorage.picking_debug = '1'`) logs
 * the full probe-sample table per tap and renders a Crosshair + Spheres
 * overlay via DebugPickOverlay.
 *
 * Tap-vs-Drag (R12.1) preserved: pointermove > 8px cancels pending tap.
 * Pointer-cancel + pointer-up clear too.
 */

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { Raycaster, Vector2 } from 'three'

import {
  objectCandidatesByDepth,
  PROBE_OFFSETS_PX,
  resolveTappedSurface,
  voteWinner,
  type ProbeSample,
  type TappedSurface,
} from './surfaceTap'
import { bindRaycasterToPickLayer } from './pickLayer'
import { isPickDebugEnabled, publishDebugPickFrame } from './pickDebug'
import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore'

/** Max Bildschirm-Distanz (CSS-Pixel) zwischen down + up um als Tap zu zählen. */
const TAP_DISTANCE_PX = 8
/** Max Zeit (ms) zwischen down + up um als Tap zu zählen. */
const TAP_TIME_MS = 350
/** Wiederholter Tap innerhalb dieses Radius (CSS-px) am selben Punkt blättert
 *  durch gestapelte Objekte, statt erneut nur das vorderste zu wählen. */
const CYCLE_RADIUS_PX = 28
/** Nach dieser Pause (ms) ohne Tap am selben Punkt startet die Auswahl frisch
 *  beim vordersten Objekt — kein überraschendes Weiter-Cyclen Minuten später. */
const CYCLE_WINDOW_MS = 3000

interface PendingTap {
  pointerId: number
  startX: number
  startY: number
  startTime: number
  tapped: TappedSurface
  point: { x: number; y: number; z: number } | undefined
}

export interface SurfaceTapLayerProps {
  /** `false` ⇒ taps pass through (view mode). */
  enabled: boolean
  /** Called with the resolved node when a canonical surface is tapped. */
  onTap: (surface: TappedSurface) => void
  /**
   * Scene content that the layer wraps. Pointer-events on these descendants
   * bubble through this `<group>`'s `onPointerDown` handler. MUST wrap the
   * adapter groups (`wall-*` / `floor-*` / `ceiling-*` / `object-*`).
   */
  children?: ReactNode
}

/**
 * Probe-only raycaster. Separate from r3f's internal event-raycaster so we
 * (a) bind it to PICK_LAYER explicitly and (b) avoid mutating r3f's shared
 * instance. Stable across renders; configured once in init effect.
 */
function useProbeRaycaster(): Raycaster {
  // useState lazy-init gives a stable instance across renders without touching
  // a ref during render (react-hooks/refs). The Raycaster is created once.
  const [raycaster] = useState(() => new Raycaster())
  useEffect(() => {
    bindRaycasterToPickLayer(raycaster)
  }, [raycaster])
  return raycaster
}

export function SurfaceTapLayer({ enabled, onTap, children }: SurfaceTapLayerProps): ReactElement {
  const pendingRef = useRef<PendingTap | null>(null)
  // Tap-Cycle-Anker: Bildschirmpunkt + zuletzt gewähltes Objekt des letzten
  // Taps. Ein erneuter Tap am selben Punkt blättert ab hier zum nächsten
  // (tieferen) Objekt; ein Tap woanders / nach Fenster-Ablauf setzt zurück.
  const lastObjectTapRef = useRef<{
    x: number
    y: number
    time: number
    objectId: string
  } | null>(null)
  const probeRaycaster = useProbeRaycaster()
  const { camera, scene, gl } = useThree()

  const handlePointerDown = (event: ThreeEvent<PointerEvent>): void => {
    if (!enabled) return
    const native = event.nativeEvent
    const rect = gl.domElement.getBoundingClientRect()
    const baseX = native.clientX - rect.left
    const baseY = native.clientY - rect.top
    const w = rect.width
    const h = rect.height
    if (w <= 0 || h <= 0) return

    const ndc = new Vector2()
    const samples: ProbeSample[] = []
    // BUG-2 fix: the per-sample loop below keeps only the NEAREST surface, so a
    // fully-occluded object (a chair entirely behind a table at every probe
    // point) never becomes a vote sample → tap-cycle could not reach it. Collect
    // EVERY object hit across all probe samples here; `objectCandidatesByDepth`
    // dedups by nodeId (nearest) so the cycle walks the full front→back stack.
    const objectHits: ProbeSample[] = []
    const debug = isPickDebugEnabled()
    const debugSamples: Array<{
      dx: number
      dy: number
      kind: TappedSurface['kind'] | null
      nodeId: string | null
      distance: number
      point?: { x: number; y: number; z: number }
    }> = []

    for (const [dx, dy] of PROBE_OFFSETS_PX) {
      const sx = baseX + dx
      const sy = baseY + dy
      // CSS-px → NDC. Same convention as r3f's internal compute.
      ndc.set((sx / w) * 2 - 1, -(sy / h) * 2 + 1)
      probeRaycaster.setFromCamera(ndc, camera)
      // recursive=true; scene includes all adapter groups. Raycaster.layers
      // is bound to PICK_LAYER so only PickProxy meshes are hit.
      const hits = probeRaycaster.intersectObjects(scene.children, true)
      // Filter: skip hits whose ancestor chain has `.visible === false`.
      // Defense-in-depth against any residual layer-toggle race.
      let nearestSurface: TappedSurface | null = null
      let nearestDistance = Number.POSITIVE_INFINITY
      let nearestPoint: { x: number; y: number; z: number } | undefined
      for (const hit of hits) {
        const surface = resolveTappedSurface(hit.object)
        if (!surface) continue
        const hitPoint = hit.point
          ? { x: hit.point.x, y: hit.point.y, z: hit.point.z }
          : undefined
        // Every object hit feeds the depth-cycle candidate list (incl. occluded).
        if (surface.kind === 'object') {
          objectHits.push({ surface, distance: hit.distance, point: hitPoint })
        }
        if (hit.distance < nearestDistance) {
          nearestSurface = surface
          nearestDistance = hit.distance
          nearestPoint = hitPoint
        }
      }
      samples.push({
        surface: nearestSurface,
        distance: nearestDistance,
        point: nearestPoint,
      })
      if (debug) {
        debugSamples.push({
          dx,
          dy,
          kind: nearestSurface?.kind ?? null,
          nodeId: nearestSurface?.nodeId ?? null,
          distance: nearestDistance,
          point: nearestPoint,
        })
      }
    }

    const winner = voteWinner(samples)

    if (debug) {
      // eslint-disable-next-line no-console
      console.table(
        debugSamples.map((s) => ({
          dx: s.dx,
          dy: s.dy,
          kind: s.kind ?? '-',
          nodeId: s.nodeId ?? '-',
          dist: Number.isFinite(s.distance) ? s.distance.toFixed(3) : '∞',
        })),
      )
      // eslint-disable-next-line no-console
      console.log('[pick.debug] winner', winner?.surface ?? null)
      publishDebugPickFrame({
        clientX: native.clientX,
        clientY: native.clientY,
        samples: debugSamples,
        winner: winner?.surface ?? null,
        timestamp: performance.now(),
      })
    }

    if (!winner) return

    // Tap-Cycle: ist der natürliche Gewinner ein Objekt UND tippt der Nutzer
    // erneut (innerhalb des Fensters) auf denselben Punkt, blättere zum nächsten
    // Objekt in der Tiefe — sonst bleibt ein verdecktes Möbel ("Stuhl unter
    // Tisch") unerreichbar. Wand/Boden/Decke bleiben unberührt.
    let tapped: TappedSurface = winner.surface
    let point = winner.point
    if (winner.surface.kind === 'object') {
      const candidates = objectCandidatesByDepth(objectHits)
      const last = lastObjectTapRef.current
      if (last && candidates.length >= 2) {
        const sameSpot =
          performance.now() - last.time <= CYCLE_WINDOW_MS &&
          Math.hypot(native.clientX - last.x, native.clientY - last.y) <= CYCLE_RADIUS_PX
        // BUG-1 fix: only keep cycling while the last-cycled object is STILL the
        // selected one. A deselect via any other path ("Fertig" / X → clearFocus)
        // leaves the anchor behind; without this gate a same-spot re-tap within
        // the window would jump to the BACK object instead of re-picking front.
        const stillFocused =
          useCanonicalSceneStore.getState().focusedObjectId === last.objectId
        if (sameSpot && stillFocused) {
          const anchorIdx = candidates.findIndex((c) => c.nodeId === last.objectId)
          if (anchorIdx >= 0) {
            const next = candidates[(anchorIdx + 1) % candidates.length]
            tapped = { kind: 'object', nodeId: next.nodeId }
            point = next.point
          }
        }
      }
    }

    pendingRef.current = {
      pointerId: event.pointerId,
      startX: native.clientX,
      startY: native.clientY,
      startTime: performance.now(),
      tapped,
      point,
    }
    // Bewusst KEIN stopPropagation hier — OrbitControls darf Rotation starten.
  }

  const handlePointerMove = (event: ThreeEvent<PointerEvent>): void => {
    const pending = pendingRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    const dx = event.nativeEvent.clientX - pending.startX
    const dy = event.nativeEvent.clientY - pending.startY
    if (Math.hypot(dx, dy) > TAP_DISTANCE_PX) {
      pendingRef.current = null
    }
  }

  const handlePointerUp = (event: ThreeEvent<PointerEvent>): void => {
    const pending = pendingRef.current
    if (!pending || pending.pointerId !== event.pointerId) return
    pendingRef.current = null
    const dx = event.nativeEvent.clientX - pending.startX
    const dy = event.nativeEvent.clientY - pending.startY
    const elapsed = performance.now() - pending.startTime
    if (Math.hypot(dx, dy) > TAP_DISTANCE_PX) return
    if (elapsed > TAP_TIME_MS) return
    event.stopPropagation()
    // Tap-Cycle-Anker pflegen: bei Objekt merken (Punkt + id) für den nächsten
    // Tap; bei Wand/Boden/Decke zurücksetzen, damit das nächste Objekt-Tippen
    // wieder vorne beginnt.
    if (pending.tapped.kind === 'object') {
      lastObjectTapRef.current = {
        x: pending.startX,
        y: pending.startY,
        time: performance.now(),
        objectId: pending.tapped.nodeId,
      }
    } else {
      lastObjectTapRef.current = null
    }
    onTap(pending.point ? { ...pending.tapped, point: pending.point } : pending.tapped)
  }

  const handlePointerCancel = (event: ThreeEvent<PointerEvent>): void => {
    const pending = pendingRef.current
    if (pending && pending.pointerId === event.pointerId) pendingRef.current = null
  }

  return (
    <group
      name="edit-surface-tap-layer"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {children}
    </group>
  )
}
