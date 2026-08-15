/**
 * Block 1.8 — Persistence Queue Coverage: Secondary Domains
 *
 * Verifies queue-durability for the six remaining fire-and-forget repositories:
 *
 *   SupabaseInAppNotificationRepository  — create/markRead/markAllRead
 *   SupabaseTeamMemberRepository         — add/update (with pre-flight guard)
 *   SupabaseMediaRepository              — add (with pre-flight guard)
 *   SupabaseRatingRepository             — add (with pre-flight guard)
 *   SupabaseFeedbackRepository           — save (with pre-flight guard)
 *
 * Also verifies:
 *   SupabaseJobRepository.remove()       — rollback on DB delete failure
 *   SupabaseDisputeRepository            — writeStatusHistory uses 'disputes/history' domain
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { mockInsert, mockUpdate, mockDelete } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      or: vi.fn().mockReturnThis(),
      insert: mockInsert,
      upsert: mockInsert,
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => mockUpdate()),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => mockDelete()),
      }),
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn(),
  },
}))

// ── Persistence mock ──────────────────────────────────────────────────────────

const mockEnqueue = vi.fn()
const mockHasPending = vi.fn()
const mockGetPendingOp = vi.fn()
const mockRecordFailure = vi.fn()

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...args),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: (...args: unknown[]) => mockHasPending(...args),
  getPendingMutationOperation: (...args: unknown[]) => mockGetPendingOp(...args),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logBreadcrumb: vi.fn(),
}))

vi.mock('../../src/lib/analytics', () => ({
  recordAnalyticsEvent: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { SupabaseInAppNotificationRepository } from '../../src/lib/inAppNotifications/repository/SupabaseInAppNotificationRepository'
import { SupabaseTeamMemberRepository } from '../../src/lib/team/repository/SupabaseTeamMemberRepository'
import { SupabaseMediaRepository } from '../../src/lib/media/repository/SupabaseMediaRepository'
import { SupabaseRatingRepository } from '../../src/lib/ratings/repository/SupabaseRatingRepository'
import { SupabaseFeedbackRepository } from '../../src/lib/feedback/repository/SupabaseFeedbackRepository'
import { SupabaseLedgerRepository } from '../../src/lib/payments/ledger/repository/SupabaseLedgerRepository'
import { SupabaseJobRepository } from '../../src/lib/jobs/repository/SupabaseJobRepository'
import { SupabaseDisputeRepository } from '../../src/lib/disputes/repository/SupabaseDisputeRepository'
import type { InAppNotification } from '../../src/lib/inAppNotifications/types'
import type { TeamMember } from '../../src/lib/jobs/types'
import type { MediaArtifact } from '../../src/lib/media/types'
import type { Rating } from '../../src/lib/ratings/types'
import type { JobFeedback } from '../../src/lib/feedback/types'
import type { LedgerEntry } from '../../src/lib/payments/ledger/ledgerTypes'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeNotification(id: string, isRead = false): InAppNotification {
  return {
    id,
    userId: 'user-1',
    type: 'job_accepted',
    entityType: 'job',
    entityId: 'job-1',
    title: '',
    message: '',
    isRead,
    createdAt: 1_000,
    recipientRole: 'craftsman',
  }
}

function makeMember(id: string): TeamMember {
  return { id, name: 'Worker', role: 'worker' }
}

function makeArtifact(id: string): MediaArtifact {
  return {
    id,
    jobId: 'job-1',
    kind: 'photo',
    label: 'Before',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    uploadedAt: 1_000,
    uploadedBy: 'user-1',
  }
}

function makeRating(id: string): Rating {
  return {
    id,
    jobId: 'job-1',
    providerUserId: 'provider-1',
    customerUserId: 'customer-1',
    ratingScore: 5,
    createdAt: 1_000,
  }
}

function makeFeedback(id: string, wouldHireAgain = true, note?: string): JobFeedback {
  return {
    id,
    jobId: 'job-1',
    craftsmanUserId: 'craftsman-1',
    wouldHireAgain,
    ...(note !== undefined ? { note } : {}),
    createdAt: 1_000,
  }
}

function makeLedgerEntry(id: string, amount = 100): LedgerEntry {
  return {
    id,
    paymentId: 'pay-1',
    jobId: 'job-1',
    type: 'escrow_created',
    amount,
    currency: 'EUR',
    createdAt: 1_000,
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockInsert.mockReset()
  mockUpdate.mockReset()
  mockDelete.mockReset()
  mockEnqueue.mockReset()
  mockHasPending.mockReset()
  mockRecordFailure.mockReset()

  mockInsert.mockResolvedValue({ error: null })
  mockUpdate.mockResolvedValue({ error: null })
  mockDelete.mockResolvedValue({ error: null })
  mockHasPending.mockReturnValue(false)
  mockGetPendingOp.mockReturnValue(undefined)
})

// ── InAppNotificationRepository ───────────────────────────────────────────────

describe('SupabaseInAppNotificationRepository', () => {
  describe('create()', () => {
    it('enqueues INSERT on failure', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-1'))
      await Promise.resolve()
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          table: 'notification_signals',
          entityId: 'n-1',
          domain: 'inAppNotifications',
        }),
      )
    })

    it('skips DB write when pending mutation already exists', () => {
      mockHasPending.mockReturnValue(true)
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-2'))
      expect(mockInsert).not.toHaveBeenCalled()
    })

    it('does not enqueue on success', async () => {
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-3'))
      await Promise.resolve()
      expect(mockEnqueue).not.toHaveBeenCalled()
    })
  })

  describe('markRead()', () => {
    it('enqueues UPDATE on failure', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'timeout' } })
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-4', false))
      repo.markRead('n-4')
      await Promise.resolve()
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'update',
          entityId: 'n-4',
          payload: expect.objectContaining({ id: 'n-4', read: true }),
        }),
      )
    })

    // Repro: pending INSERT → markRead → pre-flight merges isRead=true, no DB UPDATE
    it('Repro: merges isRead=true into pending INSERT — no DB UPDATE', () => {
      mockHasPending.mockImplementation((_table: string, id: string) => id === 'n-5')
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-5', false))
      repo.markRead('n-5')
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          entityId: 'n-5',
          payload: expect.objectContaining({ id: 'n-5', read: true }),
        }),
      )
    })
  })

  describe('markAllRead()', () => {
    it('records per-entity failures (NOT aggregate entityId) on bulk UPDATE failure', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'db error' } })
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-a', false))
      repo.create(makeNotification('n-b', false))
      repo.markAllRead('user-1')
      await Promise.resolve()
      expect(mockRecordFailure).not.toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'user-1' }),
      )
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'n-a', domain: 'inAppNotifications' }),
      )
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'n-b', domain: 'inAppNotifications' }),
      )
    })

    it('merges isRead=true into pending INSERT for pending notifications', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'timeout' } })
      mockHasPending.mockImplementation((_t: string, id: string) => id === 'n-p')
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-p', false))
      repo.create(makeNotification('n-q', false))
      repo.markAllRead('user-1')
      await Promise.resolve()
      // n-p: pending INSERT → no DB call, INSERT payload merged with isRead=true
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'insert', entityId: 'n-p' }),
      )
      // n-q: normal → DB UPDATE failed → UPDATE queued
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'update', entityId: 'n-q' }),
      )
    })

    it('is a no-op when all notifications already read', () => {
      const repo = new SupabaseInAppNotificationRepository()
      repo.create(makeNotification('n-z', true))
      const listener = vi.fn()
      repo.subscribe(listener)
      repo.markAllRead('user-1')
      expect(listener).not.toHaveBeenCalled()
      expect(mockUpdate).not.toHaveBeenCalled()
    })
  })
})

// ── TeamMemberRepository ──────────────────────────────────────────────────────

describe('SupabaseTeamMemberRepository', () => {
  it('add(): enqueues INSERT on failure', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
    const repo = new SupabaseTeamMemberRepository()
    repo.add(makeMember('tm-1'))
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'insert',
        table: 'team_members',
        entityId: 'tm-1',
        domain: 'team',
      }),
    )
  })

  it('add(): skips DB write when pending INSERT already exists', () => {
    mockHasPending.mockReturnValue(true)
    const repo = new SupabaseTeamMemberRepository()
    repo.add(makeMember('tm-2'))
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('update(): enqueues UPDATE on failure', async () => {
    mockUpdate.mockResolvedValueOnce({ error: { message: 'timeout' } })
    const repo = new SupabaseTeamMemberRepository()
    repo.add(makeMember('tm-3'))
    repo.update('tm-3', (m) => ({ ...m, name: 'Updated' }))
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'update',
        table: 'team_members',
        entityId: 'tm-3',
        domain: 'team',
      }),
    )
  })

  // Repro: pending INSERT → update() → INSERT payload receives updated state, no DB call
  it('Repro: update() merges into INSERT payload when pending INSERT exists', () => {
    mockHasPending.mockImplementation((_t: string, id: string) => id === 'tm-4')
    mockGetPendingOp.mockImplementation((_t: string, id: string) =>
      id === 'tm-4' ? 'insert' : undefined,
    )
    const repo = new SupabaseTeamMemberRepository()
    repo.add(makeMember('tm-4'))
    repo.update('tm-4', (m) => ({ ...m, name: 'Updated' }))
    expect(mockUpdate).not.toHaveBeenCalled()
    // update() enqueues INSERT (not UPDATE) so replay creates the row correctly
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'insert', entityId: 'tm-4' }),
    )
  })

  // Repro: pending UPDATE → update() → operation stays UPDATE, no RLS-breaking INSERT
  it('Repro: update() keeps UPDATE semantics when pending UPDATE exists', () => {
    mockGetPendingOp.mockImplementation((_t: string, id: string) =>
      id === 'tm-5' ? 'update' : undefined,
    )
    const repo = new SupabaseTeamMemberRepository()
    repo.add(makeMember('tm-5'))
    repo.update('tm-5', (m) => ({ ...m, name: 'Changed Again' }))
    expect(mockUpdate).not.toHaveBeenCalled()
    // Must NOT enqueue as 'insert' — would fail INSERT RLS for existing member rows
    expect(mockEnqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'insert', entityId: 'tm-5' }),
    )
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'update', entityId: 'tm-5' }),
    )
  })
})

// ── MediaRepository ───────────────────────────────────────────────────────────

describe('SupabaseMediaRepository', () => {
  it('add(): enqueues INSERT on failure', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
    const repo = new SupabaseMediaRepository()
    repo.add(makeArtifact('art-1'))
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'insert',
        table: 'media_artifacts',
        entityId: 'art-1',
        domain: 'media',
      }),
    )
  })

  it('add(): skips DB write when pending INSERT already exists', () => {
    mockHasPending.mockReturnValue(true)
    const repo = new SupabaseMediaRepository()
    repo.add(makeArtifact('art-2'))
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('add(): cache retains artifact after failure (no rollback)', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'fail' } })
    const repo = new SupabaseMediaRepository()
    repo.add(makeArtifact('art-3'))
    await Promise.resolve()
    expect(repo.getById('art-3')).toBeDefined()
  })
})

// ── RatingRepository ──────────────────────────────────────────────────────────

describe('SupabaseRatingRepository', () => {
  it('add(): enqueues INSERT on failure', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
    const repo = new SupabaseRatingRepository()
    repo.add(makeRating('rat-1'))
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'insert',
        table: 'ratings',
        entityId: 'rat-1',
        domain: 'ratings',
      }),
    )
  })

  it('add(): skips DB write when pending INSERT already exists', () => {
    mockHasPending.mockReturnValue(true)
    const repo = new SupabaseRatingRepository()
    repo.add(makeRating('rat-2'))
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('add(): does not enqueue on success', async () => {
    const repo = new SupabaseRatingRepository()
    repo.add(makeRating('rat-3'))
    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// ── FeedbackRepository ────────────────────────────────────────────────────────

describe('SupabaseFeedbackRepository', () => {
  it('save(): enqueues INSERT (via operation=insert) on failure', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
    const repo = new SupabaseFeedbackRepository()
    repo.save(makeFeedback('fb-1'))
    await Promise.resolve()
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'insert',
        table: 'job_feedback',
        entityId: 'fb-1',
        domain: 'feedback',
      }),
    )
  })

  // Repro: first save fails → second save with changed values → merge uses second values
  it('Repro: second save() merges latest note/wouldHireAgain into pending INSERT', () => {
    mockHasPending.mockReturnValue(true)
    const repo = new SupabaseFeedbackRepository()
    // Second save has different values than the first
    const updated = makeFeedback('fb-2', false, 'Actually not great')
    repo.save(updated)
    expect(mockInsert).not.toHaveBeenCalled()
    // Must enqueue with the LATEST values (wouldHireAgain=false, note='Actually not great')
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'insert',
        table: 'job_feedback',
        entityId: 'fb-2',
        payload: expect.objectContaining({
          would_hire_again: false,
          note: 'Actually not great',
        }),
      }),
    )
  })

  it('save(): does not enqueue on success', async () => {
    const repo = new SupabaseFeedbackRepository()
    repo.save(makeFeedback('fb-3'))
    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// ── LedgerRepository — updateEntryAmount cache-only schema-drift skip ─────────
//
// Prod `ledger_entries` is the uuid-id / entry_type movement model; the client
// add() deliberately never persists a row (Block PA drift). updateEntryAmount()
// therefore mirrors that skip: optimistic cache + breadcrumb, NO DB write and NO
// replay-queue enqueue (the old text-id / `type` / `note` payload was prod-invalid).

describe('SupabaseLedgerRepository.updateEntryAmount()', () => {
  it('cache-only: updates optimistic amount, no DB write, no enqueue', () => {
    const repo = new SupabaseLedgerRepository()
    // @ts-expect-error — inject entry directly
    repo['ledger'] = [makeLedgerEntry('le-1', 100)]
    repo.updateEntryAmount('le-1', 200)
    // Optimistic cache reflects the new amount...
    expect(repo.getAll().find((e) => e.id === 'le-1')?.amount).toBe(200)
    // ...but nothing is persisted or queued (schema-drift skip, mirrors add()).
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('cache-only even when a pending INSERT exists — no DB UPDATE, no enqueue', () => {
    // A pending INSERT no longer changes the path: the DB write is gone entirely.
    mockGetPendingOp.mockImplementation((_t: string, id: string) =>
      id === 'le-2' ? 'insert' : undefined,
    )
    const repo = new SupabaseLedgerRepository()
    // @ts-expect-error — inject entry
    repo['ledger'] = [makeLedgerEntry('le-2', 100)]
    repo.updateEntryAmount('le-2', 999)
    expect(repo.getAll().find((e) => e.id === 'le-2')?.amount).toBe(999)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('no-op when entry id not in cache', () => {
    const repo = new SupabaseLedgerRepository()
    repo.updateEntryAmount('nonexistent', 500)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// ── JobRepository.remove() rollback ───────────────────────────────────────────

describe('SupabaseJobRepository.remove()', () => {
  it('rolls back optimistic remove when DB delete fails', async () => {
    mockDelete.mockResolvedValueOnce({ error: { message: 'network error' } })
    const repo = new SupabaseJobRepository()
    // Manually inject a job into the cache (bypass initialize)
    // @ts-expect-error — accessing private field for test setup
    repo['jobs'] = [{ id: 'job-del', status: 'new', jobId: 'job-del' }]
    await expect(repo.remove('job-del')).rejects.toBeDefined()
    // Job must be restored after rollback
    // @ts-expect-error — accessing private field for assertion
    expect(repo['jobs'].some((j: { id: string }) => j.id === 'job-del')).toBe(true)
  })

  it('removes job from cache on successful DB delete', async () => {
    const repo = new SupabaseJobRepository()
    // @ts-expect-error — accessing private field for test setup
    repo['jobs'] = [{ id: 'job-ok', status: 'new' }]
    await repo.remove('job-ok')
    // @ts-expect-error — accessing private field for assertion
    expect(repo['jobs'].some((j: { id: string }) => j.id === 'job-ok')).toBe(false)
  })
})

// ── DisputeRepository.writeStatusHistory domain ───────────────────────────────

describe('SupabaseDisputeRepository.writeStatusHistory', () => {
  it('records failure under disputes/history domain (not disputes)', async () => {
    mockInsert.mockResolvedValueOnce({ error: null }) // add() succeeds
    // Second insert (history) fails
    mockInsert.mockResolvedValueOnce({ error: { message: 'history fail' } })

    const repo = new SupabaseDisputeRepository()
    await repo.add({
      id: '11111111-1111-4111-8111-111111111111',
      jobId: 'job-1',
      status: 'open',
      reason: 'work_quality',
      title: 'Test',
      description: 'Test dispute',
      createdAt: '2026-04-28T10:00:00.000Z',
      updatedAt: '2026-04-28T10:00:00.000Z',
    })
    await new Promise((r) => setTimeout(r, 0))

    // Failure domain must be 'disputes/history', not 'disputes'
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'disputes/history' }),
    )
    expect(mockRecordFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'disputes' }),
    )
  })
})
