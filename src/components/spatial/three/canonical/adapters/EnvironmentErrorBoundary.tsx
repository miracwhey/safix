/**
 * Spatial · Canonical · Adapters · EnvironmentErrorBoundary (Phase 1.5 · Block R6)
 *
 * `<Environment files={...}>` (drei) loads an HDRI EXR through a suspending
 * loader. A missing / corrupt EXR (404, decode failure) throws a *render
 * error* — not a thrown promise — once the loader rejects. Under a bare
 * `<Suspense fallback={null}>` that error would propagate to the nearest
 * boundary and blank the whole `<Canvas>` (and spam red console errors a
 * user sees).
 *
 * This boundary catches the throw and renders the `fallback` instead — the
 * three-point `PresetLighting` rig — so the scene keeps lighting without the
 * image-based environment. Image-based lighting is a *quality enhancement*,
 * never a hard dependency: degrading to analytic lights is correct and silent.
 *
 * Mirrors `ObjectErrorBoundary`:
 *   - class component (React error boundaries have no hooks equivalent),
 *   - mounted *outside* the `<Suspense>` for `<Environment>` so an in-flight
 *     thrown promise still suspends (boundary ignores it) while a thrown
 *     `Error` is caught,
 *   - resets `hasError` when the `hdriUrl` changes so switching to a new
 *     (valid) preset gets a fresh attempt instead of inheriting the fallback.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface EnvironmentErrorBoundaryProps {
  /** Rendered in place of `<Environment>` once a load error is caught. */
  fallback: ReactNode
  /**
   * The HDRI URL currently driving `<Environment>`. A change clears a caught
   * error so a different EXR is retried instead of staying on the fallback.
   */
  hdriUrl: string | null
  children: ReactNode
}

interface EnvironmentErrorBoundaryState {
  hasError: boolean
}

export class EnvironmentErrorBoundary extends Component<
  EnvironmentErrorBoundaryProps,
  EnvironmentErrorBoundaryState
> {
  constructor(props: EnvironmentErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): EnvironmentErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Graceful degradation, not a crash — IBL silently falls back to the
    // analytic three-point rig. Warn (not error) so no red console noise
    // reaches the user; `info` carries the component stack.
    console.warn(
      `[spatial] EnvironmentErrorBoundary: HDRI environment failed to load ` +
        `(${this.props.hdriUrl ?? 'unknown'}), falling back to preset lighting — ${error.message}`,
      info.componentStack,
    )
  }

  componentDidUpdate(prev: EnvironmentErrorBoundaryProps): void {
    // A new HDRI url means a different EXR — clear the error so the next
    // environment gets a fresh attempt instead of inheriting the fallback.
    if (prev.hdriUrl !== this.props.hdriUrl && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}
