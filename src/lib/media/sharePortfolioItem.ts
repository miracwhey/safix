import type { PortfolioItem } from '../providerMedia'

export function buildProfileShareUrl(craftsmanId: string, origin: string): string {
  const base = origin.replace(/\/+$/, '')
  return `${base}/explore/craftsman/${craftsmanId}`
}

export async function shareProfile(input: {
  craftsmanId: string
  craftsmanName: string
  origin: string
}): Promise<ShareOutcome> {
  const url = buildProfileShareUrl(input.craftsmanId, input.origin)
  const text = `${input.craftsmanName} auf SaFix`

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: input.craftsmanName, text, url })
      return { kind: 'shared' }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { kind: 'aborted' }
    }
  }

  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(url)
      return { kind: 'copied' }
    } catch (err) {
      return { kind: 'failed', reason: err instanceof Error ? err.message : 'clipboard.writeText failed' }
    }
  }

  return { kind: 'unsupported' }
}

/**
 * Share helper for portfolio reels (M2.4).
 *
 * Builds a deep-link URL pointing at the craftsman's public profile with
 * a `?reel={itemId}` parameter. The receiving screen reads the param on
 * mount and opens the lightbox at the matching item, mirroring TikTok /
 * Instagram-Reels behavior where shared links land directly on the
 * relevant clip rather than at the top of the feed.
 *
 * `craftsmanId` is the route parameter for the public profile (also the
 * auth user id of the provider, since `profiles.id = auth.users.id`).
 */

export type ShareOutcome =
  | { kind: 'shared' }
  | { kind: 'copied' }
  | { kind: 'aborted' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; reason: string }

const PORTFOLIO_REEL_QUERY_PARAM = 'reel'

export function buildPortfolioItemShareUrl(
  item: Pick<PortfolioItem, 'id'>,
  craftsmanId: string,
  origin: string,
): string {
  const base = origin.replace(/\/+$/, '')
  return `${base}/explore/craftsman/${craftsmanId}?${PORTFOLIO_REEL_QUERY_PARAM}=${encodeURIComponent(item.id)}`
}

export function getShareReelParamName(): string {
  return PORTFOLIO_REEL_QUERY_PARAM
}

type ShareInput = {
  item: PortfolioItem
  craftsmanId: string
  craftsmanName: string
  origin: string
}

/**
 * Invokes `navigator.share` when supported, falls back to clipboard copy.
 *
 * Returns a structured `ShareOutcome` so the caller can decide which
 * toast tone to show. `aborted` covers the user cancelling the native
 * share sheet — that is not an error and the UI should stay quiet.
 *
 * The share `title` carries the craftsman name; `text` carries the reel
 * caption when present, otherwise a neutral default. Browsers vary on
 * which fields they actually surface, so all three are populated.
 */
export async function sharePortfolioItem(input: ShareInput): Promise<ShareOutcome> {
  const url = buildPortfolioItemShareUrl(input.item, input.craftsmanId, input.origin)
  const caption = (input.item.title ?? input.item.caption ?? '').trim()
  const text =
    caption.length > 0
      ? caption
      : `Schau dir diese Arbeitsprobe von ${input.craftsmanName} auf SaFix an.`
  const title = input.craftsmanName

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url })
      return { kind: 'shared' }
    } catch (err) {
      // AbortError = user cancelled — surface as aborted, not failed.
      if (err instanceof Error && err.name === 'AbortError') {
        return { kind: 'aborted' }
      }
      // Fall through to clipboard if Share API rejected for any other reason.
    }
  }

  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (clip && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(url)
      return { kind: 'copied' }
    } catch (err) {
      return {
        kind: 'failed',
        reason: err instanceof Error ? err.message : 'clipboard.writeText failed',
      }
    }
  }

  return { kind: 'unsupported' }
}
