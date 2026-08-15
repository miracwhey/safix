/**
 * Sticky-once IntersectionObserver hook.
 *
 * Returns a ref + a boolean that flips to `true` the first time the observed
 * element crosses the viewport threshold and stays `true` afterwards. Used by
 * the Spatial Hub cards (Ü-01) to defer mounting the model-viewer (~120 KB
 * lazy chunk + WebGL context) until the card is actually scrolled into view —
 * a Kanban column with 12 cards otherwise pays the cost 12× upfront.
 *
 * Falls back to `true` immediately when `IntersectionObserver` is unavailable
 * (jsdom test runner, very old WebViews) so callers never starve.
 */

import { useEffect, useRef, useState } from 'react'

export interface UseInViewportOnceOptions {
  /** Forwarded to the underlying IntersectionObserver. */
  rootMargin?: string
  /** Forwarded to the underlying IntersectionObserver. */
  threshold?: number | number[]
}

export function useInViewportOnce<T extends Element = HTMLDivElement>(
  options: UseInViewportOnceOptions = {},
): { ref: React.RefObject<T | null>; visible: boolean } {
  const ref = useRef<T | null>(null)
  // Environments without IntersectionObserver (jsdom test runner, very old
  // WebViews) seed `true` synchronously so consumers don't starve waiting on
  // an observer that will never fire. Doing it in the lazy initializer keeps
  // the effect free of the cascading-setState anti-pattern flagged by
  // `react-hooks/set-state-in-effect`.
  const [visible, setVisible] = useState<boolean>(
    () => typeof IntersectionObserver === 'undefined',
  )

  useEffect(() => {
    if (visible) return
    const node = ref.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true)
            observer.disconnect()
            return
          }
        }
      },
      {
        rootMargin: options.rootMargin ?? '64px',
        threshold: options.threshold ?? 0,
      },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [visible, options.rootMargin, options.threshold])

  return { ref, visible }
}
