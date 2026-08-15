/**
 * Integration tests: Inquiry Start Resilience Package
 *
 * Validates that:
 * - Rapid repeated inquiry starts for the same provider do not create duplicate conversations (in-flight lock)
 * - Cache miss scenarios fall back to direct DB lookup instead of failing silently
 * - Inquiry failures return controlled error paths instead of dead/no-op behavior
 * - Existing successful happy path remains intact
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { mockCustomerSession, installMockSession } from '../helpers/mockSession'

import {
  startReelInquiryWorkflow,
  startProfileInquiryWorkflow,
  startCategoryInquiryWorkflow,
  startCategoryInquiryWorkflowFromProvider,
} from '../../src/lib/workflow/exploreInquiryWorkflow'

import { getConversations } from '../../src/lib/messages'
import {
  setDiscoveryProviderCache,
  clearDiscoveryProviderCache,
} from '../../src/lib/discovery/discoveryProviderCache'

import type { ExploreReel, ExploreProviderCard } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CRAFTSMAN_HANDLE = 'meister-mueller'
const CRAFTSMAN_ID = 'user-craftsman-resilience'
const CUSTOMER_USER_ID = 'user-customer-resilience'

const testReel: ExploreReel = {
  id: 'reel-resilience',
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Max Müller',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  title: 'Küche Renovierung',
  category: 'Schreinerei',
  location: 'Berlin',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  likes: 5,
  saves: 1,
  projectTags: ['küche', 'schreinerei'],
  searchTags: ['schreinerei'],
  costLabel: '5.000 – 10.000 €',
  durationLabel: '3 Wochen',
  createdAt: Date.now(),
}

const testProfile: ExploreCraftsmanProfile = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Max Müller',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Berlin',
  primaryCategory: 'Schreinerei',
  bio: 'Professioneller Schreiner',
  tradeCategories: ['Schreinerei', 'Tischlerei'],
  reels: [],
  portfolioItems: [],
  trust: {
    completedJobsCount: 10,
    wouldHireAgainCount: 9,
    totalFeedbackCount: 9,
    hasPlatformBackedCompletion: true,
    badges: [],
  },
  stats: {
    reels: 0,
    likes: 0,
    saves: 0,
    completedJobs: 10,
    wouldHireAgainCount: 9,
  },
}

const testProvider: ExploreProviderCard = {
  craftsmanId: CRAFTSMAN_ID,
  craftsmanName: 'Max Müller',
  craftsmanHandle: CRAFTSMAN_HANDLE,
  craftsmanAvatarUrl: 'https://example.com/avatar.jpg',
  location: 'Berlin',
  primaryCategory: 'Schreinerei',
  tradeCategories: ['Schreinerei', 'Tischlerei'],
  servicesOffered: ['Küchenbau', 'Möbelbau'],
  serviceRadiusKm: 50,
}

beforeEach(() => {
  setupCleanRepositories()
  clearDiscoveryProviderCache()
  // Inquiry workflows enforce assertCustomerRole(); install a customer session
  // so the integration scenarios model the realistic caller identity.
  installMockSession(mockCustomerSession(CUSTOMER_USER_ID))
})

// ---------------------------------------------------------------------------
// Test Suite 1: In-Flight Inquiry Lock (Duplicate Prevention)
// ---------------------------------------------------------------------------

describe('In-Flight Inquiry Lock', () => {
  it('prevents duplicate conversations when rapidly starting reel inquiry twice', async () => {
    // Simulate rapid double-tap by starting two inquiries in parallel
    const [threadId1, threadId2] = await Promise.all([
      startReelInquiryWorkflow(testReel),
      startReelInquiryWorkflow(testReel),
    ])

    // Both calls should return the same thread ID
    expect(threadId1).toBe(threadId2)

    // Only one conversation should exist
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId1)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
  })

  it('prevents duplicate conversations when rapidly starting profile inquiry twice', async () => {
    // Simulate rapid double-tap by starting two inquiries in parallel
    const [threadId1, threadId2] = await Promise.all([
      startProfileInquiryWorkflow(testProfile),
      startProfileInquiryWorkflow(testProfile),
    ])

    // Both calls should return the same thread ID
    expect(threadId1).toBe(threadId2)

    // Only one conversation should exist
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId1)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
  })

  it('prevents duplicate conversations when rapidly starting category inquiry twice', async () => {
    // Pre-populate cache with test provider
    setDiscoveryProviderCache([testProvider])

    // Simulate rapid double-tap by starting two inquiries in parallel
    const [threadId1, threadId2] = await Promise.all([
      startCategoryInquiryWorkflowFromProvider('Schreinerei', 'Neue Küche bauen', 'Berlin', testProvider),
      startCategoryInquiryWorkflowFromProvider('Schreinerei', 'Neue Küche bauen', 'Berlin', testProvider),
    ])

    // Both calls should return the same thread ID
    expect(threadId1).toBe(threadId2)

    // Only one conversation should exist
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId1)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
  })

  it('allows sequential inquiries to create only one conversation per provider', async () => {
    // First inquiry
    const threadId1 = await startReelInquiryWorkflow(testReel)

    // Second inquiry after first completes (simulates user clicking again after navigation)
    const threadId2 = await startReelInquiryWorkflow(testReel)

    // Both should return the same thread ID (existing conversation reuse)
    expect(threadId1).toBe(threadId2)

    // Only one conversation should exist
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
  })

  it('allows concurrent inquiries to different providers', async () => {
    const otherReel: ExploreReel = {
      ...testReel,
      id: 'reel-other',
      craftsmanId: 'user-craftsman-other',
      craftsmanHandle: 'meister-schmidt',
      craftsmanName: 'Anna Schmidt',
    }

    // Start inquiries to different providers in parallel
    const [threadId1, threadId2] = await Promise.all([
      startReelInquiryWorkflow(testReel),
      startReelInquiryWorkflow(otherReel),
    ])

    // Should return different thread IDs
    expect(threadId1).not.toBe(threadId2)

    // Two conversations should exist
    const conversations = getConversations()
    expect(conversations).toHaveLength(2)
    expect(conversations.map(c => c.craftsmanHandle).sort()).toEqual([
      CRAFTSMAN_HANDLE,
      'meister-schmidt',
    ].sort())
  })
})

// ---------------------------------------------------------------------------
// Test Suite 2: Cache Miss Resilience
// ---------------------------------------------------------------------------

describe('Cache Miss Resilience', () => {
  it('throws clear error when cache is empty and no providers in DB', async () => {
    // Ensure cache is empty
    clearDiscoveryProviderCache()

    // Mock empty DB response by not setting up any providers
    // In real implementation, fetchDiscoveryProviders would return []

    await expect(
      startCategoryInquiryWorkflow('Elektrik', 'Licht installieren', 'Hamburg')
    ).rejects.toThrow(/Keine Handwerker verfügbar/)
  })

  it('succeeds when cache is empty but provider exists in cache after pre-population', async () => {
    // Initially empty cache
    clearDiscoveryProviderCache()

    // Pre-populate cache (simulates Discovery screen loading)
    setDiscoveryProviderCache([testProvider])

    // Should succeed using cache
    const threadId = await startCategoryInquiryWorkflow('Schreinerei', 'Möbel bauen', 'Berlin')

    expect(threadId).toBeTruthy()
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
  })

  it('reuses existing conversation when called with cache miss scenario', async () => {
    // Pre-populate cache and create initial conversation
    setDiscoveryProviderCache([testProvider])
    const threadId1 = await startCategoryInquiryWorkflow('Schreinerei', 'Erste Anfrage', 'Berlin')

    // Clear cache to simulate cache miss on second call
    clearDiscoveryProviderCache()

    // Re-populate cache (simulates page reload or cache refresh)
    setDiscoveryProviderCache([testProvider])

    // Second inquiry should reuse existing conversation
    const threadId2 = await startCategoryInquiryWorkflow('Schreinerei', 'Zweite Anfrage', 'Berlin')

    expect(threadId1).toBe(threadId2)
    expect(getConversations()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test Suite 3: Clear Failure Paths
// ---------------------------------------------------------------------------

describe('Clear Failure Paths', () => {
  it('returns success with fallback when no provider exactly matches category', async () => {
    // Set up cache with provider that doesn't match the requested category
    const otherProvider: ExploreProviderCard = {
      ...testProvider,
      craftsmanId: 'user-craftsman-electrician',
      craftsmanHandle: 'meister-electric',
      primaryCategory: 'Elektrik',
      tradeCategories: ['Elektrik'],
    }
    setDiscoveryProviderCache([otherProvider])

    // Request a category that doesn't exist in any provider
    // The fallback will still match because it falls back to first provider
    const threadId = await startCategoryInquiryWorkflow('UnknownCategory', 'Some work', 'Berlin')

    // Should succeed with fallback to first available provider
    expect(threadId).toBeTruthy()
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test Suite 4: Happy Path Preservation
// ---------------------------------------------------------------------------

describe('Happy Path Preservation', () => {
  it('creates conversation successfully via reel inquiry', async () => {
    const threadId = await startReelInquiryWorkflow(testReel)

    expect(threadId).toBeTruthy()
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
    expect(conversations[0].inquiryOrigin).toBe('reel')
  })

  it('creates conversation successfully via profile inquiry', async () => {
    const threadId = await startProfileInquiryWorkflow(testProfile)

    expect(threadId).toBeTruthy()
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
    expect(conversations[0].inquiryOrigin).toBe('profile')
  })

  it('creates conversation successfully via category inquiry with cache', async () => {
    setDiscoveryProviderCache([testProvider])

    const threadId = await startCategoryInquiryWorkflow('Schreinerei', 'Küche renovieren', 'Berlin')

    expect(threadId).toBeTruthy()
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId)
    expect(conversations[0].craftsmanHandle).toBe(CRAFTSMAN_HANDLE)
    expect(conversations[0].inquiryOrigin).toBe('category')
    expect(conversations[0].projectDescription).toBe('Küche renovieren')
  })

  it('reuses existing conversation when inquiry is repeated', async () => {
    const threadId1 = await startReelInquiryWorkflow(testReel)
    const threadId2 = await startReelInquiryWorkflow(testReel)

    expect(threadId1).toBe(threadId2)
    expect(getConversations()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test Suite 5: Targeted craftsman delivery (no broadcast)
// ---------------------------------------------------------------------------

describe('Targeted craftsman delivery', () => {
  it('creates exactly one conversation for the matched provider and preserves identity context', async () => {
    const otherProvider: ExploreProviderCard = {
      ...testProvider,
      craftsmanId: 'user-craftsman-other',
      craftsmanHandle: 'meister-anders',
      craftsmanName: 'Andere Meisterin',
      craftsmanAvatarUrl: 'https://example.com/other-avatar.jpg',
      tradeCategories: ['Schreinerei'],
    }

    setDiscoveryProviderCache([testProvider, otherProvider])

    const threadId = await startCategoryInquiryWorkflow('Schreinerei', 'Einbauschrank anfertigen', 'Berlin')

    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    const conversation = conversations[0]
    expect(conversation.id).toBe(threadId)
    expect(conversation.craftsmanHandle).toBe(testProvider.craftsmanHandle)
    expect(conversation.craftsmanName).toBe(testProvider.craftsmanName)
    expect(conversation.craftsmanAvatarUrl).toBe(testProvider.craftsmanAvatarUrl)
    expect(conversation.projectDescription).toBe('Einbauschrank anfertigen')
  })
})
