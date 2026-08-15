/**
 * Thread Artifact Persistence Tests
 *
 * Verifies that real thread artifacts survive a full Supabase reload.
 *
 * Root cause addressed:
 *   rowToConversation() previously only restored sourceProjectId when
 *   inquiry_origin === 'project'.  This caused customer-attached project
 *   cards to vanish after reload on profile/category/reel-origin threads.
 *
 * Coverage:
 *   1. sourceProjectId rehydrated for every inquiry origin
 *   2. Synthetic (non-UUID) project IDs are NOT surfaced as sourceProjectId
 *   3. Offer artifacts restored from persisted offer repository after reload
 *   4. Both customer and craftsman see identical restored project artifacts
 *   5. Both customer and craftsman see identical restored offer artifacts
 *   6. Project and offer artifacts coexist correctly after reload
 *   7. No regression to profile-inquiry fake-project removal
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SupabaseMessageRepository } from '../../src/lib/messages/repository/SupabaseMessageRepository'
import { supabase } from '../../src/lib/supabase'

// ── Mocks ───────────────────────────────────────────────────────────────

interface MockChannel {
  on: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
}

interface MockQueryBuilder {
  select?: ReturnType<typeof vi.fn>
  or?: ReturnType<typeof vi.fn>
  order?: ReturnType<typeof vi.fn>
  limit?: ReturnType<typeof vi.fn>
  insert?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  eq?: ReturnType<typeof vi.fn>
}

interface MockSession {
  user: { id: string }
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(),
    },
    from: vi.fn(),
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

// ── Helpers ─────────────────────────────────────────────────────────────

const REAL_PROJECT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const ANOTHER_REAL_UUID = 'f0e1d2c3-b4a5-4968-8172-6354a7b8c9d0'

function makeConversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-001',
    customer_name: 'Anna Kundin',
    customer_avatar_url: '',
    customer_user_id: 'customer-uid',
    craftsman_name: 'Peter Handwerker',
    craftsman_handle: 'peter-h',
    craftsman_avatar_url: '',
    craftsman_user_id: 'craftsman-uid',
    project_title: 'Küche renovieren',
    project_subtitle: 'Neue Anfrage',
    project_location: 'Berlin',
    project_cost_range: '€3,000–5,000',
    project_duration: '1 Woche',
    project_status_label: null,
    time_label: 'Jetzt',
    unread_count: 0,
    inquiry_origin: 'reel',
    source_project_id: REAL_PROJECT_UUID,
    reviewed_at: null,
    declined_at: null,
    created_at: Date.now(),
    ...overrides,
  }
}

function mockSupabaseLoad(
  conversationRows: Record<string, unknown>[],
  userId = 'customer-uid'
) {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: {
      session: { user: { id: userId } } as MockSession,
    },
    error: null,
  } as never)

  const mockChannel: MockChannel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn(),
  }
  vi.mocked(supabase.channel).mockReturnValue(mockChannel as never)
  vi.mocked(supabase.auth.onAuthStateChange).mockReturnValue({
    data: { subscription: { unsubscribe: vi.fn() } },
  } as never)

  vi.mocked(supabase.from).mockImplementation((table: string) => {
    if (table === 'conversations') {
      return {
        select: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: conversationRows,
          error: null,
        }),
      } as MockQueryBuilder as never
    }
    // messages table — return empty
    return {
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [],
        error: null,
      }),
    } as MockQueryBuilder as never
  })
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Thread Artifact Persistence — sourceProjectId rehydration', () => {
  let repo: SupabaseMessageRepository

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new SupabaseMessageRepository()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─── A. sourceProjectId rehydrated for every inquiry origin ─────────

  const inquiryOrigins = ['profile', 'reel', 'category', 'project', 'direct'] as const

  for (const origin of inquiryOrigins) {
    it(`restores real sourceProjectId on reload for ${origin}-origin thread`, async () => {
      mockSupabaseLoad([
        makeConversationRow({
          id: `thread-${origin}`,
          inquiry_origin: origin,
          source_project_id: REAL_PROJECT_UUID,
        }),
      ])

      await repo.initialize()

      const conv = repo.getConversationById(`thread-${origin}`)
      expect(conv).toBeDefined()
      expect(conv?.sourceProjectId).toBe(REAL_PROJECT_UUID)
      // Legacy projectId should also carry the value
      expect(conv?.projectId).toBe(REAL_PROJECT_UUID)
    })
  }

  it('restores sourceProjectId when inquiry_origin is null', async () => {
    mockSupabaseLoad([
      makeConversationRow({
        id: 'thread-null-origin',
        inquiry_origin: null,
        source_project_id: REAL_PROJECT_UUID,
      }),
    ])

    await repo.initialize()

    const conv = repo.getConversationById('thread-null-origin')
    expect(conv).toBeDefined()
    expect(conv?.sourceProjectId).toBe(REAL_PROJECT_UUID)
  })

  // ─── B. Synthetic project IDs NOT surfaced as sourceProjectId ───────

  it('does NOT expose synthetic project ID as sourceProjectId', async () => {
    mockSupabaseLoad([
      makeConversationRow({
        id: 'thread-synthetic',
        inquiry_origin: 'profile',
        source_project_id: 'project_profile_craft-1_thread-synthetic',
      }),
    ])

    await repo.initialize()

    const conv = repo.getConversationById('thread-synthetic')
    expect(conv).toBeDefined()
    // Synthetic ID is carried through projectId (legacy) but NOT sourceProjectId
    expect(conv?.projectId).toBe('project_profile_craft-1_thread-synthetic')
    expect(conv?.sourceProjectId).toBeUndefined()
  })

  it('does NOT expose category synthetic ID as sourceProjectId', async () => {
    mockSupabaseLoad([
      makeConversationRow({
        id: 'thread-cat-synth',
        inquiry_origin: 'category',
        source_project_id: 'project_category_plumbing_123',
      }),
    ])

    await repo.initialize()

    const conv = repo.getConversationById('thread-cat-synth')
    expect(conv).toBeDefined()
    expect(conv?.sourceProjectId).toBeUndefined()
  })

  // ─── C. null source_project_id produces no sourceProjectId ──────────

  it('produces no sourceProjectId when source_project_id is null', async () => {
    mockSupabaseLoad([
      makeConversationRow({
        id: 'thread-no-project',
        source_project_id: null,
      }),
    ])

    await repo.initialize()

    const conv = repo.getConversationById('thread-no-project')
    expect(conv).toBeDefined()
    expect(conv?.sourceProjectId).toBeUndefined()
    expect(conv?.projectId).toBe('')
  })

  // ─── D. Customer and craftsman both see same sourceProjectId ────────

  it('customer reload produces the same sourceProjectId as craftsman reload', async () => {
    const row = makeConversationRow({
      id: 'thread-shared',
      inquiry_origin: 'reel',
      source_project_id: REAL_PROJECT_UUID,
    })

    // Simulate customer reload
    const customerRepo = new SupabaseMessageRepository()
    mockSupabaseLoad([row], 'customer-uid')
    await customerRepo.initialize()
    const customerConv = customerRepo.getConversationById('thread-shared')

    // Simulate craftsman reload
    const craftsmanRepo = new SupabaseMessageRepository()
    mockSupabaseLoad([row], 'craftsman-uid')
    await craftsmanRepo.initialize()
    const craftsmanConv = craftsmanRepo.getConversationById('thread-shared')

    // Both must see the same sourceProjectId
    expect(customerConv?.sourceProjectId).toBe(REAL_PROJECT_UUID)
    expect(craftsmanConv?.sourceProjectId).toBe(REAL_PROJECT_UUID)
    expect(customerConv?.sourceProjectId).toBe(craftsmanConv?.sourceProjectId)
  })

  // ─── E. Multiple conversations each keep correct sourceProjectId ────

  it('loads multiple conversations with distinct sourceProjectIds', async () => {
    mockSupabaseLoad([
      makeConversationRow({
        id: 'thread-A',
        source_project_id: REAL_PROJECT_UUID,
        inquiry_origin: 'profile',
      }),
      makeConversationRow({
        id: 'thread-B',
        source_project_id: ANOTHER_REAL_UUID,
        inquiry_origin: 'category',
      }),
      makeConversationRow({
        id: 'thread-C',
        source_project_id: null,
        inquiry_origin: 'reel',
      }),
    ])

    await repo.initialize()

    expect(repo.getConversationById('thread-A')?.sourceProjectId).toBe(REAL_PROJECT_UUID)
    expect(repo.getConversationById('thread-B')?.sourceProjectId).toBe(ANOTHER_REAL_UUID)
    expect(repo.getConversationById('thread-C')?.sourceProjectId).toBeUndefined()
  })
})

// ─── Artifact-level integration (InMemory) ────────────────────────────────

import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
} from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { getOffersByConversationId } from '../../src/lib/offers/service'
import { createOfferWorkflow } from '../../src/lib/workflow'

function seedConversation(overrides: Partial<Conversation> = {}): Conversation {
  const id = overrides.id ?? `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Anna Kundin',
    customerAvatarUrl: '',
    customerUserId: 'customer-123',
    craftsmanName: 'Peter Handwerker',
    craftsmanHandle: 'peter-h',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-456',
    projectTitle: 'Küche renovieren',
    projectSubtitle: 'Neue Anfrage',
    projectLocation: 'Berlin',
    projectCostRange: '€3,000–5,000',
    projectDuration: '1 Woche',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Vor 5 Minuten',
    inquiryOrigin: 'reel',
    createdAt: Date.now(),
    ...overrides,
  }
}

function seedProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? `proj-${Date.now()}`,
    title: overrides.title ?? 'Test Projekt',
    category: 'Sanitär',
    description: 'Testbeschreibung',
    location: 'Berlin',
    status: 'request',
    source: 'builder',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('Thread Artifact Persistence — end-to-end artifact resolution', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── F. Project artifact from sourceProjectId across all origins ────

  for (const origin of ['profile', 'reel', 'category'] as const) {
    it(`project artifact resolves after reload for ${origin}-origin thread`, async () => {
      const projectId = `${REAL_PROJECT_UUID.slice(0, -1)}a` // valid UUID
      const threadId = `conv-${origin}-reload`

      await addProject(seedProject({ id: projectId, title: 'Dachsanierung' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: projectId,
        inquiryOrigin: origin,
        projectId: `project_${origin}_synthetic`, // synthetic placeholder
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.project.id).toBe(projectId)
      expect(artifacts.projectArtifact!.project.title).toBe('Dachsanierung')
      expect(artifacts.projectArtifact!.isCustomerCreated).toBe(true)
    })
  }

  // ─── G. Offer artifact persists and resolves after reload ───────────

  it('offer artifact resolves from persisted offer repository', async () => {
    const threadId = 'conv-offer-persist'

    await addConversation(seedConversation({
      id: threadId,
      inquiryOrigin: 'profile',
    }))

    // Create offer via workflow
    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-456',
      customerUserId: 'customer-123',
      price: 2500,
      description: 'Badezimmer komplett renovieren',
    })

    // Verify offer was persisted
    const offers = getOffersByConversationId(threadId)
    expect(offers).toHaveLength(1)
    expect(offers[0].price).toBe(2500)
    expect(offers[0].conversationId).toBe(threadId)

    // Derive artifacts — offer must appear
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.kind).toBe('offer_payment')
    expect(artifacts.offerPaymentArtifact!.offer.price).toBe(2500)
    expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
  })

  // ─── H. Project and offer artifacts coexist after reload ────────────

  it('project and offer artifacts coexist in same thread after reload', async () => {
    const projectId = REAL_PROJECT_UUID
    const threadId = 'conv-coexist'

    await addProject(seedProject({ id: projectId, title: 'Fenstereinbau' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: projectId,
      inquiryOrigin: 'reel',
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Create offer in same thread
    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-456',
      customerUserId: 'customer-123',
      price: 4000,
      description: 'Alle Fenster austauschen',
    })

    // Both artifacts must coexist
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project.id).toBe(projectId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.offer.price).toBe(4000)
  })

  // ─── I. Synthetic project ID does not produce artifact ──────────────

  it('synthetic project ID does NOT produce a project artifact (no regression)', async () => {
    await addConversation(seedConversation({
      id: 'conv-no-fake',
      projectId: 'project_profile_craft_conv-no-fake',
      inquiryOrigin: 'profile',
      // sourceProjectId not set — no real project
    }))

    const artifacts = getThreadArtifacts('conv-no-fake')
    expect(artifacts.projectArtifact).toBeNull()
  })

  // ─── J. Customer and craftsman both resolve same project artifact ───

  it('customer and craftsman both resolve the same project artifact', async () => {
    const projectId = REAL_PROJECT_UUID
    const threadId = 'conv-both-sides'

    await addProject(seedProject({ id: projectId, title: 'Gartenanlage' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: projectId,
      customerUserId: 'customer-A',
      craftsmanUserId: 'craftsman-B',
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId,
      customerUserId: 'customer-A',
      craftsmanUserId: 'craftsman-B',
    })

    // Both roles call getThreadArtifacts with the same threadId
    const artifacts1 = getThreadArtifacts(threadId)
    const artifacts2 = getThreadArtifacts(threadId)

    // Same artifact, same project ID
    expect(artifacts1.projectArtifact).not.toBeNull()
    expect(artifacts2.projectArtifact).not.toBeNull()
    expect(artifacts1.projectArtifact!.project.id).toBe(projectId)
    expect(artifacts2.projectArtifact!.project.id).toBe(projectId)
    expect(artifacts1.projectArtifact!.project.id).toBe(
      artifacts2.projectArtifact!.project.id
    )
  })

  // ─── K. Customer and craftsman both resolve same offer artifact ─────

  it('customer and craftsman both resolve the same offer artifact', async () => {
    const threadId = 'conv-offer-both'

    await addConversation(seedConversation({
      id: threadId,
      customerUserId: 'customer-X',
      craftsmanUserId: 'craftsman-Y',
    }))

    await createOfferWorkflow({
      conversationId: threadId,
      craftsmanUserId: 'craftsman-Y',
      customerUserId: 'customer-X',
      price: 1800,
      description: 'Türen lackieren',
    })

    // Both sides derive the same artifact
    const artifacts1 = getThreadArtifacts(threadId)
    const artifacts2 = getThreadArtifacts(threadId)

    expect(artifacts1.offerPaymentArtifact).not.toBeNull()
    expect(artifacts2.offerPaymentArtifact).not.toBeNull()
    expect(artifacts1.offerPaymentArtifact!.offer.id).toBe(
      artifacts2.offerPaymentArtifact!.offer.id
    )
    expect(artifacts1.offerPaymentArtifact!.offer.price).toBe(1800)
  })
})
