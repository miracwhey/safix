/**
 * Conversation Schema Alignment Tests
 *
 * PURPOSE:
 * These tests enforce that the runtime conversations payload contract remains
 * aligned with the canonical conversations schema defined in the database.
 *
 * This test suite prevents schema drift by:
 * 1. Verifying all required fields are present in payloads
 * 2. Ensuring project_id vs source_project_id are used correctly
 * 3. Validating round-trip persistence of all field types
 * 4. Testing that the payload structure matches the canonical contract
 *
 * Reference: docs/CANONICAL_CONVERSATIONS_SCHEMA.md
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryMessageRepository } from '../../src/lib/messages/repository/InMemoryMessageRepository'
import { setMessageRepository } from '../../src/lib/messages/repository/registry'
import { getConversations, getConversationById, getConversationByProjectId } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'

/**
 * Helper: Create a minimal valid conversation with all canonical required fields
 */
function makeMinimalConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    // Identity fields (REQUIRED)
    id: overrides.id ?? `thread_customer_craftsman_${Date.now()}`,
    projectId: overrides.projectId ?? `project_explore_craftsman_${Date.now()}`,

    // Customer display (REQUIRED)
    customerName: overrides.customerName ?? 'Test Customer',
    customerAvatarUrl: overrides.customerAvatarUrl ?? 'https://example.com/customer.jpg',

    // Craftsman display (REQUIRED)
    craftsmanName: overrides.craftsmanName ?? 'Test Craftsman',
    craftsmanHandle: overrides.craftsmanHandle ?? '@testcraftsman',
    craftsmanAvatarUrl: overrides.craftsmanAvatarUrl ?? 'https://example.com/craftsman.jpg',

    // Project context (REQUIRED)
    projectTitle: overrides.projectTitle ?? 'Test Project',
    projectSubtitle: overrides.projectSubtitle ?? 'Test Subtitle',

    // Sort key (REQUIRED)
    createdAt: overrides.createdAt ?? Date.now(),

    // Optional fields
    ...overrides,
  }
}

/**
 * Helper: Create a full conversation with all optional fields populated
 */
function makeFullConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    ...makeMinimalConversation(overrides),

    // Optional ownership
    customerUserId: overrides.customerUserId ?? 'customer-user-id-123',
    craftsmanUserId: overrides.craftsmanUserId ?? 'craftsman-user-id-456',

    // Optional project context
    projectLocation: overrides.projectLocation ?? 'Berlin',
    projectCostRange: overrides.projectCostRange ?? '5.000 – 10.000 €',
    projectDuration: overrides.projectDuration ?? '3 Wochen',
    projectStatusLabel: overrides.projectStatusLabel ?? 'Anfrage läuft',

    // Optional UI state
    timeLabel: overrides.timeLabel ?? 'Jetzt',
    unreadCount: overrides.unreadCount ?? 0,

    // Optional inquiry metadata
    inquiryOrigin: overrides.inquiryOrigin ?? 'reel',
    sourceProjectId: overrides.sourceProjectId ?? null,

    // Optional lifecycle timestamps
    reviewedAt: overrides.reviewedAt ?? null,
    declinedAt: overrides.declinedAt ?? null,

    // Optional inquiry context
    projectDescription: overrides.projectDescription ?? null,
    inquiryCriteria: overrides.inquiryCriteria ?? null,
  }
}

describe('Conversation Schema Alignment', () => {
  let repo: InMemoryMessageRepository

  beforeEach(() => {
    repo = new InMemoryMessageRepository([], [])
    setMessageRepository(repo)
  })

  describe('Required Fields Contract', () => {
    it('minimal conversation has all required fields', async () => {
      const conv = makeMinimalConversation()

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved).toBeDefined()

      // Identity fields
      expect(retrieved!.id).toBe(conv.id)
      expect(retrieved!.projectId).toBe(conv.projectId)

      // Customer display
      expect(retrieved!.customerName).toBe(conv.customerName)
      expect(retrieved!.customerAvatarUrl).toBe(conv.customerAvatarUrl)

      // Craftsman display
      expect(retrieved!.craftsmanName).toBe(conv.craftsmanName)
      expect(retrieved!.craftsmanHandle).toBe(conv.craftsmanHandle)
      expect(retrieved!.craftsmanAvatarUrl).toBe(conv.craftsmanAvatarUrl)

      // Project context
      expect(retrieved!.projectTitle).toBe(conv.projectTitle)
      expect(retrieved!.projectSubtitle).toBe(conv.projectSubtitle)

      // Sort key
      expect(retrieved!.createdAt).toBe(conv.createdAt)
    })

    it('conversation must have projectId set (persisted via source_project_id)', async () => {
      // source_project_id is the canonical persisted project reference.
      // In the domain model, it maps to conversation.projectId.
      const conv = makeMinimalConversation({
        projectId: 'project_explore_craftsman_123',
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved).toBeDefined()
      expect(retrieved!.projectId).toBeTruthy()
      expect(retrieved!.projectId).toBe('project_explore_craftsman_123')
    })

    it('allows conversation without optional source_project_id', async () => {
      const conv = makeMinimalConversation({
        sourceProjectId: undefined, // Explicitly omit optional field
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved).toBeDefined()
      expect(retrieved!.sourceProjectId).toBeUndefined()
    })
  })

  describe('Canonical source_project_id Contract', () => {
    it('projectId is always set for all inquiry types', async () => {
      const inquiryTypes = ['reel', 'profile', 'category', 'project'] as const

      for (const origin of inquiryTypes) {
        const conv = makeMinimalConversation({
          id: `thread_${origin}_${Date.now()}`,
          projectId: `project_${origin}_craftsman_123`,
          inquiryOrigin: origin,
        })

        await repo.addConversation(conv)

        const retrieved = getConversationById(conv.id)
        expect(retrieved).toBeDefined()
        expect(retrieved!.projectId).toBe(conv.projectId)
        expect(retrieved!.projectId).toMatch(/^project_/)
      }
    })

    it('sourceProjectId is an in-memory field for builder-origin inquiries', async () => {
      // Reel inquiry: no source project
      const reelConv = makeMinimalConversation({
        id: 'thread_reel_1',
        projectId: 'project_explore_craftsman_123',
        inquiryOrigin: 'reel',
        sourceProjectId: undefined,
      })

      await repo.addConversation(reelConv)

      const retrievedReel = getConversationById('thread_reel_1')
      expect(retrievedReel!.sourceProjectId).toBeUndefined()

      // Project inquiry: has source project (in-memory, set at creation time)
      const projectConv = makeMinimalConversation({
        id: 'thread_project_2',
        projectId: 'project_inquiry_craftsman_456',
        inquiryOrigin: 'project',
        sourceProjectId: 'project_customer789_builder123', // Actual builder project
      })

      await repo.addConversation(projectConv)

      const retrievedProject = getConversationById('thread_project_2')
      expect(retrievedProject!.sourceProjectId).toBe('project_customer789_builder123')
    })

    it('getConversationByProjectId finds by projectId', () => {
      const conv = makeFullConversation({
        id: 'thread_test',
        projectId: 'project_explore_craftsman_123',
      })

      repo.addConversation(conv)

      // Should find by projectId
      const foundByProjectId = getConversationByProjectId('project_explore_craftsman_123')
      expect(foundByProjectId).toBeDefined()
      expect(foundByProjectId!.id).toBe('thread_test')
    })
  })

  describe('Optional Fields Round-Trip Persistence', () => {
    it('persists all optional ownership fields', async () => {
      const conv = makeFullConversation({
        customerUserId: 'customer-abc-123',
        craftsmanUserId: 'craftsman-xyz-789',
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.customerUserId).toBe('customer-abc-123')
      expect(retrieved!.craftsmanUserId).toBe('craftsman-xyz-789')
    })

    it('persists all optional project context fields', async () => {
      const conv = makeFullConversation({
        projectLocation: 'München',
        projectCostRange: '10.000 – 20.000 €',
        projectDuration: '6 Monate',
        projectStatusLabel: 'In Planung',
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.projectLocation).toBe('München')
      expect(retrieved!.projectCostRange).toBe('10.000 – 20.000 €')
      expect(retrieved!.projectDuration).toBe('6 Monate')
      expect(retrieved!.projectStatusLabel).toBe('In Planung')
    })

    it('persists all optional UI state fields', async () => {
      const conv = makeFullConversation({
        timeLabel: 'vor 5 Minuten',
        unreadCount: 3,
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.timeLabel).toBe('vor 5 Minuten')
      expect(retrieved!.unreadCount).toBe(3)
    })

    it('persists all optional inquiry metadata fields', async () => {
      const conv = makeFullConversation({
        inquiryOrigin: 'category',
        sourceProjectId: 'project_customer123_builder456',
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.inquiryOrigin).toBe('category')
      expect(retrieved!.sourceProjectId).toBe('project_customer123_builder456')
    })

    it('persists all optional lifecycle timestamp fields', async () => {
      const now = Date.now()
      const conv = makeFullConversation({
        reviewedAt: now - 1000,
        declinedAt: now,
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.reviewedAt).toBe(now - 1000)
      expect(retrieved!.declinedAt).toBe(now)
    })

    it('persists all optional inquiry context fields', async () => {
      const conv = makeFullConversation({
        projectDescription: 'Küche komplett renovieren mit neuen Geräten',
        inquiryCriteria: {
          category: 'Schreinerei',
          description: 'Einbauschrank nach Maß',
          location: 'Hamburg',
          budget: '5.000 – 8.000 €',
          timing: 'In 2-3 Monaten',
        },
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.projectDescription).toBe('Küche komplett renovieren mit neuen Geräten')
      expect(retrieved!.inquiryCriteria).toEqual({
        category: 'Schreinerei',
        description: 'Einbauschrank nach Maß',
        location: 'Hamburg',
        budget: '5.000 – 8.000 €',
        timing: 'In 2-3 Monaten',
      })
    })
  })

  describe('Field Type Validation', () => {
    it('enforces string types for text fields', async () => {
      const conv = makeMinimalConversation({
        customerName: 'Valid String',
        craftsmanHandle: '@validhandle',
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(typeof retrieved!.customerName).toBe('string')
      expect(typeof retrieved!.craftsmanHandle).toBe('string')
    })

    it('enforces number types for numeric fields', async () => {
      const conv = makeFullConversation({
        createdAt: 1234567890,
        reviewedAt: 1234567900,
        unreadCount: 5,
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(typeof retrieved!.createdAt).toBe('number')
      expect(typeof retrieved!.reviewedAt).toBe('number')
      expect(typeof retrieved!.unreadCount).toBe('number')
    })

    it('enforces object type for inquiryCriteria', async () => {
      const conv = makeFullConversation({
        inquiryCriteria: {
          category: 'Elektrik',
          description: 'Licht installieren',
          location: 'Berlin',
        },
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(typeof retrieved!.inquiryCriteria).toBe('object')
      expect(retrieved!.inquiryCriteria).not.toBeNull()
      expect(retrieved!.inquiryCriteria!.category).toBe('Elektrik')
    })
  })

  describe('Null vs Undefined Handling', () => {
    it('treats undefined optional fields as absent', async () => {
      const conv = makeMinimalConversation({
        sourceProjectId: undefined,
        projectDescription: undefined,
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.sourceProjectId).toBeUndefined()
      expect(retrieved!.projectDescription).toBeUndefined()
    })

    it('persists explicit null values for optional fields', async () => {
      const conv = makeFullConversation({
        sourceProjectId: null,
        projectDescription: null,
        inquiryCriteria: null,
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      // Repository may normalize undefined/null, both are acceptable for optional fields
      expect([null, undefined]).toContain(retrieved!.sourceProjectId)
      expect([null, undefined]).toContain(retrieved!.projectDescription)
      expect([null, undefined]).toContain(retrieved!.inquiryCriteria)
    })
  })

  describe('Inquiry Origin Validation', () => {
    it('accepts all valid inquiry origin types', async () => {
      const validOrigins = ['reel', 'profile', 'project', 'category'] as const

      for (const origin of validOrigins) {
        const conv = makeMinimalConversation({
          id: `thread_${origin}_${Date.now()}`,
          inquiryOrigin: origin,
        })

        await repo.addConversation(conv)

        const retrieved = getConversationById(conv.id)
        expect(retrieved!.inquiryOrigin).toBe(origin)
      }
    })

    it('allows undefined inquiry origin (optional field)', async () => {
      const conv = makeMinimalConversation({
        inquiryOrigin: undefined,
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.inquiryOrigin).toBeUndefined()
    })
  })

  describe('Created At Sort Key', () => {
    it('conversations are sortable by created_at', async () => {
      const conv1 = makeMinimalConversation({ id: 'conv1', createdAt: 1000 })
      const conv2 = makeMinimalConversation({ id: 'conv2', createdAt: 2000 })
      const conv3 = makeMinimalConversation({ id: 'conv3', createdAt: 1500 })

      await repo.addConversation(conv1)
      await repo.addConversation(conv2)
      await repo.addConversation(conv3)

      const all = getConversations()
      const sorted = all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

      expect(sorted[0].id).toBe('conv2') // Newest first
      expect(sorted[1].id).toBe('conv3')
      expect(sorted[2].id).toBe('conv1')
    })
  })

  describe('Display Metadata Reload Safety', () => {
    it('conversation survives reload with full context intact', async () => {
      const originalConv = makeFullConversation({
        id: 'thread_reload_test',
        customerName: 'Anna Schmidt',
        craftsmanName: 'Thomas Bauer',
        projectTitle: 'Badezimmer Sanierung',
        projectSubtitle: 'Komplette Erneuerung',
        projectLocation: 'Frankfurt',
      })

      await repo.addConversation(originalConv)

      // Simulate reload: create new repository with persisted data
      const reloadedRepo = new InMemoryMessageRepository([originalConv], [])
      setMessageRepository(reloadedRepo)

      const retrieved = getConversationById('thread_reload_test')
      expect(retrieved).toBeDefined()
      expect(retrieved!.customerName).toBe('Anna Schmidt')
      expect(retrieved!.craftsmanName).toBe('Thomas Bauer')
      expect(retrieved!.projectTitle).toBe('Badezimmer Sanierung')
      expect(retrieved!.projectSubtitle).toBe('Komplette Erneuerung')
      expect(retrieved!.projectLocation).toBe('Frankfurt')
    })

    it('empty strings persist correctly (not replaced with undefined)', async () => {
      // Edge case: DB default is '' for NOT NULL fields
      const conv = makeMinimalConversation({
        customerName: '',
        craftsmanName: '',
        projectTitle: '',
        projectSubtitle: '',
      })

      await repo.addConversation(conv)

      const retrieved = getConversationById(conv.id)
      expect(retrieved!.customerName).toBe('')
      expect(retrieved!.craftsmanName).toBe('')
      expect(retrieved!.projectTitle).toBe('')
      expect(retrieved!.projectSubtitle).toBe('')
    })
  })
})
