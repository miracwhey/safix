/**
 * Spatial · Canonical · Three · Pick-Debug Toggle + Pub/Sub (V1.6.1 R14)
 *
 * Lightweight pub/sub channel that lets the SurfaceTapLayer publish its
 * probe-sample table to a visual overlay (DebugPickOverlay) without forcing
 * the overlay into the canonical render path.
 *
 * Activation:
 *   - URL query `?picking=debug` (persists for the session)
 *   - `localStorage.picking_debug = '1'`
 *   - global `window.__pickDebug = true` (devtools shortcut)
 */

import type { TappedSurface } from './surfaceTap'

const STORAGE_KEY = 'picking_debug'

export function isPickDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as Window & { __pickDebug?: boolean }
  if (w.__pickDebug === true) return true
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('picking') === 'debug') {
      try {
        window.localStorage.setItem(STORAGE_KEY, '1')
      } catch {
        /* private mode etc. */
      }
      return true
    }
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export interface DebugPickFrame {
  clientX: number
  clientY: number
  samples: Array<{
    dx: number
    dy: number
    kind: TappedSurface['kind'] | null
    nodeId: string | null
    distance: number
    point?: { x: number; y: number; z: number }
  }>
  winner: TappedSurface | null
  timestamp: number
}

type Listener = (frame: DebugPickFrame) => void
const listeners = new Set<Listener>()

export function publishDebugPickFrame(frame: DebugPickFrame): void {
  for (const fn of listeners) fn(frame)
}

export function subscribeDebugPickFrame(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
