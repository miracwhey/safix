import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetUserAgentForTesting,
  __setUserAgentForTesting,
  getPlaybackBlockReason,
  isAndroidChromium,
  isLikelyHevcMov,
  isVideoLikelyPlayable,
  selectVideoSource,
} from '../../src/lib/media/playbackCompat'
import type { PortfolioItem } from '../../src/lib/providerMedia/providerMediaTypes'

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const ANDROID_FIREFOX =
  'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0'
const ANDROID_SAMSUNG =
  'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/115.0.0.0 Mobile Safari/537.36'
const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const DESKTOP_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'

function makeItem(overrides: Partial<PortfolioItem>): PortfolioItem {
  return {
    id: 'item-1',
    providerId: 'provider-1',
    kind: 'portfolio',
    storagePath: 'portfolio/provider-1/abc.mov',
    publicUrl: 'https://example.com/portfolio/provider-1/abc.mov',
    mediaType: 'video',
    title: null,
    caption: null,
    description: null,
    tradeTags: [],
    sortOrder: 0,
    posterUrl: 'https://example.com/portfolio/provider-1/abc.mov.poster.jpg',
    h264Url: null,
    published: true,
    showPrice: false,
    showDuration: false,
    sourceJobId: null,
    projectTitleSnapshot: null,
    locationSnapshot: null,
    durationSnapshot: null,
    amountSnapshot: null,
    tradeTagsSnapshot: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe('playbackCompat — UA detection', () => {
  afterEach(() => {
    __resetUserAgentForTesting()
  })

  it('treats Android Chrome as Chromium', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(isAndroidChromium()).toBe(true)
  })

  it('treats Android Samsung Internet as Chromium', () => {
    __setUserAgentForTesting(ANDROID_SAMSUNG)
    expect(isAndroidChromium()).toBe(true)
  })

  it('does NOT classify Android Firefox as Chromium (defers to Mozilla decode story)', () => {
    __setUserAgentForTesting(ANDROID_FIREFOX)
    expect(isAndroidChromium()).toBe(false)
  })

  it('does NOT classify iOS Safari as Android', () => {
    __setUserAgentForTesting(IOS_SAFARI)
    expect(isAndroidChromium()).toBe(false)
  })

  it('does NOT classify iOS Chrome (CriOS) as Android (still WKWebView, plays HEVC)', () => {
    __setUserAgentForTesting(IOS_CHROME)
    expect(isAndroidChromium()).toBe(false)
  })

  it('does NOT classify Desktop Chrome as Android', () => {
    __setUserAgentForTesting(DESKTOP_CHROME)
    expect(isAndroidChromium()).toBe(false)
  })

  it('does NOT classify Desktop Safari as Android', () => {
    __setUserAgentForTesting(DESKTOP_SAFARI)
    expect(isAndroidChromium()).toBe(false)
  })

  it('returns false when navigator is unavailable (SSR / node)', () => {
    __setUserAgentForTesting(null)
    expect(isAndroidChromium()).toBe(false)
  })
})

describe('playbackCompat — isLikelyHevcMov', () => {
  it('matches lowercase .mov on storagePath', () => {
    expect(isLikelyHevcMov(makeItem({ storagePath: 'a/b/c.mov', publicUrl: null }))).toBe(true)
  })

  it('matches uppercase .MOV', () => {
    expect(isLikelyHevcMov(makeItem({ storagePath: 'a/b/c.MOV', publicUrl: null }))).toBe(true)
  })

  it('matches .mov when followed by query string in publicUrl', () => {
    expect(
      isLikelyHevcMov(
        makeItem({ storagePath: null, publicUrl: 'https://example.com/x/c.mov?token=abc' }),
      ),
    ).toBe(true)
  })

  it('does NOT match .mp4', () => {
    expect(
      isLikelyHevcMov(
        makeItem({ storagePath: 'a/b/c.mp4', publicUrl: 'https://example.com/c.mp4' }),
      ),
    ).toBe(false)
  })

  it('does NOT match for image items even when path ends .mov (defensive — no real image is .mov)', () => {
    expect(
      isLikelyHevcMov(makeItem({ mediaType: 'image', storagePath: 'a/b/x.mov', publicUrl: null })),
    ).toBe(false)
  })

  it('returns false when both paths are missing', () => {
    expect(isLikelyHevcMov(makeItem({ storagePath: null, publicUrl: null }))).toBe(false)
  })
})

describe('playbackCompat — isVideoLikelyPlayable', () => {
  afterEach(() => {
    __resetUserAgentForTesting()
  })

  it('returns true for image items regardless of UA', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(isVideoLikelyPlayable(makeItem({ mediaType: 'image' }))).toBe(true)
  })

  it('returns true for .mp4 video on Android Chrome', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(
      isVideoLikelyPlayable(
        makeItem({ storagePath: 'a/b/c.mp4', publicUrl: 'https://example.com/c.mp4' }),
      ),
    ).toBe(true)
  })

  it('returns false for .mov video on Android Chrome', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(isVideoLikelyPlayable(makeItem({}))).toBe(false)
  })

  it('returns true for .mov video on iOS Safari', () => {
    __setUserAgentForTesting(IOS_SAFARI)
    expect(isVideoLikelyPlayable(makeItem({}))).toBe(true)
  })

  it('returns true for .mov video on Desktop Safari', () => {
    __setUserAgentForTesting(DESKTOP_SAFARI)
    expect(isVideoLikelyPlayable(makeItem({}))).toBe(true)
  })

  it('returns true for .mov video in node/SSR environment (no UA)', () => {
    __setUserAgentForTesting(null)
    expect(isVideoLikelyPlayable(makeItem({}))).toBe(true)
  })
})

describe('playbackCompat — getPlaybackBlockReason', () => {
  afterEach(() => {
    __resetUserAgentForTesting()
  })

  it('returns null for image items', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(getPlaybackBlockReason(makeItem({ mediaType: 'image' }))).toBeNull()
  })

  it('returns null for .mp4 video on Android Chrome', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(
      getPlaybackBlockReason(
        makeItem({ storagePath: 'a/b/c.mp4', publicUrl: 'https://example.com/c.mp4' }),
      ),
    ).toBeNull()
  })

  it('returns null for .mov on iOS Safari (compat OK)', () => {
    __setUserAgentForTesting(IOS_SAFARI)
    expect(getPlaybackBlockReason(makeItem({}))).toBeNull()
  })

  it('returns the hevc-on-android-chromium reason for .mov on Android Chrome', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    const reason = getPlaybackBlockReason(makeItem({}))
    expect(reason).not.toBeNull()
    expect(reason?.code).toBe('hevc-on-android-chromium')
    expect(reason?.shortLabel).toBe('Nur iOS')
    expect(reason?.message.length).toBeGreaterThan(20)
  })

  it('returns the same reason for .mov on Android Samsung Internet', () => {
    __setUserAgentForTesting(ANDROID_SAMSUNG)
    expect(getPlaybackBlockReason(makeItem({}))?.code).toBe('hevc-on-android-chromium')
  })

  it('returns null for .mov on Android once h264Url is populated (Block 0 transcode landed)', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    const item = makeItem({ h264Url: 'https://example.com/portfolio/provider-1/abc.mp4' })
    expect(getPlaybackBlockReason(item)).toBeNull()
    expect(isVideoLikelyPlayable(item)).toBe(true)
  })
})

describe('playbackCompat — selectVideoSource (Block 0)', () => {
  afterEach(() => {
    __resetUserAgentForTesting()
  })

  it('returns the original publicUrl for image items', () => {
    expect(
      selectVideoSource(makeItem({ mediaType: 'image', publicUrl: 'https://example.com/img.jpg' })),
    ).toBe('https://example.com/img.jpg')
  })

  it('returns the original publicUrl when no transcode is available', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(selectVideoSource(makeItem({ h264Url: null }))).toBe(
      'https://example.com/portfolio/provider-1/abc.mov',
    )
  })

  it('returns the H.264 transcode for .mov on Android Chromium when available', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(
      selectVideoSource(
        makeItem({ h264Url: 'https://example.com/portfolio/provider-1/abc.mp4' }),
      ),
    ).toBe('https://example.com/portfolio/provider-1/abc.mp4')
  })

  it('does NOT swap on iOS Safari even when transcode exists (original is fine)', () => {
    __setUserAgentForTesting(IOS_SAFARI)
    expect(
      selectVideoSource(
        makeItem({ h264Url: 'https://example.com/portfolio/provider-1/abc.mp4' }),
      ),
    ).toBe('https://example.com/portfolio/provider-1/abc.mov')
  })

  it('does NOT swap when source is .mp4 (no codec gap to bridge)', () => {
    __setUserAgentForTesting(ANDROID_CHROME)
    expect(
      selectVideoSource(
        makeItem({
          storagePath: 'a/b/c.mp4',
          publicUrl: 'https://example.com/c.mp4',
          h264Url: 'https://example.com/c-h264.mp4',
        }),
      ),
    ).toBe('https://example.com/c.mp4')
  })

  it('returns null when neither source is available', () => {
    expect(
      selectVideoSource(makeItem({ publicUrl: null, storagePath: null, h264Url: null })),
    ).toBeNull()
  })
})
