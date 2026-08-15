import type { PortfolioItem } from '../providerMedia/providerMediaTypes'

/**
 * Heuristic compatibility check for portfolio video tiles.
 *
 * Background: customers record portfolio videos on iPhones (HEVC inside an
 * `.mov` container). HEVC is decodable on iOS Safari and on most desktop
 * browsers behind a hardware fallback, but NOT on Android Chrome / Firefox.
 * The poster frame extracted at upload time (#840) keeps the tile from going
 * black, but a tap that triggers playback would still fail silently. This
 * module gives renderers a single source of truth so they can either swap a
 * "Play" indicator for an "iOS only" badge in the grid (Quick-Block-0) or
 * surface a fullscreen banner instead of a dead `<video>` element in the
 * lightbox player (M2.1).
 *
 * Trade-off: we can't actually probe codec support without an HTMLMediaElement
 * + media-source-extensions interrogation, and that probe is expensive on
 * mount. Instead we use a static heuristic — extension `.mov` on Android
 * Chromium is treated as not playable. False positives (an H.264 inside .mov
 * on Android) are rare; false negatives (an HEVC inside .mp4 sneaked through
 * upload) are blocked by the upload pipeline already.
 */

export type PlaybackBlockReason = {
  code: 'hevc-on-android-chromium'
  /** Human-readable reason, German. Surfaced in banners + accessibility text. */
  message: string
  /** Short label for badges in dense UI (grid tiles). */
  shortLabel: string
}

/**
 * Override entrypoint for tests: by default the helper reads `navigator`
 * from the environment, but vitest runs in `node` so tests can install a
 * synthetic UA via this setter without polluting `globalThis.navigator`.
 */
let userAgentOverride: string | null | undefined

export function __setUserAgentForTesting(ua: string | null | undefined): void {
  userAgentOverride = ua
}

export function __resetUserAgentForTesting(): void {
  userAgentOverride = undefined
}

function readUserAgent(): string {
  if (userAgentOverride !== undefined) return userAgentOverride ?? ''
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgent ?? ''
}

/**
 * Android + Chromium-based browser (Chrome, Edge, Samsung Internet, Brave).
 * Firefox-on-Android is excluded because Mozilla ships its own HEVC story
 * and may add support without our helper noticing — we err on the safe side
 * and treat Firefox as "we don't know, let it try".
 */
export function isAndroidChromium(): boolean {
  const ua = readUserAgent()
  if (!ua) return false
  if (!/Android/i.test(ua)) return false
  if (/Firefox/i.test(ua)) return false
  return /Chrome|CriOS|EdgA|SamsungBrowser/i.test(ua)
}

/**
 * Conservative `.mov` detector. iOS records HEVC into `.mov` by default
 * since iOS 11; treating any `.mov` portfolio asset as HEVC-likely is
 * accurate enough for the warning UX while staying cheap.
 */
export function isLikelyHevcMov(item: PortfolioItem): boolean {
  if (item.mediaType !== 'video') return false
  const candidate = item.storagePath ?? item.publicUrl ?? ''
  if (!candidate) return false
  const lower = candidate.toLowerCase()
  // Strip query string before extension probe: signed URLs can append `?token=…`.
  const withoutQuery = lower.split('?')[0]
  return withoutQuery.endsWith('.mov')
}

/**
 * Returns the URL the renderer should pass to `<video src>`. When the
 * Block 0 transcode pipeline has produced an H.264 fallback for this
 * item AND the current browser cannot decode the original, the
 * transcode wins. In every other case we keep the original public URL.
 *
 * Returns null when neither source is available (a renderer should then
 * skip the `<video>` and show the poster only).
 */
export function selectVideoSource(item: PortfolioItem): string | null {
  if (item.mediaType !== 'video') return item.publicUrl ?? null
  const original = item.publicUrl ?? null
  const transcoded = item.h264Url ?? null
  if (!transcoded) return original
  if (!isLikelyHevcMov(item)) return original
  if (!isAndroidChromium()) return original
  return transcoded
}

/**
 * True when we believe the current browser can decode this tile's video
 * source. Non-video items always return true (they aren't gated). When a
 * Block 0 H.264 transcode is available we treat the item as playable
 * even on Android Chromium because the renderer will pick the transcode
 * via `selectVideoSource`. Server-side rendering and unit tests without
 * a synthetic UA also return true so the default render path is unchanged.
 */
export function isVideoLikelyPlayable(item: PortfolioItem): boolean {
  if (item.mediaType !== 'video') return true
  if (item.h264Url) return true
  if (!isLikelyHevcMov(item)) return true
  return !isAndroidChromium()
}

/**
 * Inverse of `isVideoLikelyPlayable` with a structured reason payload, so
 * callers can render the correct copy without re-deriving the cause.
 *
 * Once `provider_media.h264_url` is populated by the Block 0 transcode
 * pipeline, the reason clears for that item — the lightbox renders the
 * H.264 fallback and grid tiles drop the "Nur iOS" badge.
 */
export function getPlaybackBlockReason(item: PortfolioItem): PlaybackBlockReason | null {
  if (item.mediaType !== 'video') return null
  if (item.h264Url) return null
  if (!isLikelyHevcMov(item)) return null
  if (!isAndroidChromium()) return null
  return {
    code: 'hevc-on-android-chromium',
    message:
      'Dieses Video wurde mit einem iPhone aufgenommen und ist auf Android Chrome derzeit nicht abspielbar. Bitte öffne das Profil auf einem iPhone oder Mac.',
    shortLabel: 'Nur iOS',
  }
}
