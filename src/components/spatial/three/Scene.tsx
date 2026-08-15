/**
 * Spatial Core · Block E2 · three.js + r3f Scene
 *
 * Heavy chunk — only mounted via the SpatialViewer Suspense boundary, so a
 * route that never renders a scan keeps the main bundle small.
 *
 * Responsibilities:
 *   * Mount glb with the Meshopt + KTX2 wired loader (Block X output).
 *   * Switch between perspective and orthographic top-down camera.
 *   * Snap the top-down rotation to cardinal angles (0/90/180/270°).
 *   * Surface raycast hits in `edit` mode → `onPinPlaced` (consumed by F).
 *   * Render `<AnchorPins>` + `<MeasurementLines>` overlays.
 *
 * `frameloop="demand"` keeps battery low on static scenes — we explicitly
 * `invalidate()` whenever annotation props change so realtime updates
 * still repaint. OrbitControls auto-invalidates during user input + the
 * damping decay window, so snap + reset transitions tick to completion
 * without an always-on loop.
 *
 * Out of scope here:
 *   * Section-Cut slider (E3, D12).
 *   * Pin-Editor BottomSheet + Reticle UX (F).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Bounds, OrbitControls, useBounds } from '@react-three/drei'
import { Plane, Vector3 } from 'three'
import type { Group, Material, Mesh, Object3D, WebGLRenderer } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { SpatialViewerProps } from '../SpatialViewer'
import { WebGLContextRecovery } from './WebGLContextRecovery'
import type { RoomScene as RoomSceneT } from '../../../lib/spatial/canonical/types/scene-graph'
import {
  disposeSpatialLoaders,
  makeSpatialGltfLoader,
} from './loaders/MeshoptGLTFLoader'
import { AnchorPins } from './AnchorPins'
import { MeasurementLines, type MeasurementLinesProps } from './MeasurementLines'
import { snapToCardinal } from './snapHelpers'
import { useHaptics } from '../../../hooks/useHaptics'
import type { SpatialControlsState } from './Controls'

export interface SceneProps extends SpatialViewerProps {
  controlState: SpatialControlsState
  /** Bumps each time `<SpatialViewer>` wants the camera to recenter. */
  resetNonce: number
}

export default function Scene(props: SceneProps) {
  // WebGL context-loss recovery remount key (see WebGLContextRecovery). On a
  // lost context that the GPU never restores on its own, bumping this rebuilds
  // the canvas; on the common path the GPU restores it and this never changes.
  const [glEpoch, setGlEpoch] = useState(0)
  const remountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleGlLost = useCallback(() => {
    if (remountTimerRef.current) clearTimeout(remountTimerRef.current)
    remountTimerRef.current = setTimeout(() => {
      remountTimerRef.current = null
      setGlEpoch((n) => n + 1)
    }, 1200)
  }, [])
  const handleGlRestored = useCallback(() => {
    if (remountTimerRef.current) {
      clearTimeout(remountTimerRef.current)
      remountTimerRef.current = null
    }
  }, [])
  useEffect(
    () => () => {
      if (remountTimerRef.current) clearTimeout(remountTimerRef.current)
    },
    [],
  )

  return (
    <Canvas
      key={glEpoch}
      frameloop="demand"
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        // Required for `Material.clippingPlanes` to take effect (Block E3
        // section-cut). Three.js ignores per-material planes silently
        // unless the renderer-level flag is on.
        gl.localClippingEnabled = true
      }}
      shadows={false}
      camera={{ position: [3, 2.4, 4], fov: 55 }}
      dpr={[1, 2]}
      data-testid="spatial-scene-canvas"
    >
      <WebGLContextRecovery
        context="legacy-scene"
        onLost={handleGlLost}
        onRestored={handleGlRestored}
      />
      <color attach="background" args={['#0b0b0b']} />
      <hemisphereLight args={[0xffffff, 0x404040, 1.1]} />
      <directionalLight position={[5, 8, 5]} intensity={0.8} />

      <Suspense fallback={null}>
        {/* `observe` removed: iOS Safari collapses the address bar on scroll
            and dispatches a `resize` — Bounds' observer would then re-fit
            the camera mid-orbit, snapping the view back. Initial fit is
            performed once by <ScanMesh>; manual recenter via Home button
            uses CameraResetController + the resetNonce.
            `key={gltfUrl}` resets SceneContent on URL change so a failed
            load on the previous URL does not stick around — much cleaner
            than a manual setLoadError(null) inside the effect. */}
        <Bounds fit clip margin={1.05}>
          <SceneContent key={props.gltfUrl} {...props} />
        </Bounds>
      </Suspense>
      {props.sectionCut?.enabled ? <SectionCutApplier sectionCut={props.sectionCut} /> : null}

      <OrbitControls
        makeDefault
        enablePan
        enableZoom
        enableRotate
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.6}
        zoomSpeed={0.9}
        minDistance={0.6}
        maxDistance={30}
      />

      {props.controlState.topDown ? <TopDownSnap /> : null}
      <CameraResetController nonce={props.resetNonce} />
      <RepaintOnPropChange
        pins={props.pins}
        measurements={props.measurements}
        visibleLayers={props.controlState.visibleLayers}
        topDown={props.controlState.topDown}
      />
    </Canvas>
  )
}

interface LoadedGltf {
  scene: Group
}

function SceneContent(props: SceneProps) {
  const gl = useThree(state => state.gl)
  const invalidate = useThree(state => state.invalidate)
  const [gltf, setGltf] = useState<LoadedGltf | null>(null)
  const [loadError, setLoadError] = useState<Error | null>(null)
  // Track the currently-mounted scene graph so URL changes can dispose the
  // previous one before adopting the new one (review P0-2 — without this
  // the [gltf] cleanup effect only fires on full unmount, leaking the
  // previous GPU buffers on every URL refresh).
  const mountedSceneRef = useRef<LoadedGltf | null>(null)

  // Manual load — bypasses r3f's URL-keyed loader cache so the configured
  // KTX2Loader stays bound to the renderer that owns it (review B2).
  //
  // Phase 5 (V1.6) · `props.onReady` fires once after the scene graph is
  // attached + the first `invalidate()` queued. Deferred one rAF tick so
  // the perf-KPI measurement reflects real first-draw, not "load completed
  // but next frame hasn't rendered yet". Optional prop — legacy callers
  // without `onReady` see unchanged behaviour.
  const onReady = props.onReady
  useEffect(() => {
    let cancelled = false
    const loader = makeSpatialGltfLoader(gl)
    loader
      .loadAsync(props.gltfUrl)
      .then(result => {
        if (cancelled) return
        const next = result as LoadedGltf
        // Dispose any previously-mounted scene before adopting the next so
        // a URL refresh frees the old GPU buffers instead of leaking them.
        if (mountedSceneRef.current && mountedSceneRef.current !== next) {
          disposeSceneGraph(mountedSceneRef.current.scene)
        }
        mountedSceneRef.current = next
        setGltf(next)
        invalidate()
        if (onReady) {
          // Push to next animation frame so the user-timing mark captures
          // post-paint, not just post-loader-resolve. Falls back to a
          // microtask when rAF is unavailable (vitest jsdom node env).
          const fire = () => {
            if (cancelled) return
            onReady()
          }
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(fire)
          } else {
            void Promise.resolve().then(fire)
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err : new Error(String(err)))
      })
    return () => {
      cancelled = true
    }
  }, [gl, invalidate, props.gltfUrl, onReady])

  // Dispose loaders + scene resources on canvas unmount — prevents WASM
  // worker pool leaks (review H4) + GPU buffer leaks on remount.
  useEffect(() => {
    return () => {
      if (mountedSceneRef.current) {
        disposeSceneGraph(mountedSceneRef.current.scene)
        mountedSceneRef.current = null
      }
      disposeSpatialLoaders(gl)
    }
  }, [gl])

  const surfaceEndpoints = useMemo(() => {
    if (props.roomScene) return collectSurfaceEndpointsFromRoomScene(props.roomScene)
    return gltf ? collectSurfaceEndpointsFromMesh(gltf.scene) : {}
  }, [props.roomScene, gltf])

  if (loadError) {
    // Surface the failure to the host component via a thrown error so the
    // SpatialViewer-level ErrorBoundary can show a Retry CTA. Without this
    // the canvas just sat black on failed GLB loads.
    throw loadError
  }

  if (!gltf) {
    return null
  }

  return (
    <>
      <ScanMesh scene={gltf.scene} mode={props.mode} onPinPlaced={props.onPinPlaced} />
      <AnchorPins
        annotations={props.pins ?? []}
        visible={props.controlState.visibleLayers.has('pins')}
        onPinSelected={props.onPinSelected}
        selectedId={props.selectedPinId}
      />
      <MeasurementLines
        measurements={props.measurements ?? []}
        surfaceEndpoints={surfaceEndpoints}
        visible={props.controlState.visibleLayers.has('measurements')}
      />
    </>
  )
}

interface ScanMeshProps {
  scene: Group
  mode: 'view' | 'edit'
  onPinPlaced?: SpatialViewerProps['onPinPlaced']
}

function ScanMesh({ scene, mode, onPinPlaced }: ScanMeshProps) {
  const bounds = useBounds()
  const fittedRef = useRef(false)

  // Fit camera once on initial mount — re-fitting on every render fights
  // the user every time they orbit.
  useEffect(() => {
    if (!bounds || !scene || fittedRef.current) return
    bounds.refresh(scene).fit()
    fittedRef.current = true
  }, [bounds, scene])

  const onClick = useCallback(
    (e: {
      uv?: { x: number; y: number }
      object?: Object3D
      point?: { x: number; y: number; z: number }
      stopPropagation: () => void
    }) => {
      if (mode !== 'edit' || !onPinPlaced) return
      if (!e.uv) return
      const surface = e.object?.name?.trim() || e.object?.uuid || ''
      if (!surface) return
      e.stopPropagation()
      onPinPlaced({
        surfaceExternalId: surface,
        uv: [e.uv.x, e.uv.y],
        worldXyz: e.point ? { x: e.point.x, y: e.point.y, z: e.point.z } : undefined,
      })
    },
    [mode, onPinPlaced],
  )

  return <primitive object={scene} onClick={onClick} />
}

/**
 * In top-down mode, gently nudge the OrbitControls azimuth toward the
 * nearest cardinal angle. Fires a haptic on snap-acquire (200ms throttled
 * via the per-mode bucket in `useHaptics`); re-entering the snap zone
 * after leaving it fires the haptic again (the `lastSnappedRef` reset on
 * exit makes this explicit).
 */
function TopDownSnap() {
  const haptics = useHaptics()
  const lastSnappedRef = useRef<number | null>(null)

  useFrame(state => {
    // `state.controls` is set by drei's `<OrbitControls makeDefault>` — but
    // can be null for one frame before the controls effect runs. Resolve
    // every tick instead of caching so a late-binding controls instance
    // still gets hooked up (review H8).
    const controls = state.controls as unknown as OrbitControlsImpl | null
    if (!controls || typeof controls.getAzimuthalAngle !== 'function') return
    const azimuth = controls.getAzimuthalAngle()
    const { angle, didSnap } = snapToCardinal(azimuth)
    if (didSnap) {
      const delta = Math.abs(angle - azimuth)
      if (delta > 1e-3 && typeof controls.setAzimuthalAngle === 'function') {
        controls.setAzimuthalAngle(angle)
        state.invalidate()
        if (lastSnappedRef.current !== angle) {
          haptics.selection()
          lastSnappedRef.current = angle
        }
      }
    } else {
      lastSnappedRef.current = null
    }
  })

  return null
}

function CameraResetController({ nonce }: { nonce: number }) {
  const bounds = useBounds()
  const invalidate = useThree(state => state.invalidate)
  const lastNonce = useRef(nonce)

  useEffect(() => {
    if (nonce === lastNonce.current) return
    lastNonce.current = nonce
    if (bounds) {
      bounds.refresh().fit()
      invalidate()
    }
  }, [nonce, bounds, invalidate])

  return null
}

/** Forces a repaint when annotation lists or layer toggles change. With
 *  `frameloop="demand"` r3f only renders on user input + invalidate calls
 *  — a new pin arriving via realtime would otherwise stay invisible. */
function RepaintOnPropChange(props: {
  pins?: unknown
  measurements?: unknown
  visibleLayers: unknown
  topDown: boolean
}) {
  const invalidate = useThree(state => state.invalidate)
  useEffect(() => {
    invalidate()
  }, [
    invalidate,
    props.pins,
    props.measurements,
    props.visibleLayers,
    props.topDown,
  ])
  return null
}

/**
 * V-04 (L2-F): build the `MeasurementLines` endpoint map directly from the
 * canonical `RoomScene.walls[]`. Each wall carries `start_point` + `end_point`
 * in world space (Swift `CanonicalConverter` writes them; the TS bridge
 * derives them from transform + width if missing). `Wall.id` is identity-
 * mapped to `scan_surfaces.id` (the bridge's `canonicalIdForSurface`), so
 * the keys join straight onto `scan_measurements.surfaceId` without a
 * mesh.name lookup. The line sits at half-wall height for visual clarity —
 * a thin band that hugs the centerline rather than the BBox diagonal that
 * the legacy traverse used.
 */
function collectSurfaceEndpointsFromRoomScene(
  roomScene: RoomSceneT,
): MeasurementLinesProps['surfaceEndpoints'] {
  const out: MeasurementLinesProps['surfaceEndpoints'] = {}
  for (const wall of roomScene.walls) {
    const y = wall.base_height_m + wall.height_m / 2
    out[wall.id] = {
      start: [wall.start_point.x, y, wall.start_point.z],
      end: [wall.end_point.x, y, wall.end_point.z],
    }
  }
  return out
}

/**
 * Legacy fallback: when no canonical `RoomScene` is plumbed through (e.g.
 * the customer-side `SpatialDetailSection` that only loads glTF + USDZ via
 * `scan_assets`), keep the original BBox-diagonal heuristic so the lines
 * stay visible. New surfaces should prefer the parametric-driven path —
 * this branch is the bridge until every viewer threads `roomScene`.
 */
function collectSurfaceEndpointsFromMesh(
  scene: Group,
): MeasurementLinesProps['surfaceEndpoints'] {
  const out: MeasurementLinesProps['surfaceEndpoints'] = {}
  scene.traverse(obj => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    const key = mesh.name?.trim()
    if (!key) return
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox()
    }
    const box = mesh.geometry.boundingBox
    if (!box) return
    mesh.updateWorldMatrix(true, false)
    const min = box.min.clone().applyMatrix4(mesh.matrixWorld)
    const max = box.max.clone().applyMatrix4(mesh.matrixWorld)
    out[key] = {
      start: [min.x, min.y, min.z],
      end: [max.x, max.y, max.z],
    }
  })
  return out
}

/**
 * Block E3 (D12) — apply a single clipping plane to every material in the
 * scene. The plane is parented to world coordinates; the parent component
 * decides axis + height + flipped via the `SectionCutController` UI.
 *
 * Three.js plane semantics: `Plane(normal, constant)` clips points where
 * `normal·P + constant < 0`. With `flipped=false` and axis 'z', the plane
 * keeps the half above the slider height (looking down from above); the
 * flip toggle inverts the kept half so the craftsman can "see inside from
 * the other side" without re-orbiting the camera.
 */
function SectionCutApplier({ sectionCut }: { sectionCut: import('../SectionCutController').SectionCutState }) {
  const scene = useThree(state => state.scene)
  const invalidate = useThree(state => state.invalidate)

  useEffect(() => {
    const dir = sectionCut.flipped ? -1 : 1
    const normal = new Vector3(
      sectionCut.axis === 'x' ? dir : 0,
      sectionCut.axis === 'y' ? dir : 0,
      sectionCut.axis === 'z' ? dir : 0,
    )
    const plane = new Plane(normal, -dir * sectionCut.height)
    const planes = [plane]
    scene.traverse(obj => {
      const mesh = obj as Mesh
      if (!mesh.isMesh) return
      const material = mesh.material as Material | Material[] | undefined
      if (Array.isArray(material)) {
        material.forEach(m => {
          m.clippingPlanes = planes
          m.clipShadows = false
          m.needsUpdate = true
        })
      } else if (material) {
        material.clippingPlanes = planes
        material.clipShadows = false
        material.needsUpdate = true
      }
    })
    invalidate()
    return () => {
      scene.traverse(obj => {
        const mesh = obj as Mesh
        if (!mesh.isMesh) return
        const material = mesh.material as Material | Material[] | undefined
        if (Array.isArray(material)) {
          material.forEach(m => {
            m.clippingPlanes = []
            m.needsUpdate = true
          })
        } else if (material) {
          material.clippingPlanes = []
          material.needsUpdate = true
        }
      })
      invalidate()
    }
  }, [scene, invalidate, sectionCut.enabled, sectionCut.axis, sectionCut.height, sectionCut.flipped])

  return null
}

/** Walk the scene and release all geometries + materials + TEXTURES on unmount.
 *
 *  three.js does not GC GPU resources via JS GC — disposes are mandatory.
 *  Phase 1 fix: textures were leaking on every URL swap because Material.dispose()
 *  does NOT touch attached texture slots (map / normalMap / roughnessMap / ...).
 *  KTX2 textures keep their compressed GPU buffer alive until explicitly
 *  disposed, which crashed the WebView after ~10 scan-open/close cycles on
 *  mobile (and slowly leaked GPU memory on desktop). Walk every standard
 *  texture slot and dispose first, then dispose the material.
 */
function disposeSceneGraph(scene: Group): void {
  const seenTextures = new WeakSet<object>()
  const disposeTexture = (tex: unknown): void => {
    if (!tex || typeof tex !== 'object') return
    if (seenTextures.has(tex as object)) return
    seenTextures.add(tex as object)
    const maybeDispose = (tex as { dispose?: () => void }).dispose
    if (typeof maybeDispose === 'function') maybeDispose.call(tex)
  }
  const disposeMaterial = (mat: Material): void => {
    // All standard texture slots used by glTF + KTX2 + Meshopt pipeline.
    // Some are not on every material type — using `as` + optional access keeps
    // the loop type-safe without dragging in every concrete material class.
    const m = mat as unknown as Record<string, unknown>
    const slots = [
      'map', 'normalMap', 'roughnessMap', 'metalnessMap',
      'aoMap', 'emissiveMap', 'bumpMap', 'displacementMap',
      'alphaMap', 'lightMap', 'envMap', 'gradientMap',
      'specularMap', 'specularIntensityMap', 'specularColorMap',
      'sheenColorMap', 'sheenRoughnessMap',
      'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
      'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
      'anisotropyMap',
    ]
    for (const slot of slots) {
      disposeTexture(m[slot])
    }
    mat.dispose?.()
  }
  scene.traverse(obj => {
    const mesh = obj as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose?.()
    const material = mesh.material as Material | Material[] | undefined
    if (Array.isArray(material)) {
      material.forEach(disposeMaterial)
    } else if (material) {
      disposeMaterial(material)
    }
  })
}

// Type-narrow guard — the WeakMap key for the loader cache is the
// WebGLRenderer, which is also what r3f exposes via useThree.
export type { WebGLRenderer }
