/**
 * Spatial Core · Block E2 · `<model-viewer>` Inner Component
 *
 * Split from `SpatialQuickCard` so the side-effect-registration of the
 * `<model-viewer>` custom element happens only when the card actually
 * mounts. Two important guards:
 *
 *   1. `@google/model-viewer`'s import runs `customElements.define(...)` at
 *      module evaluation. That throws under vitest/jsdom (no custom-element
 *      registry) and produces hydration warnings under SSR. We register
 *      the element behind a runtime `window` check + dynamic import that
 *      only fires on the client.
 *   2. React 19's strict-typed JSX namespace deprecates the
 *      `declare global namespace JSX` hack for custom elements. We render
 *      via `React.createElement('model-viewer', ...)` which forwards refs
 *      and attributes verbatim for unknown tags — same machinery React
 *      uses internally for `<svg>` etc.
 */

import { createElement, useEffect, useRef, useState } from 'react'
import type { SpatialQuickCardProps } from './SpatialQuickCard'

type ModelViewerAttrs = {
  ref: React.RefCallback<HTMLElement>
  src?: string
  'ios-src'?: string
  alt?: string
  ar?: boolean
  'ar-modes'?: string
  'camera-controls'?: boolean
  'auto-rotate'?: boolean
  'rotation-per-second'?: string
  'shadow-intensity'?: string
  style?: React.CSSProperties
}

export default function SpatialQuickCardInner(props: SpatialQuickCardProps) {
  const [ready, setReady] = useState(false)
  const elRef = useRef<HTMLElement | null>(null)

  // Register the custom element on the client only — vitest jsdom and SSR
  // both lack `customElements`, and importing the module under those
  // environments throws at top level.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof customElements === 'undefined') {
      return
    }
    let cancelled = false
    void import('@google/model-viewer').then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Set rotation speed once the element instance is mounted — `auto-rotate`
    // alone uses a default that feels too fast for card surfaces.
    const el = elRef.current
    if (!el) return
    el.setAttribute('rotation-per-second', '12deg')
  }, [ready])

  if (!props.gltfUrl && !props.usdzUrl) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-neutral-500">
        Kein 3D-Modell verfügbar
      </div>
    )
  }

  if (!ready) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-xs text-neutral-500"
        aria-busy="true"
      >
        3D wird vorbereitet…
      </div>
    )
  }

  const attrs: ModelViewerAttrs = {
    ref: (el: HTMLElement | null) => {
      elRef.current = el
    },
    src: props.gltfUrl,
    'ios-src': props.usdzUrl,
    alt: props.alt ?? '3D-Vorschau des Raumscans',
    ar: true,
    'ar-modes': 'webxr scene-viewer quick-look',
    'camera-controls': true,
    'auto-rotate': true,
    'shadow-intensity': '1',
    style: { width: '100%', height: '100%' },
  }

  // `createElement` accepts any string tag — React forwards unknown
  // attributes as-is for custom elements, including the ref.
  return createElement('model-viewer', attrs)
}
