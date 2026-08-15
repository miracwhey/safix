/**
 * Spatial · WebGLContextRecovery
 *
 * WebGL context-loss / restoration handler for the Spatial 3D canvases.
 *
 * `webglcontextlost` is a DOM event on the underlying <canvas> — it is NOT a
 * React render throw, so NO error boundary (AppErrorBoundary,
 * SpatialSceneErrorBoundary, EnvironmentErrorBoundary) ever catches it. Under
 * iOS WKWebView memory pressure the context is dropped, three.js stops drawing,
 * and the viewer blanks PERMANENTLY with no recovery and no telemetry.
 *
 * This component is mounted INSIDE the <Canvas> (so it can reach the real
 * renderer DOM element via useThree) and:
 *
 *   1. `preventDefault()` on `webglcontextlost` — mandatory: without it the
 *      browser treats the context as unrecoverable and `webglcontextrestored`
 *      never fires.
 *   2. Reports the loss/restore to observability (Sentry breadcrumb + warning).
 *   3. On loss → calls `onLost()`; on restore → re-invalidates the demand
 *      frameloop so the scene repaints, then calls `onRestored()`.
 *
 * The host wrapper owns a remount `key` on the <Canvas> as the hard fallback:
 * if the GPU never fires `webglcontextrestored` (some iOS builds don't), the
 * host bumps the key after a short grace window to force a clean canvas
 * rebuild from scratch.
 */

import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { logWarning } from '../../../lib/observability'

export interface WebGLContextRecoveryProps {
  /** Fires when the GL context is lost (after preventDefault). */
  onLost?: () => void
  /** Fires when the GL context is restored by the browser/GPU. */
  onRestored?: () => void
  /** Context label for telemetry (e.g. "canonical", "legacy-scene"). */
  context?: string
}

export function WebGLContextRecovery({
  onLost,
  onRestored,
  context,
}: WebGLContextRecoveryProps): null {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const setFrameloop = useThree((s) => s.setFrameloop)

  useEffect(() => {
    const canvas = gl.domElement
    if (!canvas) return

    const handleLost = (event: Event) => {
      // CRITICAL: mark the context as recoverable. Without preventDefault the
      // browser discards it for good and `webglcontextrestored` never fires.
      event.preventDefault()
      logWarning('spatial.webgl.context_lost', { context })
      onLost?.()
    }

    const handleRestored = () => {
      logWarning('spatial.webgl.context_restored', { context })
      // The static viewer modes run `frameloop="demand"` — nudge the loop so
      // the restored context repaints immediately instead of staying black
      // until the next user interaction.
      try {
        setFrameloop('always')
        invalidate()
        // Drop back to demand on the next tick; one forced frame is enough to
        // re-present the restored buffer.
        requestAnimationFrame(() => setFrameloop('demand'))
      } catch {
        invalidate()
      }
      onRestored?.()
    }

    canvas.addEventListener('webglcontextlost', handleLost, false)
    canvas.addEventListener('webglcontextrestored', handleRestored, false)
    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost, false)
      canvas.removeEventListener('webglcontextrestored', handleRestored, false)
    }
  }, [gl, invalidate, setFrameloop, onLost, onRestored, context])

  return null
}

export default WebGLContextRecovery
