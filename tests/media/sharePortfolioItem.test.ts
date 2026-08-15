import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPortfolioItemShareUrl,
  getShareReelParamName,
  sharePortfolioItem,
} from '../../src/lib/media/sharePortfolioItem'
import type { PortfolioItem } from '../../src/lib/providerMedia/providerMediaTypes'

function makeItem(overrides: Partial<PortfolioItem> = {}): PortfolioItem {
  return {
    id: 'reel-1',
    providerId: 'provider-1',
    kind: 'portfolio',
    storagePath: null,
    publicUrl: null,
    mediaType: 'video',
    title: 'Eichentisch geschliffen',
    caption: null,
    description: null,
    tradeTags: [],
    sortOrder: 0,
    posterUrl: null,
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

describe('buildPortfolioItemShareUrl', () => {
  it('routes to the public craftsman profile with the reel param', () => {
    const url = buildPortfolioItemShareUrl(makeItem(), 'craft-uuid', 'https://app.safix.digital')
    expect(url).toBe('https://app.safix.digital/explore/craftsman/craft-uuid?reel=reel-1')
  })

  it('strips trailing slashes from the origin', () => {
    const url = buildPortfolioItemShareUrl(makeItem(), 'craft-uuid', 'https://app.safix.digital/')
    expect(url).toBe('https://app.safix.digital/explore/craftsman/craft-uuid?reel=reel-1')
  })

  it('encodes the reel id', () => {
    const url = buildPortfolioItemShareUrl(
      makeItem({ id: 'a/b c' }),
      'craft-uuid',
      'https://app.safix.digital',
    )
    expect(url).toContain('reel=a%2Fb%20c')
  })
})

describe('getShareReelParamName', () => {
  it('returns the canonical param name', () => {
    expect(getShareReelParamName()).toBe('reel')
  })
})

describe('sharePortfolioItem — Web Share API path', () => {
  const originalNavigator = globalThis.navigator
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true })
  })

  it('returns shared when navigator.share resolves', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis, 'navigator', {
      value: { share, clipboard: { writeText: vi.fn() } },
      configurable: true,
    })

    const outcome = await sharePortfolioItem({
      item: makeItem(),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    expect(outcome).toEqual({ kind: 'shared' })
    expect(share).toHaveBeenCalledWith({
      title: 'Anna Holz',
      text: 'Eichentisch geschliffen',
      url: 'https://app.safix.digital/explore/craftsman/craft-uuid?reel=reel-1',
    })
  })

  it('returns aborted when the user cancels the native sheet (AbortError)', async () => {
    const abort = new DOMException('cancelled', 'AbortError')
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        share: vi.fn().mockRejectedValue(abort),
        clipboard: { writeText: vi.fn() },
      },
      configurable: true,
    })

    const outcome = await sharePortfolioItem({
      item: makeItem(),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    expect(outcome).toEqual({ kind: 'aborted' })
  })

  it('falls back to clipboard when navigator.share rejects with non-Abort error', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        share: vi.fn().mockRejectedValue(new Error('boom')),
        clipboard: { writeText },
      },
      configurable: true,
    })

    const outcome = await sharePortfolioItem({
      item: makeItem(),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    expect(outcome).toEqual({ kind: 'copied' })
    expect(writeText).toHaveBeenCalledWith(
      'https://app.safix.digital/explore/craftsman/craft-uuid?reel=reel-1',
    )
  })
})

describe('sharePortfolioItem — clipboard-only path', () => {
  const originalNavigator = globalThis.navigator
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true })
  })

  it('returns copied when share is unavailable but clipboard works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    })

    const outcome = await sharePortfolioItem({
      item: makeItem(),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    expect(outcome).toEqual({ kind: 'copied' })
    expect(writeText).toHaveBeenCalled()
  })

  it('returns failed when clipboard.writeText rejects', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } },
      configurable: true,
    })

    const outcome = await sharePortfolioItem({
      item: makeItem(),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    expect(outcome.kind).toBe('failed')
  })

  it('returns unsupported when neither share nor clipboard is available', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    })

    const outcome = await sharePortfolioItem({
      item: makeItem(),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    expect(outcome).toEqual({ kind: 'unsupported' })
  })
})

describe('sharePortfolioItem — fallback caption', () => {
  const originalNavigator = globalThis.navigator
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true })
  })

  it('uses a default sentence when the item has no title and no caption', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis, 'navigator', {
      value: { share, clipboard: { writeText: vi.fn() } },
      configurable: true,
    })

    await sharePortfolioItem({
      item: makeItem({ title: null, caption: null }),
      craftsmanId: 'craft-uuid',
      craftsmanName: 'Anna Holz',
      origin: 'https://app.safix.digital',
    })

    const text = share.mock.calls[0]?.[0]?.text as string | undefined
    expect(text).toContain('Anna Holz')
    expect(text).toContain('SaFix')
  })
})
