import { useEffect, useRef } from 'react'

/**
 * Hard media release for a `<video>` rendered outside the reel-feed playback
 * authority (`useReelAutoPlay`, which already owns its own teardown).
 *
 * Why this exists: on iOS WKWebView `pause()` alone is NOT enough. A `<video>`
 * that React removes from the DOM (on close, route change, or a `key` swap that
 * remounts the element) can keep holding the audio session — so the previous
 * clip's sound keeps playing AND a later `<video>` is blocked from starting.
 * Detaching the source (`removeAttribute('src')` + `load()`) forces the element
 * to release the media resource + audio focus. This is the exact failure that
 * was fixed for the reels feed; this hook applies the same release to the other
 * surfaces that play media (lightbox, story viewer, grids, chat bubbles).
 *
 * Usage: attach the returned ref to the `<video>`. Pass a `key` that changes
 * whenever the active media changes (e.g. `item.id` + asset index). The release
 * runs on unmount AND on every `key` change, so navigating to the next clip
 * releases the outgoing element before the new one plays.
 *
 *   const videoRef = useVideoTeardown(`${item.id}:${assetIndex}`)
 *   <video ref={videoRef} ... />
 *
 * The element captured at effect-run time is the one released in cleanup, so a
 * `key`-driven remount releases the element that is going away even though
 * `videoRef.current` has already been repointed to the incoming element.
 */
export function useVideoTeardown(
  key?: string | number,
): React.RefObject<HTMLVideoElement | null> {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    return () => {
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        // element already torn down — nothing to release
      }
    }
  }, [key])
  return videoRef
}
