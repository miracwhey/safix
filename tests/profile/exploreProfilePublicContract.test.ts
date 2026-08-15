/**
 * ExploreCraftsmanProfileScreen (Public) — Block 2 Layout + Ownership Contract
 *
 * Freezes the Block-2 (Insta×TikTok×Handwerk) public profile layout so future
 * changes cannot silently re-introduce owner actions, drop the isOwnProfile
 * guard, or revert the new tab/portfolio contracts.
 *
 * Frozen invariants (Block 2):
 *   A. No owner actions: no PenLine, no add portfolio, no Bearbeiten action bar
 *   B. TABS = [reels, portfolio, stimmen] — explicitly NOT arbeitsproben/bewertungen/info
 *   C. isOwnProfile guard derived from currentUserId === profile.craftsmanId
 *   D. Overflow menu (3-dot) only shown when NOT own profile
 *   E. Portfolio reads published items only via the new dedicated grids
 *      (ProfileReelsGrid + ProfilePortfolioGrid) which both consume
 *      profile.portfolioItems from exploreProfileService
 *   F. No Entwurf badge — unpublished items never shown in public view
 *   G. No write flows in public view (no PortfolioItemComposer, no
 *      AddWorkSampleSheet, no JobPickerForPortfolio, no item action sheet)
 *   H. Render order: header → tab bar → tab content (trade-highlights row
 *      dropped in the Reels-Redesign; filtering now via grid chips)
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/screens/ExploreCraftsmanProfileScreen.tsx'),
  'utf-8',
)

// Only check the render section
const renderSection = source.slice(source.indexOf('return ('))

// ─── A. No owner actions ──────────────────────────────────────────────────────

describe('ExploreCraftsmanProfile public: no owner actions', () => {
  it('no PenLine import (edit icon)', () => {
    expect(source).not.toContain('PenLine')
  })

  it('no Bearbeiten action bar button', () => {
    expect(renderSection).not.toContain('Bearbeiten')
  })

  it('no add-portfolio button', () => {
    expect(source).not.toContain('AddWorkSampleSheet')
    expect(source).not.toContain('showAddSheet')
  })

  it('no AvatarUpload (avatar not editable in public view)', () => {
    expect(source).not.toContain('AvatarUpload')
  })

  it('no PortfolioItemComposer', () => {
    expect(source).not.toContain('PortfolioItemComposer')
  })

  it('no deletePortfolioItem call', () => {
    expect(source).not.toContain('deletePortfolioItem')
  })
})

// ─── B. Tab contract (Block 2) ───────────────────────────────────────────────

describe('ExploreCraftsmanProfile public: tab contract', () => {
  it('Reels tab key is absent (merged into Portfolio tab)', () => {
    expect(source).not.toMatch(/key:\s*'reels'/)
  })

  it('Portfolio tab key is present', () => {
    expect(source).toContain("'portfolio'")
  })

  it('Stimmen tab key is present', () => {
    expect(source).toContain("'stimmen'")
  })

  it('legacy arbeitsproben/bewertungen/info tab keys are gone', () => {
    expect(source).not.toContain("key: 'arbeitsproben'")
    expect(source).not.toContain("key: 'bewertungen'")
    expect(source).not.toContain("key: 'info'")
  })

  it('no Follow button', () => {
    expect(renderSection).not.toContain('Folgen')
    expect(renderSection).not.toContain('Follow')
  })

  it('default active tab is portfolio', () => {
    expect(source).toMatch(/useState<ProfileTabKey>\('portfolio'\)/)
  })

  it('uses the explore-specific ProfileTabBar (not the primitive one)', () => {
    expect(renderSection).toContain('ProfileTabBar')
    expect(source).toContain("from '../components/explore/ProfileTabBar'")
  })
})

// ─── C. isOwnProfile guard ───────────────────────────────────────────────────

describe('ExploreCraftsmanProfile public: isOwnProfile guard', () => {
  it('isOwnProfile derived from currentUserId and profile.craftsmanId', () => {
    expect(source).toContain('isOwnProfile')
    expect(source).toContain('currentUserId')
    expect(source).toContain('profile.craftsmanId')
  })

  it('isOwnProfile checks both currentUserId not null AND equality', () => {
    expect(source).toContain('currentUserId !== null')
    expect(source).toContain('currentUserId === profile.craftsmanId')
  })
})

// ─── D. Overflow menu gated on !isOwnProfile ─────────────────────────────────

describe('ExploreCraftsmanProfile public: overflow menu gating', () => {
  it('overflow menu only shown when not own profile', () => {
    expect(renderSection).toContain('!isOwnProfile')
  })

  it('overflow menu contains report option', () => {
    expect(renderSection).toContain('Profil melden')
  })

  it('overflow menu contains block option', () => {
    expect(renderSection).toContain('blockieren')
  })
})

// ─── E. Portfolio: public source via dedicated grids ─────────────────────────

describe('ExploreCraftsmanProfile public: portfolio source', () => {
  it('renders the dedicated portfolio grid and reviews tab', () => {
    expect(renderSection).toContain('ProfilePortfolioGrid')
    expect(renderSection).toContain('ProfileReviewsTab')
    expect(renderSection).not.toContain('ProfileReelsGrid')
  })

  it('legacy ProviderPortfolioGrid is no longer used', () => {
    expect(source).not.toContain('ProviderPortfolioGrid')
  })

  it('portfolio items come from profile.portfolioItems', () => {
    expect(renderSection).toContain('profile.portfolioItems')
  })

  it('does NOT import fetchOwnerPortfolio directly', () => {
    expect(source).not.toContain('fetchOwnerPortfolio')
  })

  it('no direct supabase provider_media query in this screen', () => {
    expect(source).not.toContain("from('provider_media')")
  })
})

// ─── F. No unpublished items in public view ───────────────────────────────────

describe('ExploreCraftsmanProfile public: no unpublished items', () => {
  it('no Entwurf badge in render section', () => {
    expect(renderSection).not.toContain('Entwurf')
  })

  it('no published state toggle logic', () => {
    expect(source).not.toContain('setPublished')
    expect(source).not.toContain('published:')
  })
})

// ─── G. No write flows ───────────────────────────────────────────────────────

describe('ExploreCraftsmanProfile public: no write flows', () => {
  it('no job picker', () => {
    expect(source).not.toContain('JobPickerForPortfolio')
  })

  it('no hidden file inputs for upload', () => {
    expect(renderSection).not.toContain('imageInputRef')
    expect(renderSection).not.toContain('videoInputRef')
  })

  it('no item action sheet (edit/delete)', () => {
    expect(source).not.toContain('ItemActionSheet')
  })
})

// ─── H. Tab / content render order ───────────────────────────────────────────

describe('ExploreCraftsmanProfile public: render order', () => {
  it('profile header appears before tab bar', () => {
    const headerPos = renderSection.indexOf('ExploreProfileHeaderCard')
    const tabBarPos = renderSection.indexOf('ProfileTabBar')
    expect(headerPos).toBeGreaterThan(-1)
    expect(tabBarPos).toBeGreaterThan(-1)
    expect(headerPos).toBeLessThan(tabBarPos)
  })

  it('trade highlights row is not rendered (redesign filters via grid chips)', () => {
    // Reels-Redesign „Handwerker Reels Profil": die Gewerk-Bubble-Reihe ist aus
    // dem Render genommen; gefiltert wird über die Chip-Reihe in
    // ProfilePortfolioGrid. Komponente + tradeHighlights-Datenfeld bleiben
    // erhalten (defer-don't-delete), nur die JSX-Verwendung im Screen entfällt.
    expect(renderSection).not.toContain('<TradeHighlightsRow')
  })

  it('tab bar appears before tab content', () => {
    const tabBarPos = renderSection.indexOf('ProfileTabBar')
    // Use the conditional block guard (not a prop expression) so position is unambiguous
    const contentPos = renderSection.indexOf("{activeTab === 'portfolio' &&")
    expect(tabBarPos).toBeGreaterThan(-1)
    expect(contentPos).toBeGreaterThan(-1)
    expect(tabBarPos).toBeLessThan(contentPos)
  })
})

// ─── I. Lightbox wire-up (M2.1) ──────────────────────────────────────────────

describe('ExploreCraftsmanProfile public: lightbox wire-up', () => {
  it('imports PortfolioLightbox', () => {
    expect(source).toContain("from '../components/explore/PortfolioLightbox'")
  })

  it('renders PortfolioLightbox in the screen', () => {
    expect(renderSection).toContain('PortfolioLightbox')
  })

  it('ProfileReelsGrid is absent (merged into Portfolio grid)', () => {
    expect(renderSection).not.toContain('ProfileReelsGrid')
  })

  it('passes onSelect to ProfilePortfolioGrid so a tap opens the lightbox', () => {
    const portfolioBlock = renderSection.match(/<ProfilePortfolioGrid[\s\S]*?\/>/)?.[0] ?? ''
    expect(portfolioBlock).toContain('onSelect')
    expect(portfolioBlock).toContain('setLightboxIndex')
  })

  it('lightbox open state derived from lightboxIndex (number | null)', () => {
    expect(source).toMatch(/useState<number\s*\|\s*null>\(null\)/)
    expect(renderSection).toMatch(/open=\{lightboxIndex\s*!==\s*null\}/)
  })

  it('passes currentUserId + providerOwnerUserId through to the lightbox (M2.3 comments)', () => {
    const lightboxBlock = renderSection.match(/<PortfolioLightbox[\s\S]*?\/>/)?.[0] ?? ''
    expect(lightboxBlock).toContain('currentUserId={currentUserId}')
    expect(lightboxBlock).toContain('providerOwnerUserId={profile.craftsmanId}')
  })

  it('share button removed (Issue 10) — craftsmanId/craftsmanName not forwarded to lightbox', () => {
    const lightboxBlock = renderSection.match(/<PortfolioLightbox[\s\S]*?\/>/)?.[0] ?? ''
    expect(lightboxBlock).not.toContain('craftsmanId={profile.craftsmanId}')
  })

  it('reads the ?reel deep-link param + opens the lightbox at that index (M2.4)', () => {
    expect(source).toContain('useSearchParams')
    expect(source).toContain('getShareReelParamName')
    expect(source).toContain("from '../lib/media/sharePortfolioItem'")
    // The hook resolves the param to a portfolio index then strips it so a
    // reload does not reopen the lightbox after the user closes it.
    expect(source).toMatch(/searchParams\.get\(getShareReelParamName\(\)\)/)
    expect(source).toMatch(/findIndex\(\(item\) => item\.id === requestedReelId\)/)
    expect(source).toMatch(/setLightboxIndex\(idx\)/)
    expect(source).toMatch(/next\.delete\(getShareReelParamName\(\)\)/)
  })
})
