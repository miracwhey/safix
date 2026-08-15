/**
 * Thread Artifact Final Stability Tests
 *
 * Validates that thread business cards remain stable under all failure
 * scenarios identified in the stability sweep:
 *
 * 1. Project card renders when artifact row exists even if project repo
 *    hydrates later (secondary entity dependency decoupling)
 * 2. Screen updates when thread_artifacts repo changes
 * 3. Screen updates when referenced entity repo changes
 * 4. Canonical artifact is not hidden by old render guards
 * 5. Re-enter/reload does not hide project card
 * 6. Offer/payment artifacts follow the same stability rules
 * 7. No regression to participant scoping
 * 8. Pending artifact state is correctly signalled
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  addConversation,
  getThreadArtifacts,
  persistProjectArtifact,
  persistOfferArtifact,
  subscribeThreadArtifacts,
} from '../../src/lib/messages'
import { InMemoryThreadArtifactRepository } from '../../src/lib/messages/repository/InMemoryThreadArtifactRepository'
import { setThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import type { Conversation } from '../../src/lib/messages/types'
import type { ThreadArtifactRecord } from '../../src/lib/messages/threadArtifactRecord'
import { addProject } from '../../src/lib/projects'
import type { Project } from '../../src/lib/projects'
import { addOffer } from '../../src/lib/offers'
import type { Offer } from '../../src/lib/offers/types'
import { getSession } from '../../src/lib/session'

// ── Helpers ─────────────────────────────────────────────────────────────

const PROJECT_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'
const OFFER_UUID = 'offer-stability-001'

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

function seedOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: overrides.id ?? `offer-${Date.now()}`,
    conversationId: overrides.conversationId ?? 'conv-test',
    customerUserId: overrides.customerUserId ?? 'customer-123',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craftsman-456',
    price: '1.500 €',
    description: 'Testangebot',
    sentAt: Date.now(),
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeArtifactRecord(
  overrides: Partial<ThreadArtifactRecord> & { conversationId: string; artifactType: 'project' | 'offer' | 'payment_phase' }
): ThreadArtifactRecord {
  const now = Date.now()
  return {
    id: `art-${overrides.conversationId}-${overrides.artifactType}`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Thread Artifact Stability — secondary entity hydration', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ─── SCENARIO 2: Artifact row exists before secondary repo fully hydrates ──

  it('returns pendingProjectArtifact=true when artifact record exists but project has not loaded', async () => {
    const threadId = 'conv-pending-project'

    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
    }))

    // Persist the artifact record (referencing a project that hasn't been added to the project repo)
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Do NOT add project to project repo — simulating late hydration
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).toBeNull()
    expect(artifacts.pendingProjectArtifact).toBe(true)
  })

  it('resolves project artifact once project repo hydrates', async () => {
    const threadId = 'conv-late-hydrate'

    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Before project loads
    const before = getThreadArtifacts(threadId)
    expect(before.projectArtifact).toBeNull()
    expect(before.pendingProjectArtifact).toBe(true)

    // Simulate project repo hydration
    await addProject(seedProject({ id: PROJECT_UUID, title: 'Terrassenbau' }))

    // After project loads
    const after = getThreadArtifacts(threadId)
    expect(after.projectArtifact).not.toBeNull()
    expect(after.projectArtifact!.project.id).toBe(PROJECT_UUID)
    expect(after.projectArtifact!.project.title).toBe('Terrassenbau')
    expect(after.projectArtifact!.persistenceStatus).toBe('confirmed')
    expect(after.pendingProjectArtifact).toBe(false)
  })

  it('returns pendingOfferArtifact=true when offer artifact record exists but offer has not loaded', async () => {
    const threadId = 'conv-pending-offer'

    await addConversation(seedConversation({
      id: threadId,
    }))

    // Persist the offer artifact record (referencing an offer not yet in the offer repo)
    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'sent',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Do NOT add offer to offer repo — simulating late hydration
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).toBeNull()
    expect(artifacts.pendingOfferArtifact).toBe(true)
  })

  it('resolves offer artifact once offer repo hydrates', async () => {
    const threadId = 'conv-offer-late-hydrate'

    await addConversation(seedConversation({
      id: threadId,
    }))

    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'sent',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Before offer loads
    const before = getThreadArtifacts(threadId)
    expect(before.offerPaymentArtifact).toBeNull()
    expect(before.pendingOfferArtifact).toBe(true)

    // Simulate offer repo hydration
    await addOffer(seedOffer({
      id: OFFER_UUID,
      conversationId: threadId,
    }))

    // After offer loads
    const after = getThreadArtifacts(threadId)
    expect(after.offerPaymentArtifact).not.toBeNull()
    expect(after.offerPaymentArtifact!.offer.id).toBe(OFFER_UUID)
    expect(after.offerPaymentArtifact!.phase).toBe('sent')
    expect(after.pendingOfferArtifact).toBe(false)
  })
})

describe('Thread Artifact Stability — subscription reactivity', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('subscription fires when artifact is upserted, allowing UI to re-resolve', async () => {
    const repo = new InMemoryThreadArtifactRepository()
    setThreadArtifactRepository(repo)

    const threadId = 'conv-sub-reactivity'
    await addConversation(seedConversation({ id: threadId }))
    await addProject(seedProject({ id: PROJECT_UUID, title: 'Garagenanbau' }))

    let refreshCount = 0
    const unsub = subscribeThreadArtifacts(() => {
      refreshCount++
    })

    // Before: no artifact
    expect(getThreadArtifacts(threadId).projectArtifact).toBeNull()
    expect(getThreadArtifacts(threadId).pendingProjectArtifact).toBe(false)

    // Upsert fires the subscriber
    await repo.upsert(makeArtifactRecord({
      conversationId: threadId,
      artifactType: 'project',
      projectId: PROJECT_UUID,
    }))

    expect(refreshCount).toBeGreaterThanOrEqual(1)

    // After re-resolve: artifact available
    const after = getThreadArtifacts(threadId)
    expect(after.projectArtifact).not.toBeNull()
    expect(after.projectArtifact!.project.id).toBe(PROJECT_UUID)
    expect(after.pendingProjectArtifact).toBe(false)

    unsub()
  })

  it('multiple subscriptions all fire correctly', async () => {
    const repo = new InMemoryThreadArtifactRepository()
    setThreadArtifactRepository(repo)

    let count1 = 0
    let count2 = 0
    const unsub1 = repo.subscribe(() => { count1++ })
    const unsub2 = repo.subscribe(() => { count2++ })

    await repo.upsert(makeArtifactRecord({
      conversationId: 'conv-multi-sub',
      artifactType: 'project',
      projectId: PROJECT_UUID,
    }))

    expect(count1).toBe(1)
    expect(count2).toBe(1)

    unsub1()
    unsub2()
  })
})

describe('Thread Artifact Stability — re-entry and reload', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('re-entering thread with artifact row and loaded project shows card immediately', async () => {
    const threadId = 'conv-reentry'

    await addProject(seedProject({ id: PROJECT_UUID, title: 'Fenstereinbau' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Simulate re-entry: fresh getThreadArtifacts call
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID)
    expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    expect(artifacts.pendingProjectArtifact).toBe(false)
  })

  it('re-entering thread with offer artifact row and loaded offer shows card immediately', async () => {
    const threadId = 'conv-reentry-offer'

    await addConversation(seedConversation({ id: threadId }))
    await addOffer(seedOffer({
      id: OFFER_UUID,
      conversationId: threadId,
    }))
    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'sent',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Simulate re-entry
    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.offer.id).toBe(OFFER_UUID)
    expect(artifacts.offerPaymentArtifact!.phase).toBe('sent')
    expect(artifacts.pendingOfferArtifact).toBe(false)
  })

  it('multiple sequential getThreadArtifacts calls return stable results', async () => {
    const threadId = 'conv-stable-reads'

    await addProject(seedProject({ id: PROJECT_UUID, title: 'Dachausbau' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
    }))
    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    // Multiple reads should return consistent results
    const read1 = getThreadArtifacts(threadId)
    const read2 = getThreadArtifacts(threadId)
    const read3 = getThreadArtifacts(threadId)

    expect(read1.projectArtifact).not.toBeNull()
    expect(read2.projectArtifact).not.toBeNull()
    expect(read3.projectArtifact).not.toBeNull()
    expect(read1.projectArtifact!.project.id).toBe(PROJECT_UUID)
    expect(read2.projectArtifact!.project.id).toBe(PROJECT_UUID)
    expect(read3.projectArtifact!.project.id).toBe(PROJECT_UUID)
  })
})

describe('Thread Artifact Stability — legacy render guard removal', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('confirmed artifact is not hidden even when sourceProjectId is missing', async () => {
    const threadId = 'conv-no-source'

    await addProject(seedProject({ id: PROJECT_UUID, title: 'Poolbau' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
      inquiryOrigin: undefined,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
  })

  it('confirmed artifact renders regardless of inquiryOrigin', async () => {
    for (const origin of ['profile', 'reel', 'category', 'project', 'direct', undefined]) {
      setupCleanRepositories()
      const threadId = `conv-origin-${origin ?? 'none'}`

      await addProject(seedProject({ id: PROJECT_UUID, title: 'Treppenbau' }))
      await addConversation(seedConversation({
        id: threadId,
        sourceProjectId: undefined,
        inquiryOrigin: origin as Conversation['inquiryOrigin'],
      }))

      await persistProjectArtifact({
        conversationId: threadId,
        projectId: PROJECT_UUID,
        customerUserId: 'customer-123',
        craftsmanUserId: 'craftsman-456',
      })

      const artifacts = getThreadArtifacts(threadId)
      expect(artifacts.projectArtifact).not.toBeNull()
      expect(artifacts.projectArtifact!.persistenceStatus).toBe('confirmed')
    }
  })
})

describe('Thread Artifact Stability — offer/payment parity', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('offer artifact follows same pending/resolve pattern as project', async () => {
    const threadId = 'conv-offer-parity'

    await addConversation(seedConversation({ id: threadId }))

    // Step 1: artifact record exists, offer entity not loaded → pending
    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'sent',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    const step1 = getThreadArtifacts(threadId)
    expect(step1.offerPaymentArtifact).toBeNull()
    expect(step1.pendingOfferArtifact).toBe(true)

    // Step 2: offer entity loads → resolves
    await addOffer(seedOffer({
      id: OFFER_UUID,
      conversationId: threadId,
    }))

    const step2 = getThreadArtifacts(threadId)
    expect(step2.offerPaymentArtifact).not.toBeNull()
    expect(step2.pendingOfferArtifact).toBe(false)
  })

  it('declined offer artifact is still visible', async () => {
    const threadId = 'conv-declined'

    await addConversation(seedConversation({ id: threadId }))
    await addOffer(seedOffer({
      id: OFFER_UUID,
      conversationId: threadId,
      status: 'declined',
      declinedAt: Date.now(),
    }))
    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'declined',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.phase).toBe('declined')
  })

  it('accepted offer artifact is still visible', async () => {
    const threadId = 'conv-accepted'

    await addConversation(seedConversation({ id: threadId }))
    await addOffer(seedOffer({
      id: OFFER_UUID,
      conversationId: threadId,
      status: 'accepted',
      acceptedAt: Date.now(),
    }))
    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'accepted',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact!.phase).toBe('accepted')
  })

  it('both project and offer artifacts coexist independently', async () => {
    const threadId = 'conv-coexist'

    await addProject(seedProject({ id: PROJECT_UUID, title: 'Doppelauftrag' }))
    await addConversation(seedConversation({
      id: threadId,
      sourceProjectId: undefined,
    }))
    await addOffer(seedOffer({
      id: OFFER_UUID,
      conversationId: threadId,
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })
    await persistOfferArtifact({
      conversationId: threadId,
      offerId: OFFER_UUID,
      phase: 'sent',
      customerUserId: 'customer-123',
      craftsmanUserId: 'craftsman-456',
    })

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.offerPaymentArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID)
    expect(artifacts.offerPaymentArtifact!.offer.id).toBe(OFFER_UUID)
  })
})

describe('Thread Artifact Stability — participant scoping preserved', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('non-participant gets no artifacts and no pending flags', async () => {
    const threadId = 'conv-scoped'

    await addProject(seedProject({ id: PROJECT_UUID }))
    await addConversation(seedConversation({
      id: threadId,
      customerUserId: 'customer-A',
      craftsmanUserId: 'craftsman-B',
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-A',
      craftsmanUserId: 'craftsman-B',
    })

    // Mock session as an unrelated user
    const session = getSession()
    const originalUser = session.user
    session.user = { id: 'unrelated-intruder' } as typeof session.user

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).toBeNull()
    expect(artifacts.offerPaymentArtifact).toBeNull()
    expect(artifacts.pendingProjectArtifact).toBe(false)
    expect(artifacts.pendingOfferArtifact).toBe(false)

    // Restore
    session.user = originalUser
  })

  it('correct participant sees artifacts', async () => {
    const threadId = 'conv-participant-ok'

    await addProject(seedProject({ id: PROJECT_UUID }))
    await addConversation(seedConversation({
      id: threadId,
      customerUserId: 'customer-X',
      craftsmanUserId: 'craftsman-Y',
    }))

    await persistProjectArtifact({
      conversationId: threadId,
      projectId: PROJECT_UUID,
      customerUserId: 'customer-X',
      craftsmanUserId: 'craftsman-Y',
    })

    // Mock session as the customer participant
    const session = getSession()
    const originalUser = session.user
    session.user = { id: 'customer-X' } as typeof session.user

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).not.toBeNull()
    expect(artifacts.projectArtifact!.project.id).toBe(PROJECT_UUID)

    // Restore
    session.user = originalUser
  })
})

describe('Thread Artifact Stability — no pending when no artifact record exists', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('empty thread has no artifacts and no pending flags', async () => {
    const threadId = 'conv-empty'

    await addConversation(seedConversation({ id: threadId }))

    const artifacts = getThreadArtifacts(threadId)
    expect(artifacts.projectArtifact).toBeNull()
    expect(artifacts.offerPaymentArtifact).toBeNull()
    expect(artifacts.pendingProjectArtifact).toBe(false)
    expect(artifacts.pendingOfferArtifact).toBe(false)
  })

  it('nonexistent thread has no artifacts and no pending flags', () => {
    const artifacts = getThreadArtifacts('nonexistent-thread-id')
    expect(artifacts.projectArtifact).toBeNull()
    expect(artifacts.offerPaymentArtifact).toBeNull()
    expect(artifacts.pendingProjectArtifact).toBe(false)
    expect(artifacts.pendingOfferArtifact).toBe(false)
  })
})
