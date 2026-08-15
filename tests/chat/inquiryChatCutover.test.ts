/**
 * Chat-Cutover Slice C — inquiry workflows write to chat_threads behind
 * VITE_CHAT_UI_CUTOVER_CUSTOMER, legacy stays untouched with the flag off.
 *
 * Coverage:
 *   1. Flag ON  → profile/reel inquiry creates a chat thread via the RPC
 *      (inquiry metadata + display metadata forwarded), NO legacy
 *      conversation row, daily-send recorded.
 *   2. Flag ON  → second inquiry for the same pair reuses the cached thread
 *      (no second RPC call, no second daily send).
 *   3. Flag OFF → legacy conversation path untouched (regression), RPC never
 *      called.
 *   4. markRequestReviewedWorkflow / declineRequestWorkflow are dual-path BY
 *      LOOKUP: chat-cached threads update inquiry state on the chat repo
 *      (decline additionally sends the decline message into the chat
 *      thread); legacy ids fall through to the conversation path.
 *   5. convertInquiryToProjectWorkflow converts a chat-thread inquiry into a
 *      job (sourceConversationId = chat-thread id, owners propagated) and is
 *      idempotent across repeat calls.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import {
  startProfileInquiryWorkflow,
  startReelInquiryWorkflow,
  markRequestReviewedWorkflow,
  declineRequestWorkflow,
  convertInquiryToProjectWorkflow,
} from '../../src/lib/workflow/exploreInquiryWorkflow'
import { getConversations } from '../../src/lib/messages'
import { getJobs } from '../../src/lib/jobs'
import { getSendsToday } from '../../src/lib/customerEntry/requestLimitService'
import {
  getChatRepository,
  setChatRepository,
} from '../../src/lib/chat/repository'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import type { ChatThreadViewModel } from '../../src/lib/chat/types'
import type { ExploreReel } from '../../src/lib/explore/exploreTypes'
import type { ExploreCraftsmanProfile } from '../../src/lib/explore/exploreProfileService'

const CUSTOMER_USER_ID = 'customer-cutover-test'
const CRAFTSMAN_USER_ID = 'craftsman-cutover-test'

// ── Mocks ───────────────────────────────────────────────────────────────────

const flagState = vi.hoisted(() => ({ customer: false, craftsman: false, worker: false }))

vi.mock('../../src/lib/chat/featureFlags', () => ({
  isChatCutoverEnabled: (persona: 'customer' | 'craftsman' | 'worker') => flagState[persona],
  setChatCutoverOverride: () => {},
  applyChatCutoverUrlOverride: () => {},
}))

vi.mock('../../src/lib/session', () => ({
  getSession: () => ({
    user: { id: 'customer-cutover-test' },
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

const rpcCalls = vi.hoisted(() => ({ list: [] as Array<{ fn: string; params: Record<string, unknown> }> }))

vi.mock('../../src/lib/supabase', () => {
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: { user: { id: 'customer-cutover-test' } } },
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
      rpc: async (fn: string, params: Record<string, unknown>) => {
        rpcCalls.list.push({ fn, params })
        if (fn === 'rpc_get_or_create_chat_customer_thread') {
          // Mirror the server: create the thread, hand back the id. The
          // repository cache is seeded so ensureThreadInCache resolves.
          const id = `chat-thread-${rpcCalls.list.length}`
          seedThread({
            id,
            craftsmanUserId: params.p_craftsman_user_id as string,
            title: (params.p_title as string) ?? null,
            inquiryOrigin: (params.p_inquiry_origin as ChatThreadViewModel['inquiryOrigin']) ?? null,
            sourceProjectId: (params.p_source_project_id as string) ?? null,
            inquiryCriteria: (params.p_inquiry_criteria as ChatThreadViewModel['inquiryCriteria']) ?? null,
            displayMetadata: (params.p_display_metadata as ChatThreadViewModel['displayMetadata']) ?? null,
          })
          return { data: id, error: null }
        }
        return { data: null, error: null }
      },
    },
  }
})

function seedThread(input: {
  id: string
  craftsmanUserId: string
  title?: string | null
  inquiryOrigin?: ChatThreadViewModel['inquiryOrigin']
  sourceProjectId?: string | null
  inquiryCriteria?: ChatThreadViewModel['inquiryCriteria']
  displayMetadata?: ChatThreadViewModel['displayMetadata']
  customerUserId?: string
}): void {
  const repo = getChatRepository() as InMemoryChatRepository
  repo._seedThread({
    id: input.id,
    channelType: 'customer',
    customerUserId: input.customerUserId ?? CUSTOMER_USER_ID,
    craftsmanUserId: input.craftsmanUserId,
    providerId: 'prov-1',
    disputeId: null,
    legacyThreadId: null,
    legacySource: null,
    title: input.title ?? null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    closedAt: null,
    displayMetadata: input.displayMetadata ?? null,
    inquiryOrigin: input.inquiryOrigin ?? null,
    declinedAt: null,
    reviewedAt: null,
    sourceProjectId: input.sourceProjectId ?? null,
    inquiryCriteria: input.inquiryCriteria ?? null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'migration_complete',
  })
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeProfile(): ExploreCraftsmanProfile {
  return {
    craftsmanId: CRAFTSMAN_USER_ID,
    craftsmanName: 'Meister M',
    craftsmanHandle: 'meister-m',
    craftsmanAvatarUrl: '',
    location: 'Hannover',
    primaryCategory: 'Sanitär',
    bio: 'Test',
    tradeCategories: ['Sanitär'],
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

function makeReel(): ExploreReel {
  return {
    id: 'reel-1',
    craftsmanId: CRAFTSMAN_USER_ID,
    craftsmanName: 'Meister M',
    craftsmanHandle: 'meister-m',
    craftsmanAvatarUrl: '',
    title: 'Badsanierung Altbau',
    category: 'Sanitär',
    location: 'Hannover',
    thumbnailUrl: '',
    likes: 0,
    saves: 0,
    projectTags: [],
    searchTags: [],
    costLabel: '8.000 €',
    durationLabel: '2 Wochen',
    createdAt: Date.now(),
  }
}

beforeEach(() => {
  setupCleanRepositories()
  setChatRepository(new InMemoryChatRepository())
  rpcCalls.list.length = 0
  flagState.customer = false
  flagState.craftsman = false
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('inquiry entry points behind the cutover flag', () => {
  it('flag ON: profile inquiry writes a chat thread with metadata, no legacy row', async () => {
    flagState.customer = true

    const threadId = await startProfileInquiryWorkflow(makeProfile())

    const create = rpcCalls.list.find((c) => c.fn === 'rpc_get_or_create_chat_customer_thread')
    expect(create).toBeDefined()
    expect(create!.params.p_craftsman_user_id).toBe(CRAFTSMAN_USER_ID)
    expect(create!.params.p_inquiry_origin).toBe('profile')
    const md = create!.params.p_display_metadata as Record<string, unknown>
    expect(md.customerName).toBeTruthy()
    expect(md.craftsmanHandle).toBe('meister-m')
    expect(md.projectStatusLabel).toBe('Anfrage läuft')
    expect(String(md.syntheticProjectId)).toMatch(
      new RegExp(`^project_profile_${CRAFTSMAN_USER_ID}_`),
    )

    const thread = getChatRepository().getThread(threadId)
    expect(thread?.inquiryOrigin).toBe('profile')

    expect(getConversations()).toHaveLength(0)
    expect(await getSendsToday(CUSTOMER_USER_ID)).toBe(1)
  })

  it('flag ON: reel inquiry forwards inquiry criteria and reel context', async () => {
    flagState.customer = true

    await startReelInquiryWorkflow(makeReel())

    const create = rpcCalls.list.find((c) => c.fn === 'rpc_get_or_create_chat_customer_thread')!
    expect(create.params.p_inquiry_origin).toBe('reel')
    const md = create.params.p_display_metadata as Record<string, unknown>
    expect(md.projectTitle).toBe('Badsanierung Altbau')
    expect(md.projectCostRange).toBe('8.000 €')
    expect(md.projectDuration).toBe('2 Wochen')
  })

  it('flag ON: same pair reuses the cached thread — no second RPC, no second send', async () => {
    flagState.customer = true

    const first = await startProfileInquiryWorkflow(makeProfile())
    const second = await startReelInquiryWorkflow(makeReel())

    expect(second).toBe(first)
    expect(rpcCalls.list.filter((c) => c.fn === 'rpc_get_or_create_chat_customer_thread')).toHaveLength(1)
    expect(await getSendsToday(CUSTOMER_USER_ID)).toBe(1)
  })

  it('flag OFF: legacy conversation path untouched, RPC never called', async () => {
    const threadId = await startProfileInquiryWorkflow(makeProfile())

    expect(rpcCalls.list).toHaveLength(0)
    const conversations = getConversations()
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(threadId)
    expect(conversations[0].inquiryOrigin).toBe('profile')
  })
})

describe('review / decline dual-path by lookup', () => {
  it('marks a chat-cached inquiry thread as reviewed on the chat repo', async () => {
    seedThread({ id: 'ct-review', craftsmanUserId: CRAFTSMAN_USER_ID, inquiryOrigin: 'profile' })

    markRequestReviewedWorkflow('ct-review')
    await vi.waitFor(() => {
      expect(getChatRepository().getThread('ct-review')?.reviewedAt).toBeTruthy()
    })
  })

  it('review is a no-op for chat threads without inquiry origin', async () => {
    seedThread({ id: 'ct-plain', craftsmanUserId: CRAFTSMAN_USER_ID, inquiryOrigin: null })

    markRequestReviewedWorkflow('ct-plain')
    await new Promise((r) => setTimeout(r, 0))
    expect(getChatRepository().getThread('ct-plain')?.reviewedAt).toBeNull()
  })

  it('declines a chat inquiry: state persisted + decline message in the thread', async () => {
    seedThread({ id: 'ct-decline', craftsmanUserId: CRAFTSMAN_USER_ID, inquiryOrigin: 'reel' })

    declineRequestWorkflow('ct-decline')

    await vi.waitFor(() => {
      const thread = getChatRepository().getThread('ct-decline')
      expect(thread?.declinedAt).toBeTruthy()
      expect(thread?.reviewedAt).toBeTruthy()
    })
    await vi.waitFor(() => {
      const messages = getChatRepository().getMessages('ct-decline')
      expect(messages.some((m) => m.body?.startsWith('Vielen Dank für Ihre Anfrage'))).toBe(true)
    })
  })
})

describe('convertInquiryToProjectWorkflow — chat-thread source', () => {
  it('creates a job from a chat inquiry thread and is idempotent', async () => {
    seedThread({
      id: 'ct-convert',
      craftsmanUserId: CRAFTSMAN_USER_ID,
      inquiryOrigin: 'profile',
      displayMetadata: {
        customerName: 'Kunde K',
        craftsmanName: 'Meister M',
        projectTitle: 'Badsanierung Altbau',
        projectLocation: 'Hannover',
        projectCostRange: '8.000 €',
        syntheticProjectId: 'project_profile_x_1',
      },
    })

    const jobId = await convertInquiryToProjectWorkflow('ct-convert')
    expect(jobId).toBeTruthy()

    const job = getJobs().find((j) => j.id === jobId)!
    expect(job.sourceConversationId).toBe('ct-convert')
    expect(job.projectId).toBe('project_profile_x_1')
    expect(job.title).toBe('Badsanierung Altbau')
    expect(job.customerUserId).toBe(CUSTOMER_USER_ID)
    expect(job.craftsmanUserId).toBe(CRAFTSMAN_USER_ID)
    expect(job.intakeContext?.origin).toBe('inquiry_profile')

    // Idempotent: second conversion returns the same job.
    const again = await convertInquiryToProjectWorkflow('ct-convert')
    expect(again).toBe(jobId)
    expect(getJobs()).toHaveLength(1)

    // Conversion notice landed in the chat thread.
    await vi.waitFor(() => {
      const messages = getChatRepository().getMessages('ct-convert')
      expect(messages.some((m) => m.body?.includes('als Projekt aufgenommen'))).toBe(true)
    })
  })

  it('returns null for ids unknown to both domains', async () => {
    expect(await convertInquiryToProjectWorkflow('missing-everywhere')).toBeNull()
  })
})
