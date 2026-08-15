import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { SupabaseMessageRepository } from '../../src/lib/messages/repository/SupabaseMessageRepository'
import { supabase } from '../../src/lib/supabase'
import type { Conversation, Message } from '../../src/lib/messages/types'

// Type definitions for test mocks
interface MockChannel {
  on: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
}

interface MockQueryBuilder {
  select?: ReturnType<typeof vi.fn>
  or?: ReturnType<typeof vi.fn>
  gt?: ReturnType<typeof vi.fn>
  order?: ReturnType<typeof vi.fn>
  limit?: ReturnType<typeof vi.fn>
  insert?: ReturnType<typeof vi.fn>
  update?: ReturnType<typeof vi.fn>
  eq?: ReturnType<typeof vi.fn>
  then?: ReturnType<typeof vi.fn>
}

interface MockSession {
  user: { id: string }
}

// Mock the supabase module
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

// Mock observability functions
vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logBreadcrumb: vi.fn(),
}))

// Mock persistence functions
vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

describe('SupabaseMessageRepository - Realtime Reliability', () => {
  let repo: SupabaseMessageRepository
  let mockChannel: MockChannel
  let mockSubscribeCallback: ((status: string) => void) | null = null
  let authCallback: ((event: string, session: MockSession | null) => void) | null = null

  beforeEach(() => {
    repo = new SupabaseMessageRepository()
    mockSubscribeCallback = null
    authCallback = null

    // Setup mock channel
    mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn((callback) => {
        mockSubscribeCallback = callback
        return mockChannel
      }),
    }

    // Setup supabase.channel mock
    vi.mocked(supabase.channel).mockReturnValue(mockChannel)
    vi.mocked(supabase.removeChannel).mockResolvedValue({ status: 'ok', error: null })
    vi.mocked(supabase.auth.onAuthStateChange).mockImplementation((callback: unknown) => {
      authCallback = callback as typeof authCallback
      return {
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('conversation payload + schema alignment', () => {
    it('persists all display/context columns when inserting a conversation', async () => {
      const insertMock = vi.fn().mockResolvedValue({ data: null, error: null })
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'customer-1' },
          } as MockSession,
        },
        error: null,
      })

      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'conversations') {
          return {
            insert: insertMock,
          } as unknown as MockQueryBuilder
        }
        return {
          insert: vi.fn(),
        } as unknown as MockQueryBuilder
      })

      const conversation: Conversation = {
        id: 'thread-ctx-1',
        projectId: 'project-ctx-1',
        customerName: 'Anna Kunde',
        customerAvatarUrl: 'https://example.com/customer.jpg',
        customerUserId: 'customer-1',
        craftsmanName: 'Hans Meister',
        craftsmanHandle: 'meister-hans',
        craftsmanAvatarUrl: 'https://example.com/craftsman.jpg',
        craftsmanUserId: 'craftsman-1',
        projectTitle: 'Bad Renovierung',
        projectSubtitle: 'Komplettsanierung',
        projectLocation: 'Hamburg',
        projectCostRange: '5.000 €',
        projectDuration: '2 Wochen',
        projectStatusLabel: 'Anfrage läuft',
        timeLabel: 'Jetzt',
        unreadCount: 0,
        inquiryOrigin: 'profile',
        sourceProjectId: 'source-123',
        reviewedAt: 1111,
        declinedAt: null,
        createdAt: 1700000000000,
        projectDescription: 'Bitte komplettes Bad sanieren',
        inquiryCriteria: {
          category: 'Bad',
          description: 'Kleines Bad modernisieren',
          location: 'Hamburg',
          budget: '5.000 €',
          timing: 'April',
        },
      }

      await repo.addConversation(conversation)

      expect(insertMock).toHaveBeenCalledTimes(1)
      const payload = insertMock.mock.calls[0][0] as Record<string, unknown>
      const expectedKeys = [
        'id',
        'customer_name',
        'customer_avatar_url',
        'customer_user_id',
        'craftsman_name',
        'craftsman_handle',
        'craftsman_avatar_url',
        'craftsman_user_id',
        'project_title',
        'project_subtitle',
        'project_location',
        'project_cost_range',
        'project_duration',
        'project_status_label',
        'time_label',
        'unread_count',
        'inquiry_origin',
        'source_project_id',
        'reviewed_at',
        'declined_at',
        'created_at',
        'project_description',
        'inquiry_criteria',
      ]
      expect(Object.keys(payload).sort()).toEqual(expectedKeys.sort())
      expect(payload.customer_avatar_url).toBe(conversation.customerAvatarUrl)
      expect(payload.craftsman_avatar_url).toBe(conversation.craftsmanAvatarUrl)
      expect(payload.project_description).toBe(conversation.projectDescription)
      expect(payload.inquiry_criteria).toEqual(conversation.inquiryCriteria)
      expect(payload.customer_user_id).toBe('customer-1')
      expect(payload.created_at).toBe(conversation.createdAt)
      // source_project_id is the canonical project reference — stores sourceProjectId if present
      expect(payload.source_project_id).toBe(
        conversation.sourceProjectId ?? conversation.projectId
      )
      // project_id must NOT be in the payload (live schema does not have it)
      expect(payload).not.toHaveProperty('project_id')
    })
  })

  describe('initialize() context persistence', () => {
    it('hydrates conversations with display/context fields from Supabase rows', async () => {
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      const conversationRow = {
        id: 'thread-ctx',
        customer_name: 'Clara Kundin',
        customer_avatar_url: 'https://example.com/cust.jpg',
        customer_user_id: 'customer-ctx',
        craftsman_name: 'Peter Profi',
        craftsman_handle: 'peter-profi',
        craftsman_avatar_url: 'https://example.com/craft.jpg',
        craftsman_user_id: 'craftsman-ctx',
        project_title: 'Dachsanierung',
        project_subtitle: 'Neues Dach',
        project_location: 'Hamburg',
        project_cost_range: '12.000 €',
        project_duration: '6 Wochen',
        project_status_label: 'Anfrage läuft',
        time_label: 'Gestern',
        unread_count: 2,
        inquiry_origin: 'profile',
        source_project_id: 'project-ctx',
        reviewed_at: 1234,
        declined_at: null,
        created_at: 1700,
        project_description: 'Bitte komplettes Dach erneuern',
        inquiry_criteria: {
          category: 'Dach',
          description: 'Komplett neu eindecken',
          location: 'Hamburg',
        },
      }

      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [conversationRow],
              error: null,
            }),
          } as MockQueryBuilder
        }
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      await repo.initialize()

      const conversation = repo.getConversationById('thread-ctx')
      expect(conversation).toBeDefined()
      // projectId is hydrated from source_project_id (canonical project reference)
      expect(conversation?.projectId).toBe('project-ctx')
      expect(conversation?.customerAvatarUrl).toBe('https://example.com/cust.jpg')
      expect(conversation?.craftsmanAvatarUrl).toBe('https://example.com/craft.jpg')
      expect(conversation?.projectDescription).toBe('Bitte komplettes Dach erneuern')
      expect(conversation?.inquiryCriteria?.location).toBe('Hamburg')
      expect(conversation?.inquiryOrigin).toBe('profile')
      expect(conversation?.createdAt).toBe(1700)
      expect(conversation?.unreadCount).toBe(2)
    })

    it('rehydrates conversations when the session becomes available after a reload', async () => {
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: { session: null },
        error: null,
      })

      const conversationRow = {
        id: 'thread-late',
        customer_name: 'Late Customer',
        customer_avatar_url: 'https://example.com/late.jpg',
        customer_user_id: 'customer-late',
        craftsman_name: 'Craftsman Late',
        craftsman_handle: 'late-handle',
        craftsman_avatar_url: 'https://example.com/craft.jpg',
        craftsman_user_id: 'craftsman-late',
        project_title: 'Später Reload',
        project_subtitle: 'Anfrage',
        project_location: 'Berlin',
        project_cost_range: null,
        project_duration: null,
        project_status_label: 'Anfrage läuft',
        time_label: 'Gerade eben',
        unread_count: 0,
        inquiry_origin: 'profile',
        source_project_id: 'project-late',
        reviewed_at: null,
        declined_at: null,
        created_at: 1700,
      }

      const messageRow = {
        id: 'msg-late',
        conversation_id: 'thread-late',
        sender_user_id: 'customer-late',
        content: 'Hallo, bitte melden',
        created_at: 1701,
        media_url: null,
      }

      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [conversationRow],
              error: null,
            }),
          } as MockQueryBuilder
        }
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [messageRow],
            error: null,
          }),
        } as MockQueryBuilder
      })

      await repo.initialize()

      expect(repo.getConversations()).toEqual([])
      expect(authCallback).toBeTruthy()

      // Simulate the auth session becoming available after the initial load
      authCallback?.('SIGNED_IN', { user: { id: 'customer-late' } } as MockSession)
      await new Promise((resolve) => setTimeout(resolve, 0))

      const conversation = repo.getConversationById('thread-late')
      expect(conversation).toBeDefined()
      expect(conversation?.customerUserId).toBe('customer-late')
      expect(repo.getMessagesByConversationId('thread-late')).toHaveLength(1)
    })

    it('does not expose synthetic sourceProjectId for non-builder inquiries', async () => {
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-ctx' },
          } as MockSession,
        },
        error: null,
      })

      const conversationRow = {
        id: 'thread-synth',
        customer_name: 'Kunde',
        customer_avatar_url: '',
        customer_user_id: 'user-ctx',
        craftsman_name: 'Handwerker',
        craftsman_handle: 'handle',
        craftsman_avatar_url: '',
        craftsman_user_id: 'craft-1',
        project_title: 'Profil Anfrage',
        project_subtitle: 'Neue Anfrage',
        project_location: null,
        project_cost_range: null,
        project_duration: null,
        project_status_label: null,
        time_label: 'Jetzt',
        unread_count: 0,
        inquiry_origin: 'profile',
        source_project_id: 'project_profile_craft-1_thread-synth',
        reviewed_at: null,
        declined_at: null,
        created_at: 1234,
      }

      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [conversationRow],
              error: null,
            }),
          } as MockQueryBuilder
        }
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      await repo.initialize()

      const conversation = repo.getConversationById('thread-synth')
      expect(conversation).toBeDefined()
      expect(conversation?.projectId).toBe('project_profile_craft-1_thread-synth')
      expect(conversation?.sourceProjectId).toBeUndefined()
    })
  })

  describe('initialize() error handling', () => {
    it('does not throw when conversations fetch fails', async () => {
      // Mock successful auth
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      // Mock conversations fetch failure
      const conversationsError = new Error('Network error')
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: null,
              error: conversationsError,
            }),
          } as MockQueryBuilder
        }
        // Messages succeed
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      // Should not throw
      await expect(repo.initialize()).resolves.toBeUndefined()

      // Conversations should be empty
      expect(repo.getConversations()).toEqual([])
    })

    it('does not throw when messages fetch fails', async () => {
      // Mock successful auth
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      // Mock messages fetch failure
      const messagesError = new Error('Network error')
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: null,
              error: messagesError,
            }),
          } as MockQueryBuilder
        }
        // Conversations succeed
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      // Should not throw
      await expect(repo.initialize()).resolves.toBeUndefined()

      // Messages should be empty
      expect(repo.getMessages()).toEqual([])
    })

    it('does not throw when getSession fails', async () => {
      // Mock auth failure
      vi.mocked(supabase.auth.getSession).mockRejectedValue(new Error('Auth error'))

      // Should not throw
      await expect(repo.initialize()).resolves.toBeUndefined()

      // State should be empty
      expect(repo.getConversations()).toEqual([])
      expect(repo.getMessages()).toEqual([])
    })

    it('continues with empty state when both fetches fail', async () => {
      // Mock successful auth
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      // Mock both fetches failing
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: null,
            error: new Error('Network error'),
          }),
        } as MockQueryBuilder
      })

      // Should not throw
      await expect(repo.initialize()).resolves.toBeUndefined()

      // State should be empty
      expect(repo.getConversations()).toEqual([])
      expect(repo.getMessages()).toEqual([])
    })
  })

  describe('realtime subscription status handling', () => {
    beforeEach(async () => {
      // Mock successful initialization
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      await repo.initialize()
    })

    it('tracks connection status when subscription succeeds', () => {
      expect(mockSubscribeCallback).toBeTruthy()

      // Simulate successful subscription
      mockSubscribeCallback!('SUBSCRIBED')

      // Connection should be tracked (we can't directly access private fields in tests,
      // but we verify the behavior through side effects like reconnection attempts)
      expect(supabase.channel).toHaveBeenCalledWith('fixup-messages-user-123')
    })

    it('triggers fallback refresh on CHANNEL_ERROR', async () => {
      expect(mockSubscribeCallback).toBeTruthy()

      // Mock the fallback refresh fetch
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      // Simulate channel error
      mockSubscribeCallback!('CHANNEL_ERROR')

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Fallback refresh should have been called
      expect(supabase.from).toHaveBeenCalledWith('messages')
    })

    it('triggers fallback refresh on TIMED_OUT', async () => {
      expect(mockSubscribeCallback).toBeTruthy()

      // Mock the fallback refresh fetch
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      // Simulate timeout
      mockSubscribeCallback!('TIMED_OUT')

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Fallback refresh should have been called
      expect(supabase.from).toHaveBeenCalledWith('messages')
    })

    it('triggers fallback refresh on CLOSED', async () => {
      expect(mockSubscribeCallback).toBeTruthy()

      // Mock the fallback refresh fetch
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
        } as MockQueryBuilder
      })

      // Simulate closed connection
      mockSubscribeCallback!('CLOSED')

      // Wait a bit for async operations
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Fallback refresh should have been called
      expect(supabase.from).toHaveBeenCalledWith('messages')
    })

    it('attempts reconnection on error with exponential backoff', async () => {
      vi.useFakeTimers()
      expect(mockSubscribeCallback).toBeTruthy()

      // Clear initial channel call
      vi.clearAllMocks()

      // Simulate channel error
      mockSubscribeCallback!('CHANNEL_ERROR')

      // Wait for first reconnection attempt (3000ms * 1)
      vi.advanceTimersByTime(3000)
      await Promise.resolve()

      // Should have attempted reconnection
      expect(supabase.channel).toHaveBeenCalledTimes(1)

      // Simulate another error
      mockSubscribeCallback!('CHANNEL_ERROR')

      // Wait for second reconnection attempt (3000ms * 2)
      vi.advanceTimersByTime(6000)
      await Promise.resolve()

      // Should have attempted second reconnection
      expect(supabase.channel).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('stops reconnection attempts after max attempts', async () => {
      vi.useFakeTimers()
      expect(mockSubscribeCallback).toBeTruthy()

      // Clear initial channel call
      vi.clearAllMocks()

      // Simulate 5 errors (max attempts)
      for (let i = 0; i < 5; i++) {
        mockSubscribeCallback!('CHANNEL_ERROR')
        vi.advanceTimersByTime(3000 * (i + 1))
        await Promise.resolve()
      }

      // Should have attempted 5 reconnections
      expect(supabase.channel).toHaveBeenCalledTimes(5)

      // Simulate one more error
      mockSubscribeCallback!('CHANNEL_ERROR')
      vi.advanceTimersByTime(30000)
      await Promise.resolve()

      // Should not have attempted another reconnection
      expect(supabase.channel).toHaveBeenCalledTimes(5)

      vi.useRealTimers()
    })

    it('resets reconnection attempts on successful connection', async () => {
      vi.useFakeTimers()
      expect(mockSubscribeCallback).toBeTruthy()

      // Clear initial channel call
      vi.clearAllMocks()

      // Simulate error and reconnection
      mockSubscribeCallback!('CHANNEL_ERROR')
      vi.advanceTimersByTime(3000)
      await Promise.resolve()

      // Simulate successful connection
      mockSubscribeCallback!('SUBSCRIBED')

      // Clear calls
      vi.clearAllMocks()

      // Simulate another error - should restart from attempt 1
      mockSubscribeCallback!('CHANNEL_ERROR')
      vi.advanceTimersByTime(3000)
      await Promise.resolve()

      // Should have attempted reconnection with first delay
      expect(supabase.channel).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })
  })

  describe('fallback refresh behavior', () => {
    beforeEach(async () => {
      // Mock successful initialization
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: vi.fn((callback) => {
            callback({ error: null })
            return Promise.resolve({ error: null })
          }),
        } as MockQueryBuilder
      })

      await repo.initialize()
    })

    it('deduplicates messages during fallback refresh', async () => {
      // Add initial conversation
      const conversation: Conversation = {
        id: 'conv-1',
        projectId: 'proj-1',
        customerName: 'Customer',
        customerAvatarUrl: '',
        craftsmanName: 'Craftsman',
        craftsmanHandle: '@craftsman',
        craftsmanAvatarUrl: '',
        projectTitle: 'Project',
        projectSubtitle: '',
        createdAt: Date.now(),
      }
      await repo.addConversation(conversation)

      // Add initial message
      const message1: Message = {
        id: 'msg-1',
        conversationId: 'conv-1',
        sender: 'user',
        text: 'Hello',
        createdAtLabel: '12:00',
        sentAt: Date.now(),
      }
      await repo.addMessageAndUpdateConversation(message1, 'conv-1', {})

      expect(repo.getMessages()).toHaveLength(1)

      // Mock fallback refresh that returns the same message plus a new one
      // (newest-first, mirroring the descending fetch; gt = since-cursor).
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          gt: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [
              {
                id: 'msg-2',
                conversation_id: 'conv-1',
                sender_user_id: 'other-user',
                content: 'World',
                created_at: Date.now(),
                media_url: null,
              },
              {
                id: 'msg-1',
                conversation_id: 'conv-1',
                sender_user_id: 'user-123',
                content: 'Hello',
                created_at: Date.now() - 1000,
                media_url: null,
              },
            ],
            error: null,
          }),
        } as MockQueryBuilder
      })

      // Trigger fallback refresh via channel error
      expect(mockSubscribeCallback).toBeTruthy()
      mockSubscribeCallback!('CHANNEL_ERROR')

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should have 2 messages (not 3)
      expect(repo.getMessages()).toHaveLength(2)
    })

    it('handles fallback refresh errors gracefully', async () => {
      // Mock fallback refresh failure
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: null,
            error: new Error('Network error'),
          }),
        } as MockQueryBuilder
      })

      // Trigger fallback refresh via channel error
      expect(mockSubscribeCallback).toBeTruthy()
      mockSubscribeCallback!('CHANNEL_ERROR')

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Should not have thrown and messages should remain empty
      expect(repo.getMessages()).toEqual([])
    })
  })

  describe('existing message flow still works', () => {
    beforeEach(async () => {
      // Mock successful initialization
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: 'user-123' },
          } as MockSession,
        },
        error: null,
      })

      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: [],
            error: null,
          }),
          insert: vi.fn().mockResolvedValue({ error: null }),
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: vi.fn((callback) => {
            callback({ error: null })
            return Promise.resolve({ error: null })
          }),
        } as MockQueryBuilder
      })

      await repo.initialize()
    })

    it('can add conversations and messages', async () => {
      const conversation: Conversation = {
        id: 'conv-test',
        projectId: 'proj-test',
        customerName: 'Customer',
        customerAvatarUrl: '',
        craftsmanName: 'Craftsman',
        craftsmanHandle: '@craftsman',
        craftsmanAvatarUrl: '',
        projectTitle: 'Project',
        projectSubtitle: '',
        createdAt: Date.now(),
      }

      await repo.addConversation(conversation)
      expect(repo.getConversations()).toHaveLength(1)

      const message: Message = {
        id: 'msg-test',
        conversationId: 'conv-test',
        sender: 'user',
        text: 'Test message',
        createdAtLabel: '12:00',
        sentAt: Date.now(),
      }

      await repo.addMessageAndUpdateConversation(message, 'conv-test', {})
      expect(repo.getMessages()).toHaveLength(1)
      expect(repo.getMessagesByConversationId('conv-test')).toHaveLength(1)
    })

    it('notifies listeners on changes', async () => {
      let notificationCount = 0
      repo.subscribe(() => {
        notificationCount++
      })

      const conversation: Conversation = {
        id: 'conv-notify',
        projectId: 'proj-notify',
        customerName: 'Customer',
        customerAvatarUrl: '',
        craftsmanName: 'Craftsman',
        craftsmanHandle: '@craftsman',
        craftsmanAvatarUrl: '',
        projectTitle: 'Project',
        projectSubtitle: '',
        createdAt: Date.now(),
      }

      await repo.addConversation(conversation)

      // Should have notified
      expect(notificationCount).toBeGreaterThan(0)
    })
  })

  describe('stale-while-revalidate on resync', () => {
    const staleConversationRow = {
      id: 'thread-stale',
      customer_name: 'Stale Customer',
      customer_avatar_url: '',
      customer_user_id: 'user-123',
      craftsman_name: 'Craftsman',
      craftsman_handle: 'craftsman-handle',
      craftsman_avatar_url: '',
      craftsman_user_id: 'craftsman-stale',
      project_title: 'Badsanierung',
      project_subtitle: 'Anfrage',
      project_location: 'Hannover',
      project_cost_range: null,
      project_duration: null,
      project_status_label: 'Anfrage läuft',
      time_label: 'Gestern',
      unread_count: 0,
      inquiry_origin: 'profile',
      source_project_id: 'project-stale',
      reviewed_at: null,
      declined_at: null,
      created_at: 1700,
    }

    const staleMessageRow = {
      id: 'msg-stale',
      conversation_id: 'thread-stale',
      sender_user_id: 'user-123',
      content: 'Hallo, bitte melden',
      created_at: 1701,
      media_url: null,
    }

    function mockSessionUser(uid: string) {
      vi.mocked(supabase.auth.getSession).mockResolvedValue({
        data: {
          session: {
            user: { id: uid },
          } as MockSession,
        },
        error: null,
      })
    }

    function mockFetchSuccess(convRows: unknown[], msgRows: unknown[]) {
      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: convRows, error: null }),
          } as MockQueryBuilder
        }
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: msgRows, error: null }),
        } as MockQueryBuilder
      })
    }

    function mockFetchFailure() {
      vi.mocked(supabase.from).mockImplementation(() => {
        return {
          select: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({
            data: null,
            error: new Error('Network error'),
          }),
        } as MockQueryBuilder
      })
    }

    beforeEach(async () => {
      mockSessionUser('user-123')
      mockFetchSuccess([staleConversationRow], [staleMessageRow])
      await repo.initialize()
      // Sanity: warm cache loaded, no error.
      expect(repo.getConversations()).toHaveLength(1)
      expect(repo.getLastError()).toBeNull()
    })

    it('keeps cached conversations and messages when a resync fetch fails', async () => {
      mockFetchFailure()
      repo.prepareForResync()
      await repo.initialize()

      // Cache must survive the transient fetch error — empty inbox would
      // otherwise replace already-rendered threads on a flaky resume.
      expect(repo.getConversations()).toHaveLength(1)
      expect(repo.getConversationById('thread-stale')).toBeDefined()
      expect(repo.getMessagesByConversationId('thread-stale')).toHaveLength(1)
      // Error is surfaced via getLastError, not via cache wipe.
      expect(repo.getLastError()).not.toBeNull()
      expect(repo.isHydrated()).toBe(true)
    })

    it('keeps the cache when getSession itself rejects during resync', async () => {
      vi.mocked(supabase.auth.getSession).mockRejectedValue(new Error('network down'))
      repo.prepareForResync()
      await repo.initialize()

      expect(repo.getConversations()).toHaveLength(1)
      expect(repo.getMessagesByConversationId('thread-stale')).toHaveLength(1)
      expect(repo.getLastError()).not.toBeNull()
      expect(repo.isHydrated()).toBe(true)
    })

    it('clears the previous user cache when a different uid loads with a failing fetch', async () => {
      // Account switch + failing fetch: the stale cache belongs to user-123
      // and must NOT survive into user-B's view.
      mockFetchFailure()
      expect(authCallback).toBeTruthy()
      authCallback?.('SIGNED_IN', { user: { id: 'user-B' } } as MockSession)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(repo.getConversations()).toEqual([])
      expect(repo.getMessages()).toEqual([])
      expect(repo.getLastError()).not.toBeNull()
    })

    it('recovers fully on the next successful resync (fresh data, error cleared)', async () => {
      mockFetchFailure()
      repo.prepareForResync()
      await repo.initialize()
      expect(repo.getLastError()).not.toBeNull()

      const freshRow = { ...staleConversationRow, id: 'thread-fresh' }
      mockFetchSuccess([staleConversationRow, freshRow], [staleMessageRow])
      repo.prepareForResync()
      await repo.initialize()

      expect(repo.getConversations()).toHaveLength(2)
      expect(repo.getConversationById('thread-fresh')).toBeDefined()
      expect(repo.getLastError()).toBeNull()
    })
  })
})
