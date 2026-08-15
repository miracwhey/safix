/**
 * Spatial · SpatialSceneErrorBoundary (PR #951 review · HIGH)
 *
 * Wraps a `<CanonicalSceneRoot>` (or any other Three.js scene root) so that a
 * WebGL-level render error — context-loss on older devices, a Capacitor WebKit
 * quirk, a failed adapter throw — never blanks the entire viewer route. The
 * boundary swaps in a calm fallback panel (outline box-icon + short German
 * copy) and lets the surrounding chrome (sheet, top-nav, Maß-Cells) stay
 * fully usable so the customer can still read measurements and navigate back.
 *
 * Scope: one boundary per scene root. This is a class component because React
 * error boundaries have no hooks equivalent. The default fallback is tuned for
 * dark-glass surfaces (Mockup 03 v3); callers may pass a custom `fallback`
 * node when the surrounding theme is light.
 */

import { Box } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface SpatialSceneErrorBoundaryProps {
  /**
   * Rendered in place of the children once a render error is caught. Defaults
   * to the dark-glass outline-box fallback used by `<ExampleRoomViewer>`.
   */
  fallback?: ReactNode
  /**
   * Optional context label for the warning log — e.g. "ExampleRoomViewer".
   * Helps trace which scene root threw without a separate Sentry tag.
   */
  context?: string
  children: ReactNode
}

interface SpatialSceneErrorBoundaryState {
  hasError: boolean
}

export class SpatialSceneErrorBoundary extends Component<
  SpatialSceneErrorBoundaryProps,
  SpatialSceneErrorBoundaryState
> {
  constructor(props: SpatialSceneErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): SpatialSceneErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Warn-level: the fallback is a graceful degradation, not a crash. The
    // surrounding chrome is still interactive so the user is not stranded.
    const ctx = this.props.context ? ` [${this.props.context}]` : ''
    console.warn(
      `[spatial] SceneRoot${ctx}: 3D render failed — showing outline-fallback. ${error.message}`,
      info.componentStack,
    )
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? <DefaultSceneFallback />
    }
    return this.props.children
  }
}

/**
 * Default dark-glass fallback panel. Centered outline-box icon + a short
 * German copy that tells the user the Maß-Cells / sheet content below stays
 * usable. No CTA — the surrounding chrome already owns Back / Close.
 */
function DefaultSceneFallback(): ReactNode {
  return (
    <div
      data-testid="spatial-scene-fallback"
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/85"
    >
      <div
        aria-hidden
        className="grid h-16 w-16 place-items-center rounded-2xl border border-white/20 bg-white/8 backdrop-blur-md"
      >
        <Box size={28} className="text-white/70" />
      </div>
      <div className="max-w-[260px] text-[14px] font-medium leading-snug">
        3D-Ansicht nicht verfügbar.
        <br />
        <span className="text-white/65">
          Beispiel-Maße findest du unten.
        </span>
      </div>
    </div>
  )
}

export default SpatialSceneErrorBoundary
