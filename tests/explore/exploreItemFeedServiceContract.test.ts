/**
 * Explore Item-Feed Service — Source-of-Truth Contract
 *
 * Freezes the canonical M3.1+ read path so future changes cannot silently
 * break the BottomNav `/explore` Reels feed. Mirrors the source-string
 * contract pattern used by portfolioServiceContract.test.ts.
 *
 * Frozen invariants (post-2026-05-05 visibility-fix):
 *   A. Targets two tables in sequence:
 *        1) `provider_media`           (Public-Read via provider_is_public())
 *        2) `discovery_providers` view (PII-free, public GRANT)
 *      A direct embed of `providers!inner` is FORBIDDEN — it silently
 *      collapses to zero rows for non-owner viewers under the 7.1G PII
 *      lockdown (providers is owner-read-only).
 *   B. provider_media filters: kind='portfolio' AND published=true.
 *   C. discovery_providers filters: provider_id IN (…) AND is_public=true.
 *   D. Orders by sort_order DESC, id DESC (stable cursor).
 *   E. Selects the M3.1 columns including poster_url + h264_url.
 *   F. Cursor pagination via `(sort_order, id)`.
 *   G. Distinct-provider window applied via applyDistinctProviderWindow.
 *   H. Mapper produces ExploreReel with mediaId == provider_media.id.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/lib/explore/exploreItemFeedService.ts'),
  'utf-8',
)

describe('exploreItemFeedService: table source', () => {
  it('queries provider_media for the media rows', () => {
    expect(source).toContain(".from('provider_media')")
  })

  it('queries discovery_providers (PII-free public view) for provider metadata', () => {
    expect(source).toContain(".from('discovery_providers')")
  })

  it('does not embed providers via PostgREST !inner — that path returns 0 rows for non-owner viewers post-7.1G', () => {
    expect(source).not.toMatch(/providers!inner/)
  })

  it('does not query the bare providers table directly (owner-read-only post-7.1G)', () => {
    expect(source).not.toContain(".from('providers')")
  })

  it('targets provider_media + discovery_providers + provider_media_assets as data sources', () => {
    const fromCalls = source.match(/\.from\(['"`](\w+)['"`]\)/g) ?? []
    const tables = fromCalls.map((c) => c.replace(/\.from\(['"`]|['"`]\)/g, ''))
    expect(new Set(tables)).toEqual(
      new Set(['provider_media', 'discovery_providers', 'provider_media_assets'])
    )
  })
})

describe('exploreItemFeedService: filters', () => {
  it("filters kind = 'portfolio' on provider_media", () => {
    expect(source).toContain(".eq('kind', 'portfolio')")
  })

  it('filters published = true on provider_media', () => {
    expect(source).toContain(".eq('published', true)")
  })

  it('filters is_public = true on discovery_providers (post-fetch RLS-equivalent guard)', () => {
    expect(source).toContain(".eq('is_public', true)")
  })

  it('joins discovery_providers via .in(provider_id, …) — no row-tuple embed', () => {
    expect(source).toContain(".in('provider_id', providerIds)")
  })
})

describe('exploreItemFeedService: ordering', () => {
  it('orders by sort_order descending', () => {
    expect(source).toContain("order('sort_order', { ascending: false })")
  })

  it('uses id DESC as a stable tiebreaker for cursor pagination', () => {
    expect(source).toContain("order('id', { ascending: false })")
  })
})

describe('exploreItemFeedService: column selection', () => {
  it('selects poster_url for video cover frames', () => {
    expect(source).toContain('poster_url')
  })

  it('selects h264_url for cross-platform fallback', () => {
    expect(source).toContain('h264_url')
  })

  it('selects sort_order so cursors can be emitted', () => {
    expect(source).toContain('sort_order')
  })

  it('selects handle from discovery_providers for canonical @user identifier', () => {
    expect(source).toMatch(/handle/)
  })

  it('selects display_name from discovery_providers as profile fallback', () => {
    expect(source).toContain('display_name')
  })
})

describe('exploreItemFeedService: cursor pagination', () => {
  it('emits a tuple cursor with sort_order + id', () => {
    expect(source).toContain('sortOrder: last.sort_order')
    expect(source).toContain('id: last.id')
  })

  it('applies the cursor as a sort_order keyset filter', () => {
    expect(source).toContain('sort_order.lt.')
  })
})

describe('exploreItemFeedService: mapper invariants', () => {
  it('mediaId mirrors provider_media.id', () => {
    expect(source).toMatch(/mediaId:\s*row\.id/)
  })

  it('emits the legacy featuredMediaId alias for transitional reads', () => {
    expect(source).toMatch(/featuredMediaId:\s*row\.id/)
  })

  it('mediaType narrows row.media_type to image|video', () => {
    expect(source).toContain("row.media_type === 'video' ? 'video' : 'image'")
  })

  it('craftsmanId mirrors providers.profile_id', () => {
    expect(source).toContain('provider.profile_id')
  })

  it('parses trade_categories via CSV split (live schema is TEXT)', () => {
    expect(source).toContain('splitTradeCategoriesCsv')
    expect(source).toMatch(/\.split\(','\)/)
  })

  it('falls back to toItemFeedHandle when discovery_providers.handle is empty', () => {
    expect(source).toContain('toItemFeedHandle')
  })

  it('thumbnailUrl prefers poster_url for videos, public_url for images', () => {
    expect(source).toMatch(/mediaType === 'video' \? row\.poster_url \?\? row\.public_url/)
  })

  it('skips rows whose provider is missing from discovery_providers (not public / RLS-filtered)', () => {
    expect(source).toMatch(/providerById\.get\(row\.provider_id\)/)
    expect(source).toMatch(/if \(!provider\)\s*continue/)
  })

  it('skips rows without public_url so the renderer never receives a null URL', () => {
    expect(source).toContain('if (!row.public_url) return null')
  })
})

describe('exploreItemFeedService: distinct-provider window', () => {
  it('imports and applies applyDistinctProviderWindow', () => {
    expect(source).toContain('applyDistinctProviderWindow')
  })

  it('passes the configured windowSize through (default 5)', () => {
    expect(source).toContain('DEFAULT_DISTINCT_WINDOW = 5')
  })
})

describe('exploreItemFeedService: M3.2 ranking', () => {
  it('routes the for-you tab through sortReelsByForYou (no longer a TODO placeholder)', () => {
    expect(source).toContain('sortReelsByForYou')
  })

  it('imports the ranking module so the dependency is explicit', () => {
    expect(source).toContain("from './exploreRanking'")
  })

  it('threads opts.viewerContext into sortFeedReels — pagination shares the same ranker context', () => {
    expect(source).toMatch(/sortFeedReels\(mapped,\s*opts\.tab,\s*opts\.viewerContext/)
  })

  it('inspiration tab keeps the SQL sort_order DESC unchanged', () => {
    // The for-you branch routes through sortReelsByForYou; the
    // inspiration branch must NOT call it (otherwise tabs would converge
    // again). Pin the early-return for inspiration.
    expect(source).toMatch(/tab\s*===\s*['"]foryou['"]/)
  })
})

describe('exploreItemFeedService: M3 multi-asset fetch', () => {
  it('queries provider_media_assets for all mapped portfolio item IDs', () => {
    expect(source).toContain(".from('provider_media_assets')")
    expect(source).toContain("'portfolio_item_id'")
  })

  it('orders assets by sort_order ascending so cover (0) is first', () => {
    expect(source).toContain("order('sort_order', { ascending: true })")
  })

  it('attaches assets array to each reel after fetch', () => {
    expect(source).toMatch(/reel\.assets\s*=\s*assetsByItemId\.get\(reel\.id\)/)
  })

  it('falls back to assets=[] on fetch error so single-asset cover path is preserved', () => {
    expect(source).toMatch(/assetsByItemId\.get\(reel\.id\)\s*\?\?\s*\[\]/)
  })
})
