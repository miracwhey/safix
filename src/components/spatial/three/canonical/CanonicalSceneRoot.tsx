/**
 * Spatial · Canonical · Three · CanonicalSceneRoot (Day 10 · L3 spike)
 *
 * Top-level r3f container that renders a canonical `RoomScene` produced by
 * the L1 + L2 + bridge layers. Designed to coexist with the existing Block-A
 * `<SpatialViewer>` — NOT replace it. The two viewers can mount side-by-side
 * on `/scan/:id/compare` (Phase-0c POC) so reviewers can switch between the
 * legacy USDZ and the canonical parametric scene.
 *
 * V1-spike scope (Day 10–12):
 *   - perspective camera, default OrbitControls
 *   - `frameloop="demand"` to keep battery low on static scenes
 *   - axes/grid helpers behind a `debug` prop (default off)
 *   - `<SceneRenderer>` consumes the resolved scene from the canonical
 *     store and dispatches every node to its adapter (Day 11)
 *
 * Day 22 lighting wiring: pass `lightingPresetId` to drive the three-point
 * lighting from a curated {@link LightingPreset} (Mockup 43). The directional
 * + ambient + accent lights apply immediately; the HDRI image-based lighting
 * is gated behind `presetHdriEnabled` because the EXR binaries are fetched
 * separately (asset manifest) and a missing file would suspend-crash the
 * `<Environment>` loader.
 *
 * The component is intentionally thin — adapters do the work. Two-viewer
 * coexistence is the binding decision: never import `<SpatialViewer>` from
 * here; never re-export the canonical store from the Block-A barrel.
 */

import React, { Suspense, useEffect, useMemo, type ReactElement } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { ContactShadows, Environment } from '@react-three/drei'

import type { NodeOverride, Variant, VariantId } from '../../../../lib/spatial/canonical/types/variants.ts'
import type { RoomScene } from '../../../../lib/spatial/canonical/types/scene-graph.ts'
import {
  resolveLightingPreset,
  type LightingPreset,
} from '../../../../lib/spatial/canonical/lighting/presets.ts'
import { useCanonicalSceneStore } from '../../../../lib/spatial/canonical/store/sceneStore.ts'

import { EnvironmentErrorBoundary } from './adapters/EnvironmentErrorBoundary'
import { WebGLContextRecovery } from '../WebGLContextRecovery'
import { ModeBackground } from './ModeBackground'
import { SceneRenderer } from './SceneRenderer'
import { SectionClipper } from './SectionClipper'
import { SectionControlPanel } from './SectionControlPanel'
import { SurfaceTapLayer } from './SurfaceTapLayer'
import { CustomerFurnitureEditLayer } from './CustomerFurnitureEditLayer'
import { CustomerCeilingObjectEditLayer } from './CustomerCeilingObjectEditLayer'
import { CustomerWallObjectEditLayer } from './CustomerWallObjectEditLayer'
import type { DinWarning } from '../../../../lib/spatial/canonical/validator/wallObjectDinValidator'
import { RotationDial } from './RotationDial'
import type { TappedSurface, TappedSurfaceKind } from './surfaceTap'
import { DebugPickOverlay } from './DebugPickOverlay'
import { AutoCeilingCutaway } from './cameras/AutoCeilingCutaway'
import { DollhouseController } from './cameras/DollhouseController'
import { FloorplanController } from './cameras/FloorplanController'
import { WalkController } from './cameras/WalkController'
import { ARCompareController } from './cameras/ARCompareController'
import { CameraModeSwitcher } from './cameras/CameraModeSwitcher'
import { deriveWalkInputs } from './cameras/walkInputs'
import { FloorplanDragLayer } from './FloorplanDragLayer'

// Module-scope stable references for default props. Inline `= []` literals
// would allocate a new array on every render, churning the useEffect deps in
// useHydrateStore and triggering a store-write per render — which in turn
// causes the resolved-scene memo to be replaced and every subscriber to
// re-render. Module-scope freezes the identity so React's `Object.is`
// comparison treats the default as stable.
const EMPTY_OVERRIDES: readonly NodeOverride[] = Object.freeze([])
const EMPTY_VARIANTS: readonly Variant[] = Object.freeze([])

export interface CanonicalSceneRootProps {
  /** Canonical scene to render. Hydrates the canonical store on mount. */
  scene: RoomScene | null
  /** Override stack — usually fetched alongside the scene. */
  overrides?: NodeOverride[]
  /** Variant chain — usually the project's `variant_ids` payload. */
  variants?: Variant[]
  /** Active variant id (determines which overrides apply). */
  activeVariantId?: VariantId | null

  /** Camera + helpers debug toggles. */
  debug?: boolean
  /** Optional class on the outer wrapper for layout. */
  className?: string
  /** Environment HDRI key (Day 14). `null` disables IBL. */
  hdri?: string | null
  /**
   * Active lighting preset id (Mockup 43). When set, the three-point lights
   * are driven by the preset instead of the built-in defaults.
   */
  lightingPresetId?: string | null
  /**
   * Opt-in for preset-driven HDRI image-based lighting. Default `false` — the
   * preset EXR binaries ship via the asset manifest, not the bundle, so a
   * host enables this only once `download-spatial-assets.sh` has run.
   */
  presetHdriEnabled?: boolean
  /**
   * Pin rendering strategy. Defaults to `'adapter'` (inline spheres via
   * <PinAdapter>). Pass `'none'` when the host page mounts <PinSet>
   * (or another pin layer) inside this root to avoid double-rendering.
   */
  pinRenderer?: 'adapter' | 'none'
  /**
   * Children rendered inside the <Canvas> after the built-in scene
   * renderer. Use this to mount <PinSet>, custom controllers, helpers,
   * etc., without bypassing the canonical lighting/post-fx stack.
   */
  children?: React.ReactNode
  /**
   * Show the camera-mode switcher overlay (B-4 · Mockup 44). Default `true`.
   * The active mode lives in the canonical scene store (`cameraMode`).
   */
  cameraSwitcher?: boolean
  /**
   * Show the section-control overlay + apply the section clip (B-5 · Mockup
   * 44). Default `true`. State lives in the store (`sectionSliderY` /
   * `cutawaySetting`).
   */
  sectionControls?: boolean
  /**
   * Called when a pointer event hits no canonical surface (the empty
   * background). Phase C (C-3): drives "tap into empty space → deselect" for
   * the transform gizmo. Omitted ⇒ background taps are ignored.
   */
  onBackgroundTap?: () => void
  /**
   * Edit-Mode-Toggle für interaktive Surface-Taps (R11-A 2026-05-28).
   * `true` → SurfaceTapLayer mounted und Taps werden via `onPinPlaced` /
   * `onSurfaceTap` reported. `false` → reine View-Mode, kein Tap-Intercept.
   * Tap-Capture per-frame ist billig, also halten wir den Layer permanent
   * gemountet und flippen nur das `enabled`-Flag — vermeidet R3F-Remount-
   * Roundtrips beim Mode-Wechsel.
   */
  editMode?: boolean
  /**
   * Pin-Drop Callback (R11-A): Customer-/Provider-Hosts wiren das gegen
   * ihren Pin-Placement-Reducer. `surfaceExternalId` = canonical nodeId
   * (z.B. wall-id), `worldXyz` = Raycast-Hit im Welt-Frame. `uv` ist für
   * Phase 1d-MVP `[0.5, 0.5]` (Pin landet in Surface-Mitte) — eine echte
   * UV-Projektion folgt in Phase 2 wenn Pin-Re-Anchor an präzise Position
   * gefordert wird.
   */
  onPinPlaced?: (input: {
    kind: TappedSurfaceKind
    surfaceExternalId: string
    uv: [number, number]
    worldXyz?: { x: number; y: number; z: number }
  }) => void
  /**
   * V1.6.1 Phase 5: edit rights for the furniture gesture layer (drag / pinch /
   * dial). Mirror of the host's RBAC `activeSceneCanEdit` — gestures only mutate
   * when the active scene belongs to the customer. Default `false` (read-only).
   */
  canEdit?: boolean
  /**
   * V1.6.1 Gesten-Rework · global "Ansehen ↔ Einrichten" toggle. When false
   * (Ansehen, default) all gestures drive the camera and furniture is inert —
   * no accidental grabs while looking around. When true (Einrichten) the
   * furniture gesture layers arm in dollhouse AND walk.
   */
  arrangeMode?: boolean
  /**
   * Footprint-editing (Lane-2.5 · Stream B): arms the {@link FloorplanDragLayer}
   * (drag wall corners in the 2D floorplan). The caller sets this `true` for
   * editable, owner-held scenes regardless of origin (`'manual'` AND `'roomplan'`
   * LiDAR scans) — gating is by OWNERSHIP, not origin. HW-shared scenes
   * (ownerType!=='customer') stay read-only geometry. Default `false`; the layer
   * is additionally gated on `cameraMode==='floorplan'`.
   */
  footprintEditEnabled?: boolean
  /** Footprint-edit: a wall was TAPPED (selected) in the 2D Grundriss — the host
   *  opens the dimension sheet for it. `null` = deselected (tapped empty space). */
  onFootprintWallSelect?: (wallId: string | null) => void
  /** Footprint-edit: a floor/wall OBJECT was tapped in the 2D Grundriss — the
   *  host opens the matching edit surface. Routed straight through to the
   *  {@link FloorplanDragLayer}; business/selection routing stays host-side. */
  onFootprintObjectSelect?: (sel: { host: 'floor' | 'wall'; id: string }) => void
  /** Footprint-edit: the currently selected wall id (rendered highlighted). */
  selectedFootprintWallId?: string | null
  /** Footprint-edit: when `true`, a wall TAP wins over a wall-hosted opening /
   *  wall-mounted object (openings are collinear with the wall in 2D, so this
   *  keeps wall-dimension editing reliable; openings are edited in 3D). Default
   *  `false` (opening-first). */
  footprintPreferWallSelection?: boolean
  /** Footprint-edit: a corner/edge drag was released on an INVALID pose (after
   *  snap-back). The host toasts the reason. */
  onFootprintInvalid?: (message: string) => void
  /**
   * Called on furniture-gesture RELEASE with the live scene. The host wires its
   * debounced + RBAC-guarded persist (`schedulePersistScene`). Live per-frame
   * mutation goes straight to the store; only the commit round-trips here.
   */
  onTransformCommit?: (scene: RoomScene) => void
  /** Called once per drag when a move first leaves the room (host toasts). */
  onFurnitureOutOfBounds?: () => void
  /**
   * Called once per wall-object drag when a move is rejected (overlap), with
   * the validation reason. The host toasts it. Separate from the furniture
   * out-of-bounds because wall rejects carry a specific message.
   */
  onEditReject?: (message: string) => void
  /**
   * Called once per wall-object drag RELEASE with the DIN/VDE soft-warnings of
   * the final pose (non-blocking — the move already applied). The host toasts a
   * summary. Empty arrays are not emitted.
   */
  onDinWarning?: (warnings: DinWarning[]) => void
  /**
   * Suppress the Walk-mode mobile joystick while an edit overlay/sheet is open
   * (F5). Forwarded to {@link WalkController} so a sheet-covered joystick can't
   * eat finger input or drive the camera behind the overlay. Default `false`.
   */
  joystickSuppressed?: boolean
}

/**
 * Hydrate the canonical store from the props on every change. Keeping the
 * store the single source of truth lets sibling tools (panels / toolbars /
 * pin-editor) bind to selectors without a separate prop drill.
 */
function useHydrateStore(
  scene: RoomScene | null,
  overrides: readonly NodeOverride[],
  variants: readonly Variant[],
  activeVariantId: VariantId | null,
): void {
  const setScene = useCanonicalSceneStore((s) => s.setScene)
  const setOverrides = useCanonicalSceneStore((s) => s.setOverrides)
  const setVariants = useCanonicalSceneStore((s) => s.setVariants)
  const setActiveVariantId = useCanonicalSceneStore((s) => s.setActiveVariantId)
  useEffect(() => setScene(scene), [scene, setScene])
  useEffect(() => setOverrides(overrides), [overrides, setOverrides])
  useEffect(() => setVariants(variants), [variants, setVariants])
  useEffect(() => setActiveVariantId(activeVariantId), [activeVariantId, setActiveVariantId])
}

/**
 * Three-point lighting driven by a {@link LightingPreset}. The directional
 * sun is skipped when the preset's `sunIntensity` is 0 (Studio presets); the
 * warm accent point light is mounted at the room-centre ceiling height when
 * the preset defines one (Mockup 43 · Warmes Licht).
 */
function PresetLighting({ preset }: { preset: LightingPreset }): ReactElement {
  return (
    <>
      <ambientLight intensity={preset.ambientFillIntensity} />
      {preset.sunIntensity > 0 && (
        <directionalLight
          position={preset.sunPosition}
          intensity={preset.sunIntensity}
          color={preset.sunColor}
          castShadow
        />
      )}
      {preset.accentPointLight && (
        <pointLight
          position={[0, 2.4, 0]}
          intensity={preset.accentPointLight.intensity}
          color={preset.accentPointLight.color}
        />
      )}
    </>
  )
}

/** Minimal structural view of the active `makeDefault` OrbitControls instance
 *  (drei registers it into the r3f store). We only touch target + update +
 *  the 'change' event, so we avoid pulling the three-stdlib type here. */
type SnapshotControls = {
  target?: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void }
  update?: () => void
  addEventListener?: (type: 'change', cb: () => void) => void
  removeEventListener?: (type: 'change', cb: () => void) => void
}

/**
 * Camera-pose preservation across a WebGL-recovery remount (F2). A `glEpoch`
 * bump rebuilds the whole <Canvas>; without this the active controller re-frames
 * to its default on mount, so a recovered context would snap the camera back to
 * the dollhouse/floorplan default instead of where the user left it.
 *
 * This helper snapshots the live OrbitControls pose (camera position + orbit
 * target) on every controls 'change' into refs owned by the parent (which does
 * NOT remount), then re-applies them exactly once when a fresh canvas mounts.
 * The restore is naturally deferred until drei has registered the controls into
 * the r3f store — by then the controller's mount-time framing has already run,
 * so the restored pose wins. The `restoredRef` guard keeps a later camera-mode
 * switch (which swaps the active controls within the SAME canvas) re-framing
 * normally instead of snapping back to the pre-switch pose.
 */
function CameraPoseSnapshot({
  posRef,
  targetRef,
  zoomRef,
}: {
  posRef: React.MutableRefObject<[number, number, number] | null>
  targetRef: React.MutableRefObject<[number, number, number] | null>
  zoomRef: React.MutableRefObject<number | null>
}): null {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as SnapshotControls | null
  const restoredRef = React.useRef(false)

  // Re-seeding the three.js camera + OrbitControls target on a recovery remount
  // is an imperative restore against live objects from useThree() — runs once
  // controls mount, after the controllers' default framing, so the user's pose
  // wins on a glEpoch rebuild. zoom matters for the orthographic floorplan
  // camera (pan lives in position, zoom in camera.zoom); for the perspective
  // dollhouse camera zoom stays 1 so restoring it is a no-op.
  /* eslint-disable react-hooks/immutability --
     Imperative restore of the live three.js camera/controls from useThree();
     camera.zoom is its documented mutation API — there is no declarative hook
     to put the camera back where the user left it after a context-loss rebuild. */
  React.useEffect(() => {
    if (restoredRef.current || !controls) return
    const p = posRef.current
    const t = targetRef.current
    const z = zoomRef.current
    if (p) camera.position.set(p[0], p[1], p[2])
    if (t && controls.target) controls.target.set(t[0], t[1], t[2])
    if (z != null) {
      camera.zoom = z
      camera.updateProjectionMatrix()
    }
    if (p || t || z != null) controls.update?.()
    restoredRef.current = true
  }, [controls, camera, posRef, targetRef, zoomRef])
  /* eslint-enable react-hooks/immutability */

  React.useEffect(() => {
    if (!controls?.addEventListener) return
    const onChange = () => {
      posRef.current = [camera.position.x, camera.position.y, camera.position.z]
      zoomRef.current = camera.zoom
      if (controls.target) {
        targetRef.current = [controls.target.x, controls.target.y, controls.target.z]
      }
    }
    controls.addEventListener('change', onChange)
    return () => controls.removeEventListener?.('change', onChange)
  }, [controls, camera, posRef, targetRef, zoomRef])

  return null
}

export function CanonicalSceneRoot(props: CanonicalSceneRootProps): ReactElement {
  const {
    scene,
    overrides = EMPTY_OVERRIDES,
    variants = EMPTY_VARIANTS,
    activeVariantId = null,
    debug = false,
    className,
    hdri = null,
    lightingPresetId = null,
    presetHdriEnabled = false,
    pinRenderer = 'adapter',
    children,
    cameraSwitcher = true,
    sectionControls = true,
    onBackgroundTap,
    editMode = false,
    onPinPlaced,
    canEdit = false,
    arrangeMode = false,
    footprintEditEnabled = false,
    onFootprintWallSelect,
    onFootprintObjectSelect,
    selectedFootprintWallId = null,
    footprintPreferWallSelection = false,
    onFootprintInvalid,
    onTransformCommit,
    onFurnitureOutOfBounds,
    onEditReject,
    onDinWarning,
    joystickSuppressed = false,
  } = props

  // R11-A: TappedSurface → host-facing Pin-Placement-Shape. nodeId wird 1:1
  // als surfaceExternalId durchgereicht — Adapter `<group name="wall-${id}">`
  // serialisiert die canonical wall.id, was wiederum als surfaceExternalId
  // in `scan_annotations.placement` landet (Free-form-Spalte, kein FK).
  // UV stub [0.5, 0.5] — Mitte der Surface. Für V1.6 reicht das weil Pins
  // primär via worldXyz visualisiert werden; präzises UV-Projection-Math
  // (cylindrical/planar pro Surface-Kind) folgt in Phase 2.
  const handleSurfaceTap = useMemo(() => {
    if (!onPinPlaced) return undefined
    return (surface: TappedSurface) => {
      onPinPlaced({
        kind: surface.kind,
        surfaceExternalId: surface.nodeId,
        uv: [0.5, 0.5],
        worldXyz: surface.point,
      })
    }
  }, [onPinPlaced])

  // WebGL context-loss recovery. `glEpoch` is the <Canvas> remount key: a lost
  // context that the GPU never restores on its own (some iOS WKWebView builds)
  // is force-rebuilt by bumping this after a grace window. The listener
  // calls onLost → schedule a remount; onRestored → cancel it (the GPU
  // recovered the existing context, no rebuild needed).
  //
  // Live camera pose, snapshotted by <CameraPoseSnapshot> below. Survives a
  // glEpoch remount because this ref lives in the (never-remounting) parent —
  // the rebuilt canvas re-seeds its camera from here instead of snapping back
  // to the [6,4,6] default, and the controls target is restored after mount.
  const savedCamPosRef = React.useRef<[number, number, number] | null>(null)
  const savedTargetRef = React.useRef<[number, number, number] | null>(null)
  const savedZoomRef = React.useRef<number | null>(null)
  const [glEpoch, setGlEpoch] = React.useState(0)
  const remountTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleGlLost = React.useCallback(() => {
    if (remountTimerRef.current) clearTimeout(remountTimerRef.current)
    // Grace window: give the browser/GPU ~3s to fire webglcontextrestored on
    // its own before we hard-remount the canvas. In-place restore is strongly
    // preferred — a remount rebuilds the whole tree — so the window is wide and
    // the bump is a genuine last resort. <CameraPoseSnapshot> keeps the pose if
    // a bump does happen, and the transitional <Suspense> fallback keeps the
    // per-mode background visible so the rebuild reads as a soft re-settle, not
    // a white cold-start.
    remountTimerRef.current = setTimeout(() => {
      remountTimerRef.current = null
      setGlEpoch((n) => n + 1)
    }, 3000)
  }, [])
  const handleGlRestored = React.useCallback(() => {
    if (remountTimerRef.current) {
      clearTimeout(remountTimerRef.current)
      remountTimerRef.current = null
    }
  }, [])
  React.useEffect(
    () => () => {
      if (remountTimerRef.current) clearTimeout(remountTimerRef.current)
    },
    [],
  )

  useHydrateStore(scene, overrides, variants, activeVariantId)

  // B-4 · camera mode drives which controller is mounted (one at a time, so
  // there is never a `makeDefault`-OrbitControls collision).
  const cameraMode = useCanonicalSceneStore((s) => s.cameraMode)

  // V1.6.1 Partial-Focus-Unify · one focused object id + host. Each gesture layer
  // consumes only its OWN host's id (floor → furniture layer + rotation dial,
  // ceiling → ceiling layer); the wall edit-sheet lives host-side in the Hub. So
  // at most one layer ever has a non-null target — they no longer race for arming.
  const focusedObjectId = useCanonicalSceneStore((s) => s.focusedObjectId)
  const focusedHost = useCanonicalSceneStore((s) => s.focusedHost)
  const floorObjectId = focusedHost === 'floor' ? focusedObjectId : null
  const ceilingObjectId = focusedHost === 'ceiling' ? focusedObjectId : null
  // V1.6.1 Gesten-Rework: furniture edit now armed in dollhouse AND walk, gated
  // behind the global arrange-mode toggle (Einrichten). Floorplan/AR stay
  // view-only. arrangeMode false (Ansehen) → layers inert → look-around is safe.
  const furnitureEditEnabled =
    editMode && canEdit && arrangeMode && (cameraMode === 'dollhouse' || cameraMode === 'walk')
  // Footprint-editing arms the FloorplanDragLayer only in the 2D top-down mode
  // on an editable manual scene (the caller already encodes origin==='manual'
  // + ownership in footprintEditEnabled; scanned scenes never pass it).
  const floorplanEditEnabled = footprintEditEnabled && cameraMode === 'floorplan'
  const resolved = useCanonicalSceneStore((s) => s.resolved)

  // Frame the actual room: target = centre of the resolved scene bounds.
  const cameraTarget = useMemo<[number, number, number]>(() => {
    if (!resolved) return [2, 0, 2]
    return [
      (resolved.bounds_min.x + resolved.bounds_max.x) / 2,
      0,
      (resolved.bounds_min.z + resolved.bounds_max.z) / 2,
    ]
  }, [resolved])

  // Camera fit — without this, small customer rooms (2.5×2.5m) appear tiny in
  // the upper-center of the canvas because the Dollhouse default distance is
  // 8m (designed for 4-5m provider rooms). Distance scales with the XZ-diagonal
  // and adds a 30% padding for visual breathing room. Min 5m to avoid clipping
  // into walls on micro-rooms; max 14m so a huge room doesn't push everything
  // to a dot.
  const cameraFit = useMemo<{
    dollhouseDistance: number
    floorplanHalfHeight: number
    dollhouseMin: number
    dollhouseMax: number
  }>(() => {
    if (!resolved) {
      return {
        dollhouseDistance: 8,
        floorplanHalfHeight: 4,
        dollhouseMin: 1,
        dollhouseMax: 24,
      }
    }
    const dx = resolved.bounds_max.x - resolved.bounds_min.x
    const dz = resolved.bounds_max.z - resolved.bounds_min.z
    const diagonal = Math.hypot(dx, dz)
    const dollhouseDistance = Math.max(5, Math.min(14, diagonal * 1.4))
    // V1.6.1 Round 6: Padding hoch (0.65 → 0.85) damit der Plan nicht den
    // ganzen Viewport füllt. Bei 2.5m-Raum → halfHeight = max(2.5, 2.1) =
    // 2.5m → 5m Sichtbereich vertikal, der Raum sitzt mit ~25% Whitespace
    // rundherum statt edge-to-edge.
    const floorplanHalfHeight = Math.max(2.5, Math.max(dx, dz) * 0.85)
    // Pinch-zoom limits (V1.6.1 Round 5 erweitert): vorher 0.18/3 = bei 3.5m
    // diagonal min 0.63m max 10.5m. User-Feedback: "min/max bisschen
    // vergrößern, weiter rauszoomen". Jetzt 0.08/8 = min 0.28m max 28m.
    // Absolute floor 0.3m (Near-Clip-Safety) + ceiling 60m für sehr große
    // Räume. Großzügig, weil "ich will zoomen können".
    const dollhouseMin = Math.max(0.3, diagonal * 0.08)
    const dollhouseMax = Math.min(60, Math.max(dollhouseDistance * 5, diagonal * 8))
    return { dollhouseDistance, floorplanHalfHeight, dollhouseMin, dollhouseMax }
  }, [resolved])

  // Walk camera inputs — only derived while walk mode is active.
  const walkInputs = useMemo(
    () => (resolved && cameraMode === 'walk' ? deriveWalkInputs(resolved) : null),
    [resolved, cameraMode],
  )

  const preset = lightingPresetId ? resolveLightingPreset(lightingPresetId) : null
  // HDRI IBL: a preset supplies it only when the EXR binaries are present
  // (presetHdriEnabled); otherwise fall back to the explicit `hdri` prop.
  const effectiveHdri = preset && presetHdriEnabled ? preset.hdriUrl : hdri

  // Tab-Switch-Leak Fix (2026-05-28): Document-level swipe-nav wird via
  // `AppShell immersive` Flag schon ausgeschaltet (siehe useSwipeNavigation
  // `disabled`-Option). Wrapper-level stopPropagation auf touch-Events war
  // overkill UND kappte iOS click-Synthese (UI-Tap-Targets wie der
  // "Auswahl"-Button reagierten nicht mehr). Daher entfernt.

  return (
    <div
      className={className ?? 'spatial-canonical-root'}
      style={{
        // Wrapper-Sizing: wenn der Caller eine `className` mitgibt (z.B.
        // `absolute inset-0` im Hub oder `h-[320px]` im Detail-Screen),
        // erbt er deren Positioning. Default-Fallback (`spatial-canonical-
        // root`) bekommt `position:relative` + 100% inline weil ohne CSS-
        // Klasse sonst kein Containment für die Canvas-Children entsteht.
        //
        // **WICHTIG**: NIEMALS `position: 'relative'` inline setzen wenn
        // className `absolute` enthält — inline-style schlägt class, und
        // `position:relative` + `top/right/bottom/left:0` heißt block-flow
        // mit 0×0 size. Canvas fällt dann auf HTML-default 300×150px
        // zurück → 3D-Modell nur winzig oben sichtbar (Bug #9, 2026-05-28).
        ...(className
          ? {}
          : { position: 'relative', width: '100%', height: '100%' }),
        // iOS Capacitor WebView treats two-finger gestures as page-pinch-zoom
        // by default — drei's OrbitControls sets `touch-action: none` on the
        // canvas itself, but the wrapper above can still leak the gesture to
        // the WebView's scroll/zoom handler. Pin it here so a pinch reliably
        // reaches the canvas + the three.js dolly handler.
        touchAction: 'none',
      }}
    >
      <Canvas
        // `key={glEpoch}`: hard fallback for an unrecoverable WebGL context
        // loss — bumping it rebuilds the canvas from scratch (see glEpoch
        // wiring above). On the common path the GPU restores the context
        // itself and this never changes.
        key={glEpoch}
        // Walk mode needs a continuous loop for per-frame movement; the
        // static modes keep the battery-friendly demand loop.
        frameloop={cameraMode === 'walk' ? 'always' : 'demand'}
        gl={{
          antialias: true,
          alpha: false,
          preserveDrawingBuffer: false,
          // Day-14 wiring: ACES filmic tone-mapping + linear-sRGB output.
          // exposure 1.0 keeps Polyhaven HDRIs (most are EV0 keyed) close
          // to their reference exposure; bump in the dev screen via the
          // gl prop if a scene reads too dark.
          toneMapping: 4, // THREE.ACESFilmicToneMapping (numeric to avoid extra import)
          toneMappingExposure: 1.0,
        }}
        // Static initial framing. The F2 pose-restore after a glEpoch remount
        // is done imperatively in <CameraPoseSnapshot> (re-seeds camera.position
        // + orbit target once controls mount), so we must NOT read savedCamPosRef
        // here — a ref read during render is disallowed and the imperative
        // restore already covers it. First mount uses this default framing.
        camera={{
          position: [6, 4, 6],
          fov: 50,
          near: 0.05,
          far: 200,
        }}
        dpr={[1, 2]}
        shadows
        onPointerMissed={onBackgroundTap ? () => onBackgroundTap() : undefined}
      >
        {/* WebGL context-loss listener (preventDefault + restore repaint +
            telemetry). Mounted outside <Suspense> so it stays alive even while
            the scene's async loaders suspend. */}
        <WebGLContextRecovery
          context="canonical"
          onLost={handleGlLost}
          onRestored={handleGlRestored}
        />
        {/* F2: a non-null transitional fallback. While the scene tree suspends
            (async adapters / a glEpoch rebuild) keep the per-mode background
            mounted so the canvas shows the gradient/beige instead of a white
            (or clear-color) flash — the rebuild reads as a soft re-settle. */}
        <Suspense fallback={<ModeBackground />}>
          <ModeBackground />
          {preset ? (
            <PresetLighting preset={preset} />
          ) : (
            <>
              {/* V1.6.1 Round 5 · Material/Light-Polish + Round 6 Boost:
                  - ambientLight 0.28: minimum fill, kein Pitch-Black-Floor
                    selbst wenn shadow-mapping den Floor verdüstert (Image 2
                    Bug aus Round 5 — Floor wirkte schwarz weil shadow-bias
                    fragiler war als das HDR-tonemapping)
                  - hemisphereLight (sky white → ground warm): vertikale
                    Tiefen-Cue; Floor empfängt sky-white von oben, Ceiling
                    + walls-bottom empfangen warm-tint von unten
                  - directionalLight als "Sonne" mit weicheren Shadow-Maps
                    (2048²) damit der Schatten nicht ganzen Floor pitched.
                    shadow-camera-bounds explizit damit Frustum die ganze
                    Szene umfasst (vorher default ±5 = kleine Räume ok,
                    große Räume hatten falsche Shadow-Cutoffs) */}
              <ambientLight intensity={0.28} />
              <hemisphereLight args={['#ffffff', '#8a7d6a', 0.6]} />
              <directionalLight
                position={[6, 10, 4]}
                intensity={1.05}
                color="#fff6e6"
                castShadow
                shadow-mapSize={[2048, 2048]}
                shadow-bias={-0.0008}
                shadow-normalBias={0.04}
                shadow-camera-left={-15}
                shadow-camera-right={15}
                shadow-camera-top={15}
                shadow-camera-bottom={-15}
                shadow-camera-near={0.5}
                shadow-camera-far={40}
              />
            </>
          )}
          {/* ContactShadow: weiche Schatten unter dem Raum-Footprint, gibt
              dem Modell ein "Bühne"-Feeling statt schwebend. Nur im 3D-Mode
              — im Floorplan stört's, im Walk steht player drin und sieht's
              eh nicht. */}
          {resolved && cameraMode === 'dollhouse' && (() => {
            const cx = (resolved.bounds_min.x + resolved.bounds_max.x) / 2
            const cz = (resolved.bounds_min.z + resolved.bounds_max.z) / 2
            const dx = resolved.bounds_max.x - resolved.bounds_min.x
            const dz = resolved.bounds_max.z - resolved.bounds_min.z
            const scale = Math.max(dx, dz) * 2.5
            return (
              <ContactShadows
                position={[cx, -0.01, cz]}
                opacity={0.4}
                scale={scale}
                blur={2.4}
                far={4}
                resolution={1024}
                color="#000000"
              />
            )
          })()}
          {/* CAD-Grid im Floorplan-Mode: 1m fine + 5m heavy. fadeDistance
              hält das Grid in der Mitte sichtbar und blendet zum Rand aus. */}
          {/* R8-C: drei <Grid> entfernt. Mockup 13 V5 State B verzichtet
              auf overlaid Grid — der warm-beige Background + Wand-2D-Quads
              + Maß-Labels reichen für CAD-Look. Grid war visueller Lärm
              gegen den Grundriss. Subtle tile-pattern auf dem Floor selbst
              wird bei Bedarf nachgereicht. */}
          {/*
            HDRI image-based lighting is a quality enhancement, never a hard
            dependency. A missing / corrupt EXR makes `<Environment>` throw a
            render error once its loader rejects — `<EnvironmentErrorBoundary>`
            catches that and renders `null`, so the scene silently keeps the
            analytic three-point rig (`PresetLighting` / the default lights,
            both already mounted above) instead of blanking the `<Canvas>`.
          */}
          {effectiveHdri && (
            <EnvironmentErrorBoundary hdriUrl={effectiveHdri} fallback={null}>
              <Environment files={effectiveHdri} />
            </EnvironmentErrorBoundary>
          )}
          {debug && (
            <>
              <axesHelper args={[1]} />
              <gridHelper args={[10, 10]} />
            </>
          )}
          {/* R12 Event-Wiring Fix (2026-05-28): SurfaceTapLayer muss den
              SceneRenderer WRAPPEN, damit R3F-Pointer-Events über die Parent-
              Chain des getroffenen Mesh durch den Layer-Group-Handler bubblen.
              Vorher war der Layer ein leeres Sibling-`<group>` neben dem
              SceneRenderer → R3F dispatched über Scene-Graph-Ancestors, nicht
              Siblings → Handler feuerte nie → Customer-Hub Tap-to-Pin tot.
              Wenn kein Listener vorhanden ist, SceneRenderer ohne Wrap mounten
              (gleicher Tree, kein Render-Overhead). */}
          {/* V1.6.1 Phase 5: the furniture gesture layer is the OUTER wrapper so
              pointer events on object meshes bubble through it (it only pre-empts
              a drag past the 8px threshold; small taps fall through to the inner
              SurfaceTapLayer). Always mounted, controlled by `enabled`, to avoid
              remounting the SceneRenderer when edit-mode toggles. */}
          {/* Footprint-edit (manual rooms): drag wall corners in the 2D floorplan.
              OUTER wrapper so corner-grabs win over the (floorplan-disabled)
              furniture layers; pure passthrough unless floorplanEditEnabled. */}
          <FloorplanDragLayer
            enabled={floorplanEditEnabled}
            onCommit={onTransformCommit}
            onInvalid={onFootprintInvalid}
            onSelectWall={onFootprintWallSelect}
            onSelectObject={onFootprintObjectSelect}
            selectedWallId={selectedFootprintWallId}
            preferWallSelection={footprintPreferWallSelection}
          >
          <CustomerFurnitureEditLayer
            enabled={furnitureEditEnabled}
            selectedObjectId={floorObjectId}
            onTransformCommit={onTransformCommit}
            onOutOfBounds={onFurnitureOutOfBounds}
          >
            {/* Ceiling-object drag nests inside. Hit sets are disjoint by focused
                host: each layer only arms when the finger is on ITS focused id,
                and the store holds a single focused host → at most one non-null. */}
            <CustomerCeilingObjectEditLayer
              enabled={furnitureEditEnabled}
              selectedObjectId={ceilingObjectId}
              onTransformCommit={onTransformCommit}
            >
              {/* Wall-object drag nests inside (hit sets are disjoint: floor/
                  ceiling object vs wall/opening → only one layer ever arms). */}
              <CustomerWallObjectEditLayer
                enabled={furnitureEditEnabled}
                onTransformCommit={onTransformCommit}
                onReject={onEditReject}
                onDinWarning={onDinWarning}
              >
                {handleSurfaceTap ? (
                  <SurfaceTapLayer enabled={editMode} onTap={handleSurfaceTap}>
                    <SceneRenderer pinRenderer={pinRenderer} />
                  </SurfaceTapLayer>
                ) : (
                  <SceneRenderer pinRenderer={pinRenderer} />
                )}
              </CustomerWallObjectEditLayer>
            </CustomerCeilingObjectEditLayer>
          </CustomerFurnitureEditLayer>
          </FloorplanDragLayer>
          {/* Dreh-Dial as a SIBLING (never inside the gesture/tap layers) so the
              knob's r3f events stay isolated. Only in dollhouse edit-mode with a
              selected object. */}
          {furnitureEditEnabled && floorObjectId && (
            <RotationDial objectId={floorObjectId} onTransformCommit={onTransformCommit} />
          )}
          {sectionControls && <SectionClipper />}
          {children}
          {/* B-4 · exactly one camera controller, selected by `cameraMode`. */}
          {cameraMode === 'dollhouse' && (
            <>
              <DollhouseController
                target={cameraTarget}
                initialDistance={cameraFit.dollhouseDistance}
                minDistance={cameraFit.dollhouseMin}
                maxDistance={cameraFit.dollhouseMax}
              />
              {/* R7: Decke automatisch verstecken wenn von oben geguckt
                  wird (polar < 31°). Analog zum Wand-Cutaway. */}
              <AutoCeilingCutaway />
            </>
          )}
          {cameraMode === 'floorplan' && (
            <FloorplanController
              target={cameraTarget}
              initialHalfHeight={cameraFit.floorplanHalfHeight}
            />
          )}
          {cameraMode === 'walk' && walkInputs && (
            <WalkController
              walkable={walkInputs.walkable}
              obstacles={walkInputs.obstacles}
              initialPosition={[cameraTarget[0], cameraTarget[2]]}
              mobileJoystick
              suppressJoystick={joystickSuppressed}
            />
          )}
          {cameraMode === 'ar_compare' && <ARCompareController />}
          {/* F2 · camera-pose preservation. Rendered LAST so its restore effect
              settles after the active controller's mount-time framing (and only
              fires once drei has registered the controls), keeping a glEpoch
              remount seamless. */}
          <CameraPoseSnapshot
            posRef={savedCamPosRef}
            targetRef={savedTargetRef}
            zoomRef={savedZoomRef}
          />
        </Suspense>
      </Canvas>
      {/* R14 Debug-Overlay — nur sichtbar wenn `?picking=debug` oder
          `localStorage.picking_debug='1'`. No-op sonst (early-return null). */}
      <DebugPickOverlay />
      {cameraSwitcher && <CameraModeSwitcher />}
      {sectionControls && <SectionControlPanel />}
      {/* Walk-Mode Reticle (Mockup 02 v8 State 3 · `.fp-reticle .center`) —
          HTML overlay so the crosshair stays pixel-sharp and unaffected by
          the 3D viewport's tone-mapping. Pointer-events disabled so it
          never blocks tap-targets. */}
      {cameraMode === 'walk' && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div
            className="relative flex h-6 w-6 items-center justify-center"
            style={{
              borderRadius: '50%',
              border: '1.5px solid rgba(255,255,255,0.55)',
              boxShadow:
                '0 0 0 2px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.32)',
            }}
          >
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: 'rgba(255,255,255,0.92)',
                boxShadow: '0 0 4px rgba(255,255,255,0.6)',
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default CanonicalSceneRoot
