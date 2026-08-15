import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Continuous viewport-presence hook. Returns a ref to attach to an element and
 * a boolean that is `true` while the element intersects the viewport (expanded
 * by `rootMargin`). Unlike {@link useInViewportOnce} it flips back to `false`
 * when the element scrolls out — callers use it to release per-element
 * resources (Realtime channels, status fetches) for off-screen items.
 *
 * Fails open: when IntersectionObserver is unavailable (or before the element
 * mounts) it reports `true`, so functionality is never gated off on an
 * unsupported environment.
 */
export function useInViewport<T extends Element = HTMLDivElement>(options?: {
  rootMargin?: string
  threshold?: number
}): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  // Start false so off-screen cards never fire an initial fetch/channel; the
  // observer flips visible ones true within a frame. Fails open below when no
  // IntersectionObserver is available.
  const [inView, setInView] = useState(false)
  const rootMargin = options?.rootMargin ?? '200px'
  const threshold = options?.threshold ?? 0

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      // Fail open on environments without IntersectionObserver so gated
      // functionality is never permanently disabled.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setInView(entry.isIntersecting)
      },
      { rootMargin, threshold },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin, threshold])

  return [ref, inView]
}
