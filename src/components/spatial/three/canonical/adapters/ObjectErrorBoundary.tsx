/**
 * Spatial · Canonical · Adapters · ObjectErrorBoundary (Phase 1.5 · Block R4)
 *
 * A render error inside one `<GltfObject>` (missing / corrupt GLB, a failed
 * `MeshoptGLTFLoader` decode, the `readGlb` throw when no retainer ran) must
 * NOT blank the whole scene. This boundary catches the throw and swaps in the
 * `fallback` — the dimension-correct generic-box placeholder — so the scene
 * keeps rendering with an accurate collision silhouette for that object.
 *
 * Scope: one boundary per object, mounted by `ObjectAdapter` *outside* the
 * `<Suspense>` so a thrown promise still suspends (boundary ignores it) while
 * a thrown `Error` is caught. This is a class component because React error
 * boundaries have no hooks equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ObjectErrorBoundaryProps {
  /** Rendered in place of the children once a render error is caught. */
  fallback: ReactNode
  /** Identifies the object in the warning log — usually the object id. */
  objectId: string
  children: ReactNode
}

interface ObjectErrorBoundaryState {
  hasError: boolean
}

export class ObjectErrorBoundary extends Component<
  ObjectErrorBoundaryProps,
  ObjectErrorBoundaryState
> {
  constructor(props: ObjectErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): ObjectErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // One concise warning — the placeholder is a graceful degradation, not a
    // crash, so this stays at warn level. `info` carries the component stack.
    console.warn(
      `[spatial] ObjectAdapter ${this.props.objectId}: GLB render failed, ` +
        `using generic-box placeholder — ${error.message}`,
      info.componentStack,
    )
  }

  componentDidUpdate(prev: ObjectErrorBoundaryProps): void {
    // A new object id means a different asset — clear the error so the next
    // object gets a fresh attempt instead of inheriting the placeholder.
    if (prev.objectId !== this.props.objectId && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render(): ReactNode {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}
