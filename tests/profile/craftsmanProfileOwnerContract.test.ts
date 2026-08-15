/**
 * CraftsmanProfile (Owner) — Block 4 Insta-Layout + Ownership Contract
 *
 * Freezes the Block-4 (Profile-Unification) owner profile so future
 * changes cannot silently re-introduce the legacy Arbeitsproben/Bewertungen/
 * Info tabs, drop the shared `InstaProfileHeader`, or sever the owner's
 * edit/admin flows.
 *
 * Frozen invariants (Block 4):
 *   A. Owner actions present in the InstaProfileHeader action-row:
 *      + Arbeitsprobe (primary), Bearbeiten (icon), Vorschau (icon)
 *   B. TABS = [reels, portfolio, stimmen] — explicitly NOT
 *      arbeitsproben/bewertungen/info
 *   C. Shared InstaProfileHeader primitive is rendered (not an ad-hoc header)
 *   D. Portfolio reads from fetchOwnerPortfolio (drafts visible)
 *   E. Owner grid uses ProfileReelsGrid + ProfilePortfolioGrid (Entwurf-badge
 *      lives there, cross-file)
 *   F. Edit/Delete flow reachable: ItemActionSheet, PortfolioItemComposer,
 *      AddWorkSampleSheet, JobPickerForPortfolio
 *   G. Composer used in both `mode="create"` and `mode="edit"`
 *   H. Delete guard: deletePortfolioItem(item.id, item.assets) — M2: passes asset array
 *   I. Owner-Overflow gateway to admin flows: Tax/Bank + Team-Settings + Edit-Form
 *   J. AvatarUpload uses compact variant for the Insta-Header
 *   K. Render order: InstaProfileHeader → ProfileTabBar → tab content
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

const source = fs.readFileSync(
  path.resolve(repoRoot, 'src/screens/CraftsmanProfile.tsx'),
  'utf-8',
)
const renderSection = source.slice(source.indexOf('return ('))

const reelsGridSrc = fs.readFileSync(
  path.resolve(repoRoot, 'src/components/explore/ProfileReelsGrid.tsx'),
  'utf-8',
)
const portfolioGridSrc = fs.readFileSync(
  path.resolve(repoRoot, 'src/components/explore/ProfilePortfolioGrid.tsx'),
  'utf-8',
)

// ─── A. Owner action-row ─────────────────────────────────────────────────────

describe('CraftsmanProfile owner: action row', () => {
  it('imports PenLine + Eye + Plus for the action triplet', () => {
    expect(source).toContain('PenLine')
    expect(source).toContain('Eye')
    expect(source).toContain('Plus')
  })

  it('+ Arbeitsprobe is wired as the primary action', () => {
    expect(source).toContain('+ Arbeitsprobe')
    expect(source).toMatch(/key:\s*'add-sample'[\s\S]*?variant:\s*'primary'/)
  })

  it('Bearbeiten is wired as an icon action that navigates to the edit route', () => {
    expect(source).toContain('Bearbeiten')
    expect(source).toContain("/craftsman/profile/edit")
  })

  it('Vorschau navigates to /explore/craftsman/{userId}', () => {
    expect(source).toContain('Vorschau')
    expect(source).toContain('/explore/craftsman/')
  })

  it('legacy onboarding-route reuse is gone', () => {
    expect(source).not.toContain('/onboarding/craftsman-profile')
  })
})

// ─── B. Tab contract (Block 4) ───────────────────────────────────────────────

describe('CraftsmanProfile owner: tab contract', () => {
  it('Reels tab key is absent (merged into Portfolio tab)', () => {
    expect(source).not.toMatch(/key:\s*'reels'/)
  })

  it('Portfolio tab key is present', () => {
    expect(source).toContain("'portfolio'")
  })

  it('Stimmen tab key is present', () => {
    expect(source).toContain("'stimmen'")
  })

  it('legacy arbeitsproben/bewertungen/info TAB definitions are gone', () => {
    expect(source).not.toContain("key: 'arbeitsproben'")
    expect(source).not.toContain("key: 'bewertungen'")
    expect(source).not.toContain("key: 'info'")
  })

  it('default active tab is portfolio', () => {
    expect(source).toMatch(/useState<ProfileTabKey>\('portfolio'\)/)
  })

  it('uses the explore-specific ProfileTabBar (not the primitive)', () => {
    expect(source).toContain("from '../components/explore/ProfileTabBar'")
  })
})

// ─── C. Shared InstaProfileHeader primitive ──────────────────────────────────

describe('CraftsmanProfile owner: header primitive', () => {
  it('imports InstaProfileHeader from src/components/profile', () => {
    expect(source).toContain("from '../components/profile/InstaProfileHeader'")
  })

  it('renders InstaProfileHeader (not an ad-hoc header layout)', () => {
    expect(renderSection).toContain('InstaProfileHeader')
  })

  it('feeds the same stats shape as the customer profile (3 tiles)', () => {
    expect(source).toMatch(/stats:\s*\[/)
    expect(source).toContain("'Portfolio'")
    expect(source).toContain("'Likes'")
    expect(source).toContain('Bew.')
  })

  it('passes business + handle from the profile', () => {
    expect(renderSection).toContain('profile.businessName')
    expect(renderSection).toContain('profile.handle')
  })
})

// ─── D. Portfolio source ─────────────────────────────────────────────────────

describe('CraftsmanProfile owner: portfolio source', () => {
  it('imports fetchOwnerPortfolio', () => {
    expect(source).toContain('fetchOwnerPortfolio')
  })

  it('does NOT import or call fetchPublicPortfolio', () => {
    expect(source).not.toContain('fetchPublicPortfolio')
  })

  it('portfolio load is gated on profile.providerId', () => {
    // The screen guards every portfolio fetch with `profile?.providerId`
    // (or a local capture of it for closure-safety) so the call cannot
    // race the profile load and accidentally fire with `undefined`.
    expect(source).toContain('profile?.providerId')
    expect(source).toMatch(/fetchOwnerPortfolio\(\s*(?:profile\.providerId|providerId)\b/)
  })

  it('count shown in the Reels stat is derived from portfolioItems.length', () => {
    expect(source).toMatch(/portfolioItems\??\.length/)
  })
})

// ─── E. Drafts visible — Entwurf badge in shared grids ───────────────────────

describe('CraftsmanProfile owner: unpublished items visible', () => {
  it('ProfileReelsGrid renders the Entwurf badge for drafts', () => {
    expect(reelsGridSrc).toContain('Entwurf')
    expect(reelsGridSrc).toContain('item.published === false')
  })

  it('ProfilePortfolioGrid renders the Entwurf badge for drafts', () => {
    expect(portfolioGridSrc).toContain('Entwurf')
    expect(portfolioGridSrc).toContain('item.published === false')
  })
})

// ─── F. Add / Edit / Delete flow ─────────────────────────────────────────────

describe('CraftsmanProfile owner: add/edit/delete flows', () => {
  it('AddWorkSampleSheet imported and used', () => {
    expect(source).toContain('AddWorkSampleSheet')
    expect(renderSection).toContain('AddWorkSampleSheet')
  })

  it('JobPickerForPortfolio imported and used', () => {
    expect(source).toContain('JobPickerForPortfolio')
    expect(renderSection).toContain('JobPickerForPortfolio')
  })

  it('PortfolioItemComposer imported and used', () => {
    expect(source).toContain('PortfolioItemComposer')
    expect(renderSection).toContain('PortfolioItemComposer')
  })

  it('ItemActionSheet present for edit/delete context menu', () => {
    expect(source).toContain('ItemActionSheet')
    expect(renderSection).toContain('ItemActionSheet')
  })

  it('deletePortfolioItem imported and called with id + assets (M2: N-asset delete)', () => {
    expect(source).toContain('deletePortfolioItem')
    expect(source).toContain('item.id, item.assets')
  })
})

// ─── G. Composer modes ───────────────────────────────────────────────────────

describe('CraftsmanProfile owner: composer modes', () => {
  it('composer used in create mode', () => {
    expect(renderSection).toContain('mode="create"')
  })

  it('composer used in edit mode', () => {
    expect(renderSection).toContain('mode="edit"')
  })

  it('edit mode gated on editingItem !== null', () => {
    expect(renderSection).toContain('editingItem !== null')
  })
})

// ─── H. Owner overflow → admin gateway ───────────────────────────────────────

describe('CraftsmanProfile owner: overflow admin gateway', () => {
  it('Owner overflow sheet renders Steuern & Bank shortcut', () => {
    expect(source).toContain('/craftsman/profile/tax-bank')
  })

  it('Owner overflow sheet renders Team shortcut', () => {
    expect(source).toContain('/craftsman/team')
  })

  it('Owner overflow sheet exposes a path to the full profile-edit form', () => {
    expect(source).toContain('Profil-Form bearbeiten')
  })
})

// ─── I. Avatar compact variant ───────────────────────────────────────────────

describe('CraftsmanProfile owner: avatar slot', () => {
  it('AvatarUpload uses the compact variant inside the Insta-Header', () => {
    expect(source).toContain('variant="compact"')
  })
})

// ─── J. Render order ─────────────────────────────────────────────────────────

describe('CraftsmanProfile owner: render order', () => {
  it('InstaProfileHeader appears before ProfileTabBar', () => {
    const headerPos = renderSection.indexOf('<InstaProfileHeader')
    const tabBarPos = renderSection.indexOf('<ProfileTabBar')
    expect(headerPos).toBeGreaterThan(-1)
    expect(tabBarPos).toBeGreaterThan(-1)
    expect(headerPos).toBeLessThan(tabBarPos)
  })

  it('tab bar appears before tab content', () => {
    const tabBarPos = renderSection.indexOf('<ProfileTabBar')
    const contentPos = renderSection.indexOf("activeTab === 'portfolio'")
    expect(tabBarPos).toBeGreaterThan(-1)
    expect(contentPos).toBeGreaterThan(-1)
    expect(tabBarPos).toBeLessThan(contentPos)
  })
})
