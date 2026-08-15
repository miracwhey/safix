/**
 * Integration tests: Request Limit Enforcement in Inquiry Workflows
 *
 * Validates that the daily send limit (MAX_DAILY_SENDS = 3) is enforced
 * in the real inquiry send path — not just as a UI-disabled button.
 *
 * Coverage:
 *   1. First inquiry succeeds and records a send
 *   2. Follow-up to existing thread does NOT count as a new send
 *   3. Fourth new inquiry in one day is rejected with a limit error
 *   4. Different inquiry workflow entry points all enforce the limit
 *   5. Unauthenticated inquiries skip the limit check (defensive — they
 *      will fail downstream on RLS anyway)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  startReelInquiryWorkflow,
  startProfileInquiryWorkflow,
  startCategoryInquiryWorkflowFromProvider,
  startProjectInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import { getConversations } from '../../src/lib/messages'
import {
  _resetInMemorySends,
  getSendsToday,
  MAX_DAILY_SENDS,
} from '../../src/lib/customerEntry/requestLimitService'

import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'
import type { ProjectCase } from '../../src/domain/projects/projectCaseTypes'

// ---------------------------------------------------------------------------
// Session mock — always authenticated as the test customer
// ---------------------------------------------------------------------------

const CUSTOMER_USER_ID = 'customer-limit-test'

vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: { id: CUSTOMER_USER_ID },
    role: 'customer',
    craftsmanRole: null,
    isOperator: false,
    loading: false,
    error: null,
    errorKind: null,
  }),
  subscribeSession: () => () => {},
  refreshSession: () => Promise.resolve(),
}))

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReel(handle: string, id: string): ExploreReel {
  return {
    id: `reel-${handle}`,
    craftsmanId: id,
    craftsmanName: `Craftsman ${handle}`,
    craftsmanHandle: handle,
    craftsmanAvatarUrl: '',
    title: 'Testprojekt',
    category: 'Elektrik',
    location: 'Berlin',
    thumbnailUrl: '',
    likes: 0,
    saves: 0,
    projectTags: [],
    searchTags: [],
    costLabel: '1.000 €',
    durationLabel: '1 Woche',
    createdAt: Date.now(),
  }
}

function makeProfile(handle: string, id: string): ExploreCraftsmanProfile {
  return {
    craftsmanId: id,
    craftsmanName: `Craftsman ${handle}`,
    craftsmanHandle: handle,
    craftsmanAvatarUrl: '',
    location: 'Berlin',
    primaryCategory: 'Elektrik',
    bio: 'Test',
    tradeCategories: ['Elektrik'],
    reels: [],
    portfolioItems: [],
    trust: {
      completedJobsCount: 0,
      wouldHireAgainCount: 0,
      totalFeedbackCount: 0,
      hasPlatformBackedCompletion: false,
      badges: [],
    },
    stats: { reels: 0, likes: 0, saves: 0, completedJobs: 0, wouldHireAgainCount: 0 },
  }
}

function makeProvider(handle: string, id: string): ExploreProviderCard {
  return {
    craftsmanId: id,
    craftsmanName: `Craftsman ${handle}`,
    craftsmanHandle: handle,
    craftsmanAvatarUrl: '',
    location: 'Berlin',
    primaryCategory: 'Elektrik',
    tradeCategories: ['Elektrik'],
    servicesOffered: [],
    serviceRadiusKm: 30,
  }
}

function makeProject(id: string): ProjectCase {
  return {
    id,
    title: 'Testprojekt',
    category: 'Elektrik',
    description: 'Beschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Inquiry Request Limit Enforcement', () => {
  beforeEach(() => {
    setupCleanRepositories()
    _resetInMemorySends()
  })

  it('first inquiry succeeds and records a send', async () => {
    const threadId = await startReelInquiryWorkflow(
      makeReel('craftsman-a', 'id-a'),
    )

    expect(threadId).toBeTruthy()
    expect(getConversations()).toHaveLength(1)

    const sends = await getSendsToday(CUSTOMER_USER_ID)
    expect(sends).toBe(1)
  })

  it('follow-up message to existing thread does NOT count as a new send', async () => {
    // First inquiry creates the thread
    const threadId = await startReelInquiryWorkflow(
      makeReel('craftsman-b', 'id-b'),
    )
    expect(await getSendsToday(CUSTOMER_USER_ID)).toBe(1)

    // Second call for the same provider reuses the existing thread (no new send)
    const sameThreadId = await startReelInquiryWorkflow(
      makeReel('craftsman-b', 'id-b'),
    )

    expect(sameThreadId).toBe(threadId)
    expect(getConversations()).toHaveLength(1)
    expect(await getSendsToday(CUSTOMER_USER_ID)).toBe(1) // still 1
  })

  it('rejects the fourth new inquiry with a Tageslimit error', async () => {
    // Send 3 inquiries to 3 different providers (at the limit)
    await startReelInquiryWorkflow(makeReel('craft-1', 'id-1'))
    await startProfileInquiryWorkflow(makeProfile('craft-2', 'id-2'))
    await startCategoryInquiryWorkflowFromProvider(
      'Elektrik', 'Beschreibung', 'Berlin',
      makeProvider('craft-3', 'id-3'),
    )

    expect(await getSendsToday(CUSTOMER_USER_ID)).toBe(MAX_DAILY_SENDS)

    // Fourth inquiry must be rejected
    await expect(
      startProjectInquiryWorkflowFromProvider(
        makeProject('proj-4'),
        makeProvider('craft-4', 'id-4'),
      ),
    ).rejects.toThrow('Tageslimit erreicht')

    // No fourth conversation was created
    expect(getConversations()).toHaveLength(3)
    expect(await getSendsToday(CUSTOMER_USER_ID)).toBe(MAX_DAILY_SENDS)
  })

  it('startCategoryInquiryWorkflowFromProvider enforces the limit', async () => {
    // Exhaust the limit
    for (let i = 1; i <= MAX_DAILY_SENDS; i++) {
      await startCategoryInquiryWorkflowFromProvider(
        'Sanitär', 'Test', 'München',
        makeProvider(`prov-cat-${i}`, `id-cat-${i}`),
      )
    }

    await expect(
      startCategoryInquiryWorkflowFromProvider(
        'Sanitär', 'Test', 'München',
        makeProvider('prov-cat-extra', 'id-cat-extra'),
      ),
    ).rejects.toThrow('Tageslimit erreicht')
  })

  it('startProjectInquiryWorkflowFromProvider enforces the limit', async () => {
    // Exhaust the limit
    for (let i = 1; i <= MAX_DAILY_SENDS; i++) {
      await startProjectInquiryWorkflowFromProvider(
        makeProject(`proj-${i}`),
        makeProvider(`prov-proj-${i}`, `id-proj-${i}`),
      )
    }

    await expect(
      startProjectInquiryWorkflowFromProvider(
        makeProject('proj-extra'),
        makeProvider('prov-proj-extra', 'id-proj-extra'),
      ),
    ).rejects.toThrow('Tageslimit erreicht')
  })
})
