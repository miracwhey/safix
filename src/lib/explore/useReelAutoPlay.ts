import { useEffect, useRef } from 'react'
import { isNative } from '../platform'

/**
 * Playback controller for in-feed reel videos.
 *
 * Single-authority model: the FEED decides which reel is active (one
 * IntersectionObserver in ExploreFeed sets `activeIndex`) and passes `active`
 * + `feedVisible` down. This hook deliberately does NOT run its own
 * IntersectionObserver — the previous decentralized design (one observer per
 * card) let off-screen neighbors play, overlapped audio mid-scroll, and left a
 * reel playing when the user switched tabs. Here a single derived `shouldPlay`
 * drives one effect that plays or EAGERLY pauses the single <video>:
 *
 *   shouldPlay = enabled && active && feedVisible && showingVideo && !paused
 *
 *   - active        this card is the feed's current reel (i === activeIndex)
 *   - feedVisible   /explore is the foreground surface. PersistentTabs keeps the
 *                   feed mounted via display:none when the user switches tabs,
 *                   which does NOT pause a <video> and does NOT fire
 *                   visibilitychange — so this flag is what stops route-switch
 *                   audio leaks.
 *   - showingVideo  the video is the visible carousel asset (assetIndex 0). A
 *                   multi-asset reel showing a photo overlay pauses the video.
 *   - paused        the user tapped to pause.
 *
 * Any false transition pauses immediately (no waiting for an intersection ratio
 * to reach 0), so two reels never play at once and audio never trails the
 * active card.
 *
 * Browser quirks handled
 *   - iOS WKWebView requires `muted` + `playsInline` to autoplay; the caller
 *     sets both as render-time props. On an unmuted-play rejection the hook
 *     replays MUTED immediately (no frozen poster) and calls `onPlayBlocked`
 *     so the caller can sync global mute state.
 *   - Native app background (Capacitor appStateChange) and web tab background
 *     (visibilitychange) both pause, then resume only if `shouldPlay` still
 *     holds.
 */
export function useReelAutoPlay(opts: {
  enabled: boolean
  /** This card is the feed's currently-active reel. */
  active: boolean
  /** The reels feed is the foreground surface (route active, search closed). */
  feedVisible: boolean
  /** The video asset is the visible carousel asset (assetIndex 0). */
  showingVideo: boolean
  /** The user tapped to pause this reel. */
  paused?: boolean
  /**
   * Called when an autoplay attempt is rejected — typically an unmuted play()
   * without a fresh user gesture on iOS. The hook already replayed muted; this
   * lets the caller fall back global mute state.
   */
  onPlayBlocked?: () => void
}): React.RefObject<HTMLVideoElement | null> {
  const { enabled, active, feedVisible, showingVideo, paused = false, onPlayBlocked } = opts
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const shouldPlay = enabled && active && feedVisible && showingVideo && !paused
  const shouldPlayRef = useRef(shouldPlay)
  const onPlayBlockedRef = useRef(onPlayBlocked)

  useEffect(() => {
    onPlayBlockedRef.current = onPlayBlocked
  }, [onPlayBlocked])

  // ── The one playback authority ────────────────────────────────────────────
  // Play when shouldPlay flips true; pause IMMEDIATELY on any false transition.
  useEffect(() => {
    shouldPlayRef.current = shouldPlay
    const video = videoRef.current
    if (!video) return
    if (shouldPlay) {
      video.play().catch(() => {
        // A pending play() rejects with AbortError when a later pause()
        // interrupts it — e.g. the user taps to pause while the freshly-active
        // reel is still buffering. Honor that: if we should no longer be
        // playing, do NOT resurrect, or tap-to-pause "does nothing" and the
        // video plays on muted. shouldPlayRef was already set false by the
        // pause effect run that triggered this rejection.
        if (!shouldPlayRef.current) return
        // Otherwise it's a real autoplay block (iOS needs a fresh gesture) →
        // replay muted so the reel plays instead of freezing, and sync global
        // mute state.
        video.muted = true
        void video.play().catch(() => {})
        onPlayBlockedRef.current?.()
      })
    } else {
      video.pause()
    }
  }, [shouldPlay])

  // ── Stall recovery + unmount teardown ─────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    const video = videoRef.current
    if (!video) return
    const handleStall = () => {
      if (shouldPlayRef.current) video.play().catch(() => {})
    }
    video.addEventListener('stalled', handleStall)
    return () => {
      video.removeEventListener('stalled', handleStall)
      // Hard media release on teardown. pause() alone is NOT enough on iOS
      // WKWebView: a removed <video> can keep holding the audio session, so the
      // previous reel's sound keeps playing AND the next reel is blocked from
      // starting. Repro: search → tap a trending reel (plays in the feed) →
      // search again → tap another trending reel → old audio continues and the
      // new video stays silent. Detaching the source forces the element to
      // release the media resource + audio focus. `enabled` is stable per card
      // (isItemReel && isVideo), so this runs on unmount, not while scrolling.
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch {
        // element already torn down — nothing to release
      }
    }
  }, [enabled])

  // ── Native app background (Capacitor) ─────────────────────────────────────
  // document.visibilityState is unreliable on iOS WKWebView for the Home button
  // / app switcher — appStateChange is authoritative. Pause on background,
  // resume only if the reel should still be playing.
  useEffect(() => {
    if (!enabled || !isNative()) return
    let handle: { remove: () => Promise<void> } | null = null
    let mounted = true
    void (async () => {
      const { App } = await import('@capacitor/app')
      const h = await App.addListener('appStateChange', ({ isActive }) => {
        const video = videoRef.current
        if (!video) return
        if (isActive) {
          if (shouldPlayRef.current) video.play().catch(() => {})
        } else {
          video.pause()
        }
      })
      if (!mounted) void h.remove()
      else handle = h
    })()
    return () => {
      mounted = false
      if (handle) void handle.remove()
    }
  }, [enabled])

  // ── Web tab background (PWA / desktop) ────────────────────────────────────
  useEffect(() => {
    if (!enabled) return
    if (typeof document === 'undefined') return
    const onVis = () => {
      const video = videoRef.current
      if (!video) return
      if (document.visibilityState === 'visible') {
        if (shouldPlayRef.current) video.play().catch(() => {})
      } else {
        video.pause()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [enabled])

  return videoRef
}
