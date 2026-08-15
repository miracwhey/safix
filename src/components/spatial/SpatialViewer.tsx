/**
 * Spatial Core · Block E2 · `<SpatialViewer>`
 *
 * Single cross-format 3D viewer used by both the customer and craftsman
 * surfaces. `mode` switches between read-only (`'view'`) and pin-capable
 * (`'edit'`) — keeping one component prevents the Customer/Handwerker
 * drift that two-tree implementations always grow (Decisions D4 + D6).
 *
 * The heavy three.js + r3f bundle is loaded lazily via `React.lazy()` so
 * routes that never render a scan keep their initial payload small.
 *
 * V1 scope (this Block, E2):
 *   * glb load (Meshopt + KTX2) via @react-three/drei + @react-three/fiber
 *   * orbit / pinch / rotate controls
 *   * Top-Right control stack (Home + Top-Down + Layers)
 *   * Pin display (`<AnchorPins>`)
 *   * Measurement display (`<MeasurementLines>`)
 *   * Edit-mode raycast events on the mesh → `onPinPlaced(...)`
 *
 * Out of scope here:
 *   * Section-Cut slider → Block E3 (D12)
 *   * Pin-Editor BottomSheet + Reticle UX → Block F
 *   * USDZ-only quick-card → `<SpatialQuickCard>` (sibling)
 */

import { Component, Suspense, lazy, useCallback, useMemo, useState, type ReactNode } from 'react'
import type { ScanAnnotation, ScanMeasurement } from '../../lib/spatial/types'
import type { RoomScene } from '../../lib/spatial/canonical/types/scene-graph'
import { SpatialControls, type SpatialControlsState, type SpatialLayer } from './three/Controls'
import type { SectionCutState } from './SectionCutController'

const SpatialViewerScene = lazy(() => import('./three/Scene'))

/**
 * V1.6 Phase 1b: Customer-Hub view-mode controlled prop. When provided, the
 * parent owns the camera mode — `'2d'` snaps to top-down, `'3d'`/`'walk'`
 * use the orbit camera. `'walk'` falls back to orbit in Phase 1b; the
 * `WalkController` wiring (LiDAR mesh-snap reticle for AddPin) lands in
 * Phase 1d together with the canonical edit-mode path. Customer surfaces
 * always pair this with `chromelessMode` so the internal `SpatialControls`
 * stack stays hidden — the host's `CustomerViewModeSwitcher` owns the UI.
 */
export type SpatialViewerViewMode = '2d' | '3d' | 'walk'

export interface SpatialViewerProps {
  /** Signed URL to the glb asset (Block X output). */
  gltfUrl: string
  /** Optional fallback USDZ URL for the AR Quick Look CTA (mobile only). */
  usdzUrl?: string
  mode: 'view' | 'edit'
  /**
   * V-04 (L2-F): canonical scene graph used by `MeasurementLines` to derive
   * real wall-edge endpoints (parametric.json hydration is authoritative).
   * Optional so legacy callers without canonical hydration fall back to the
   * BBox-diagonal placeholder.
   */
  roomScene?: RoomScene | null
  pins?: ScanAnnotation[]
  measurements?: ScanMeasurement[]
  /** Currently focused pin — bumps the pin sprite size + emissive intensity. */
  selectedPinId?: string | null
  /** Fires when the user taps a surface in `edit` mode and confirms a pin.
   *  `worldXyz` is the hit point in glTF world space — `pinWorkflow.createPinFromPlacement`
   *  writes it into the D2 `anchorWorldCache` fast-path cache. */
  onPinPlaced?: (input: {
    surfaceExternalId: string
    uv: [number, number]
    worldXyz?: { x: number; y: number; z: number }
  }) => void
  /** Fires when an existing pin is tapped (consumed by Pin-Editor sheet F). */
  onPinSelected?: (annotationId: string) => void
  /** Fires when a measurement line is completed in `edit` mode (F wires it). */
  onMeasureCompleted?: (input: {
    startUv: { surfaceExternalId: string; uv: [number, number] }
    endUv: { surfaceExternalId: string; uv: [number, number] }
    distanceM: number
  }) => void
  /** Expose the section-cut button (default off — E3 flips this on). */
  sectionEnabled?: boolean
  /** Section-cut state owned by the parent (Block E3 — `SectionCutController`).
   *  When undefined, the scene renders without clipping planes. */
  sectionCut?: SectionCutState
  /**
   * L2-E V-03 · Chromeless-Modus für den Fullscreen-Viewer. Versteckt die
   * Top-Right `SpatialControls` (Home/Top-Down/Layers) und Section-Cut-Button.
   * Read-only Präsentations-Modus: alle Edit-Pfade bleiben über `mode='view'`
   * (Caller verantwortlich) blockiert; dieser Prop steuert nur die Sichtbarkeit
   * der UI-Overlays.
   */
  chromelessMode?: boolean
  /**
   * V1.6 Phase 1b: Customer-Hub controlled view-mode. When provided, parent
   * owns 2D/3D/Walk and the internal top-down toggle defers to it. Walk falls
   * back to orbit until Phase 1d adds `WalkController` integration.
   */
  viewMode?: SpatialViewerViewMode
  /**
   * V1.6 Phase 1b: emitted when the user toggles the internal top-down button
   * while `viewMode` is controlled — lets the host (e.g. the Customer Hub
   * switcher) stay in sync if `chromelessMode` is off. Ignored when
   * `chromelessMode` is true since the toggle is hidden.
   */
  onViewModeChange?: (mode: SpatialViewerViewMode) => void
  /**
   * V1.6 Phase 1b: drops the default rounded-lg + neutral-900 container so
   * the viewer can fill a full-bleed parent (Customer Hub background). The
   * parent is responsible for sizing (`className` should pin to the parent
   * — default `h-96` is kept for legacy contained callers).
   */
  fullBleed?: boolean
  /**
   * Phase 5 (Spatial V1.6) · Perf-KPI hook. Fires once per glb-URL after the
   * lazy `<Scene>` chunk loads, the loader resolves, the scene graph is
   * attached, and the first `invalidate()` ticks. The Customer Hub closes
   * the `spatial.hub.load` measure here so the dashboard KPI hub-load-total
   * reflects real perceived TTFD (time-to-first-draw) rather than mount-time.
   *
   * Backward-compatible: the prop is optional and every legacy caller that
   * does not pass it keeps the same behaviour (no perf instrumentation runs).
   */
  onReady?: () => void
  className?: string
}

const DEFAULT_LAYERS: ReadonlySet<SpatialLayer> = new Set([
  'pins',
  'measurements',
])

export function SpatialViewer(props: SpatialViewerProps) {
  const [topDown, setTopDown] = useState(false)
  const [visibleLayers, setVisibleLayers] = useState<ReadonlySet<SpatialLayer>>(
    DEFAULT_LAYERS,
  )
  const [resetNonce, setResetNonce] = useState(0)

  // When `viewMode` is controlled, parent owns 2D/3D — derive `topDown`
  // from it so the internal state drift never wins. Walk-mode uses the
  // orbit camera in Phase 1b (Phase 1d wires `WalkController`).
  const controlledViewMode = props.viewMode
  const effectiveTopDown =
    controlledViewMode != null ? controlledViewMode === '2d' : topDown

  const onHome = useCallback(() => {
    setResetNonce(n => n + 1)
  }, [])

  const onToggleTopDown = useCallback(() => {
    if (controlledViewMode != null) {
      // Controlled: emit upward so the host's switcher reflects the toggle.
      // 2D ↔ 3D round-trip; Walk falls back to 3D when the host doesn't
      // intercept (host can override by ignoring `onViewModeChange`).
      const next: SpatialViewerViewMode =
        controlledViewMode === '2d' ? '3d' : '2d'
      props.onViewModeChange?.(next)
      return
    }
    setTopDown(prev => !prev)
  }, [controlledViewMode, props])

  const onToggleLayer = useCallback((layer: SpatialLayer) => {
    setVisibleLayers(prev => {
      const next = new Set(prev)
      if (next.has(layer)) next.delete(layer)
      else next.add(layer)
      return next
    })
  }, [])

  const controlState = useMemo<SpatialControlsState>(
    () => ({ topDown: effectiveTopDown, visibleLayers }),
    [effectiveTopDown, visibleLayers],
  )

  // resetKey forces the lazy chunk + ErrorBoundary to remount on Retry,
  // which re-triggers the GLB load with a fresh signed URL refresh from
  // the parent's `useScanAssetUrl` hook.
  const [resetKey, setResetKey] = useState(0)

  const baseClass = props.fullBleed
    ? 'relative w-full overflow-hidden touch-none overscroll-contain '
    : 'relative w-full overflow-hidden rounded-lg bg-neutral-900 touch-none overscroll-contain '
  const containerClass = baseClass + (props.className ?? 'h-96')

  return (
    <div
      className={containerClass}
      style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
      role="region"
      aria-label="3D-Raumvorschau"
    >
      <SpatialViewerErrorBoundary
        key={resetKey}
        onRetry={() => setResetKey(k => k + 1)}
      >
        <Suspense fallback={<SpatialViewerSkeleton />}>
          <SpatialViewerScene
            {...props}
            controlState={controlState}
            resetNonce={resetNonce}
          />
        </Suspense>
      </SpatialViewerErrorBoundary>
      {!props.chromelessMode && (
        <SpatialControls
          state={controlState}
          onHome={onHome}
          onToggleTopDown={onToggleTopDown}
          onToggleLayer={onToggleLayer}
          sectionEnabled={props.sectionEnabled}
        />
      )}
    </div>
  )
}

function SpatialViewerSkeleton() {
  return (
    <div
      className="flex h-full w-full items-center justify-center"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 text-neutral-400">
        <div className="h-2 w-32 animate-pulse rounded-full bg-neutral-700" />
        <span className="text-xs">3D-Modell wird geladen…</span>
      </div>
    </div>
  )
}

interface SpatialViewerErrorBoundaryProps {
  children: ReactNode
  onRetry: () => void
}
interface SpatialViewerErrorBoundaryState {
  error: Error | null
}

class SpatialViewerErrorBoundary extends Component<
  SpatialViewerErrorBoundaryProps,
  SpatialViewerErrorBoundaryState
> {
  state: SpatialViewerErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): SpatialViewerErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error) {
    // Light Sentry capture — Sentry SDK is already initialised at app
    // bootstrap, so any failed GLB load lands in the existing telemetry
    // pipeline next to the rest of the React-error boundary stream.
    if (typeof window !== 'undefined') {
      const sentry = (window as unknown as { Sentry?: { captureException?: (e: unknown) => void } }).Sentry
      sentry?.captureException?.(error)
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center text-neutral-300">
          <span className="text-sm font-medium">3D-Modell konnte nicht geladen werden.</span>
          <span className="text-xs text-neutral-500">
            Prüfe deine Verbindung — die Vorschau-Datei ist evtl. nicht erreichbar.
          </span>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null })
              this.props.onRetry()
            }}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
          >
            Erneut versuchen
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
