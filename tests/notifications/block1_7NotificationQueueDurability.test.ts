/**
 * Block 1.7 — Notification Queue Durability
 *
 * Verifies that SupabaseNotificationRepository upgrades all three write paths
 * to queue-durable:
 *
 *   add()        → pending guard + enqueuePendingMutation on INSERT failure
 *   markRead()   → pre-flight pending guard: merges read=true into INSERT payload
 *                  if pending INSERT exists (no DB call); otherwise UPDATE with
 *                  enqueuePendingMutation on failure
 *   markAllRead()→ partitions unread signals: pending-INSERT signals get read=true
 *                  merged into INSERT payload; normal signals go through bulk UPDATE
 *                  with per-entity failure recording on failure
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { mockInsert, mockUpdate } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: mockInsert,
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => mockUpdate()),
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
const mockRecordFailure = vi.fn()

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...args),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: (...args: unknown[]) => mockHasPending(...args),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { SupabaseNotificationRepository } from '../../src/lib/notifications/repository/SupabaseNotificationRepository'
import type { NotificationSignal } from '../../src/lib/notifications/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSignal(id: string, read = false): NotificationSignal {
  return {
    id,
    jobId: 'job-1',
    type: 'job_completed',
    priority: 'medium',
    read,
    occurredAt: 1_000,
    recipientRole: 'craftsman',
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // mockReset clears call history AND once-queues so no values bleed between tests.
  mockInsert.mockReset()
  mockUpdate.mockReset()
  mockEnqueue.mockReset()
  mockHasPending.mockReset()
  mockRecordFailure.mockReset()

  // Default: all writes succeed unless a test overrides with mockResolvedValueOnce.
  mockInsert.mockResolvedValue({ error: null })
  mockUpdate.mockResolvedValue({ error: null })
  mockHasPending.mockReturnValue(false)
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block 1.7 — Notification Queue Durability', () => {
  // ── add() ─────────────────────────────────────────────────────────────────

  describe('add()', () => {
    it('enqueues full-row INSERT mutation on Supabase failure', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-1'))
      await Promise.resolve()
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          table: 'notification_signals',
          entityId: 'sig-1',
          domain: 'notifications',
          payload: expect.objectContaining({ id: 'sig-1', job_id: 'job-1' }),
        }),
      )
    })

    it('skips DB write when pending mutation already exists for this signal', () => {
      mockHasPending.mockReturnValue(true)
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-2'))
      expect(mockInsert).not.toHaveBeenCalled()
    })

    it('does not enqueue on successful insert', async () => {
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-3'))
      await Promise.resolve()
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('dedup guard: duplicate add() for same ID triggers insert only once (hasSignal)', () => {
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-4'))
      repo.add(makeSignal('sig-4'))
      expect(mockInsert).toHaveBeenCalledTimes(1)
    })
  })

  // ── markRead() ────────────────────────────────────────────────────────────

  describe('markRead()', () => {
    it('enqueues UPDATE mutation on failure', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'timeout' } })
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-5', false))
      repo.markRead('sig-5')
      await Promise.resolve()
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'update',
          table: 'notification_signals',
          entityId: 'sig-5',
          domain: 'notifications',
          payload: expect.objectContaining({ id: 'sig-5', read: true }),
        }),
      )
    })

    it('does not enqueue on successful update', async () => {
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-7', false))
      repo.markRead('sig-7')
      await Promise.resolve()
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    // Repro 1: add fail → markRead → replay creates read=true row
    it('Repro 1: merges read=true into pending INSERT payload — no DB UPDATE, INSERT replays as read', () => {
      // Pending INSERT exists for sig-6 (add() failed earlier, row not in DB)
      mockHasPending.mockImplementation((_table: string, id: string) => id === 'sig-6')
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-6', false))
      repo.markRead('sig-6')
      // Pre-flight guard fires: must enqueue INSERT with read=true (no DB UPDATE)
      expect(mockUpdate).not.toHaveBeenCalled()
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          table: 'notification_signals',
          entityId: 'sig-6',
          payload: expect.objectContaining({ id: 'sig-6', read: true }),
        }),
      )
    })
  })

  // ── markAllRead() ─────────────────────────────────────────────────────────

  describe('markAllRead()', () => {
    it('fans out individual UPDATE mutations for all unread signals on failure', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'timeout' } })
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-a', false))
      repo.add(makeSignal('sig-b', false))
      repo.add(makeSignal('sig-c', true))
      repo.markAllRead()
      await Promise.resolve()
      // Only sig-a and sig-b were unread — sig-c was already read
      expect(mockEnqueue).toHaveBeenCalledTimes(2)
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'sig-a',
          operation: 'update',
          payload: { id: 'sig-a', read: true },
        }),
      )
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'sig-b',
          operation: 'update',
          payload: { id: 'sig-b', read: true },
        }),
      )
    })

    it('is a no-op when all signals are already read', () => {
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-z', true))
      const listener = vi.fn()
      repo.subscribe(listener)
      repo.markAllRead()
      expect(listener).not.toHaveBeenCalled()
      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('does not enqueue on successful markAllRead', async () => {
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-ok', false))
      repo.markAllRead()
      await Promise.resolve()
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    // Repro 2: add fail for multiple → markAllRead → all INSERT payloads have read=true
    it('Repro 2: merges read=true into all pending INSERT payloads — no DB UPDATE for those', async () => {
      // sig-p and sig-q both have pending INSERTs (add() failed, no DB row yet)
      mockHasPending.mockImplementation((_table: string, id: string) =>
        id === 'sig-p' || id === 'sig-q',
      )
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-p', false))
      repo.add(makeSignal('sig-q', false))
      repo.markAllRead()
      await Promise.resolve()
      // Both are pending-INSERT: bulk UPDATE must NOT fire (normalSignals is empty)
      expect(mockUpdate).not.toHaveBeenCalled()
      // Both get INSERT payload merged with read=true immediately
      expect(mockEnqueue).toHaveBeenCalledTimes(2)
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          entityId: 'sig-p',
          payload: expect.objectContaining({ id: 'sig-p', read: true }),
        }),
      )
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          entityId: 'sig-q',
          payload: expect.objectContaining({ id: 'sig-q', read: true }),
        }),
      )
    })

    // Repro 3: markAllRead fail → per-entity failures (NOT 'all') → flush clears each precisely
    it('Repro 3: records per-entity failures on bulk UPDATE failure — not aggregate entityId=all', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'db error' } })
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-r', false))
      repo.add(makeSignal('sig-s', false))
      repo.markAllRead()
      await Promise.resolve()
      // Failures must be per-entity (sig-r, sig-s), never 'all'
      expect(mockRecordFailure).not.toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'all' }),
        expect.anything(),
      )
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'sig-r', domain: 'notifications' }),
      )
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'sig-s', domain: 'notifications' }),
      )
      // Per-entity UPDATE mutations queued so flush can clear each individually
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'sig-r', operation: 'update' }),
      )
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'sig-s', operation: 'update' }),
      )
    })

    // Repro 4: mix of pending-INSERT + normal → INSERT merged, normal gets DB UPDATE
    it('Repro 4: mixed partition — pending-INSERT signal merged, normal signal gets UPDATE', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'timeout' } })
      // sig-x has pending INSERT, sig-y does not
      mockHasPending.mockImplementation((_table: string, id: string) => id === 'sig-x')
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-x', false))
      repo.add(makeSignal('sig-y', false))
      repo.markAllRead()
      await Promise.resolve()
      // sig-x: INSERT payload merged immediately (synchronous, before DB call)
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'insert',
          entityId: 'sig-x',
          payload: expect.objectContaining({ read: true }),
        }),
      )
      // sig-y: DB UPDATE fired and failed → queued as UPDATE
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'update',
          entityId: 'sig-y',
        }),
      )
      // sig-x must NOT appear as UPDATE mutation
      expect(mockEnqueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'update', entityId: 'sig-x' }),
      )
      // Total: 1 INSERT merge (sync) + 1 UPDATE queue (after failure) = 2
      expect(mockEnqueue).toHaveBeenCalledTimes(2)
    })
  })

  // ── Optimistic state preserved (no rollback) ──────────────────────────────

  describe('optimistic state', () => {
    it('add(): cache keeps signal after DB failure (no rollback)', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'fail' } })
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-persist'))
      await Promise.resolve()
      expect(repo.getAll().some((s) => s.id === 'sig-persist')).toBe(true)
    })

    it('markRead(): cache keeps read=true after DB failure (no rollback)', async () => {
      mockUpdate.mockResolvedValueOnce({ error: { message: 'fail' } })
      const repo = new SupabaseNotificationRepository()
      repo.add(makeSignal('sig-read', false))
      repo.markRead('sig-read')
      await Promise.resolve()
      expect(repo.getAll().find((s) => s.id === 'sig-read')?.read).toBe(true)
    })
  })
})
