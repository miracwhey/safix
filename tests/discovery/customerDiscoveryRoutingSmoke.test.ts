/**
 * Customer Discovery Routing Smoke — Block 3.5
 *
 * Locks in the route surface the Block-1+2 redesign relies on:
 *   - /explore/craftsman/:craftsmanId  → ExploreCraftsmanProfileScreen
 *   - /search                          → CustomerSearchScreen (Default-Browse)
 *   - /messages/:threadId              → MessageThreadScreen (post-inquiry)
 *
 * Plus screen-internal entry/exit edges:
 *   - CustomerHomeScreen has a navigation to `/search`
 *   - ExploreCraftsmanProfileScreen navigates to `/messages/{threadId}`
 *     after a successful Anfrage-Workflow
 *   - ExploreReelCard / ProviderResultCard route via
 *     `navigate('/explore/craftsman/${id}')`
 *
 * Source-level greps — no React renderer needed. Fast, robust against
 * lazy-loading wrappers, and catches the most common refactor regression
 * (e.g. someone renaming `/search` to `/customer/search`).
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')

function read(rel: string): string {
  return fs.readFileSync(path.resolve(repoRoot, rel), 'utf-8')
}

const appSource = read('src/App.tsx')
const homeSource = read('src/screens/CustomerHomeScreen.tsx')
const profileScreenSource = read('src/screens/ExploreCraftsmanProfileScreen.tsx')
const profileHeaderSource = read('src/components/explore/ExploreProfileHeaderCard.tsx')
const reelCardSource = read('src/components/explore/ExploreReelCard.tsx')
const searchOverlaySource = read('src/components/explore/ExploreSearchOverlay.tsx')

describe('App routes — Discovery surface', () => {
  it('registers the Explore-Profile route with the craftsmanId param', () => {
    expect(appSource).toMatch(/path="\/explore\/craftsman\/:craftsmanId"/)
  })

  it('wires the route to ExploreCraftsmanProfileScreen', () => {
    expect(appSource).toContain('ExploreCraftsmanProfileScreen')
    expect(appSource).toMatch(
      /path="\/explore\/craftsman\/:craftsmanId"[\s\S]*?ExploreCraftsmanProfileScreen/,
    )
  })

  it('registers the Customer Search route', () => {
    expect(appSource).toMatch(/path="\/search"/)
    expect(appSource).toContain('CustomerSearchScreen')
  })

  it('registers the Message Thread route used by the inquiry handoff', () => {
    expect(appSource).toMatch(/path="\/messages\/:threadId"/)
    expect(appSource).toContain('MessageThreadScreen')
  })
})

describe('CustomerHome → Search entry point', () => {
  it('routes to /search from the Discovery entry CTAs', () => {
    expect(homeSource).toMatch(/(navigate\('\/search'|to="\/search")/)
  })
})

describe('Profile entry — reel + search → /explore/craftsman/{id}', () => {
  it('ExploreReelCard navigates to /explore/craftsman/{craftsmanId}', () => {
    expect(reelCardSource).toMatch(/navigate\(`\/explore\/craftsman\/\$\{[^}]+\}`\)/)
  })

  it('ExploreSearchOverlay routes to /explore/craftsman/{craftsmanId}', () => {
    expect(searchOverlaySource).toMatch(
      /navigate\(`\/explore\/craftsman\/\$\{[^}]+\}`/,
    )
  })
})

describe('Profile → Inquiry handoff', () => {
  it('header card navigates to /messages/{threadId} after startProfileInquiryWorkflow', () => {
    expect(profileHeaderSource).toContain('startProfileInquiryWorkflow')
    expect(profileHeaderSource).toMatch(/navigate\(`\/messages\/\$\{threadId\}`\)/)
  })

  it('sticky CTA also routes to /messages/{threadId}', () => {
    expect(profileScreenSource).toContain('startProfileInquiryWorkflow')
    expect(profileScreenSource).toMatch(/navigate\(`\/messages\/\$\{threadId\}`\)/)
  })
})

describe('Profile screen — initial tab + default state', () => {
  it('default active tab is portfolio', () => {
    expect(profileScreenSource).toMatch(/useState<ProfileTabKey>\('portfolio'\)/)
  })

  it('portfolio filter starts as null (no chip preselected)', () => {
    expect(profileScreenSource).toMatch(/useState<string \| null>\(null\)/)
  })
})
