/**
 * Sub-block 1.5 — Timeline ID Dedup
 *
 * Verifies that TimelineRepository.add() is idempotent on signal ID:
 *   1. Duplicate signal ID → only one entry in local cache
 *   2. Duplicate signal ID → Supabase insert called only once
 *   3. Different IDs → all entries present
 *   4. Different IDs sharing jobId/type are distinct events and both stored
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock (for SupabaseTimelineRepository) ───────────────────────────

const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn() }))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: mockInsert,
    }),
  },
}))

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: vi.fn(),
  enqueuePendingMutation: vi.fn(),
  hasPendingMutationForEntity: vi.fn().mockReturnValue(false),
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

// ── Imports ──────────────────────────────────────────────────────────────────

import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import { SupabaseTimelineRepository } from '../../src/lib/timeline/repository/SupabaseTimelineRepository'
import type { ProjectTimelineSignal } from '../../src/lib/timeline/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSignal(id: string, jobId = 'job-1', occurredAt = 1000): ProjectTimelineSignal {
  return { id, jobId, type: 'job_created', occurredAt }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Sub-block 1.5 — Timeline ID Dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInsert.mockReturnValue(Promise.resolve({ error: null }))
  })

  // ── InMemoryTimelineRepository ────────────────────────────────────────────

  describe('InMemoryTimelineRepository.add()', () => {
    it('duplicate signal ID → only one entry in cache', () => {
      const repo = new InMemoryTimelineRepository()
      const signal = makeSignal('sig-1')

      repo.add(signal)
      repo.add(signal)

      expect(repo.getAll()).toHaveLength(1)
    })

    it('duplicate signal ID → subscriber notified only once', () => {
      const repo = new InMemoryTimelineRepository()
      const signal = makeSignal('sig-2')
      let count = 0
      repo.subscribe(() => { count++ })

      repo.add(signal)
      repo.add(signal)

      expect(count).toBe(1)
    })

    it('two different IDs → both entries present', () => {
      const repo = new InMemoryTimelineRepository()

      repo.add(makeSignal('sig-a', 'job-1', 1000))
      repo.add(makeSignal('sig-b', 'job-1', 2000))

      expect(repo.getAll()).toHaveLength(2)
    })

    it('different IDs with same jobId and type are both stored', () => {
      const repo = new InMemoryTimelineRepository()

      repo.add(makeSignal('sig-x', 'job-2', 1000))
      repo.add(makeSignal('sig-y', 'job-2', 2000))

      const all = repo.getAll()
      expect(all).toHaveLength(2)
      expect(all.map((s) => s.id)).toContain('sig-x')
      expect(all.map((s) => s.id)).toContain('sig-y')
    })

    it('returned list is sorted by occurredAt', () => {
      const repo = new InMemoryTimelineRepository()

      repo.add(makeSignal('sig-late', 'job-1', 3000))
      repo.add(makeSignal('sig-early', 'job-1', 1000))

      const ids = repo.getAll().map((s) => s.id)
      expect(ids).toEqual(['sig-early', 'sig-late'])
    })
  })

  // ── SupabaseTimelineRepository ────────────────────────────────────────────

  describe('SupabaseTimelineRepository.add()', () => {
    it('duplicate signal ID → only one entry in local cache', () => {
      const repo = new SupabaseTimelineRepository()
      const signal = makeSignal('sig-1')

      repo.add(signal)
      repo.add(signal)

      expect(repo.getAll()).toHaveLength(1)
    })

    it('duplicate signal ID → Supabase insert called only once', () => {
      const repo = new SupabaseTimelineRepository()
      const signal = makeSignal('sig-2')

      repo.add(signal)
      repo.add(signal)

      expect(mockInsert).toHaveBeenCalledTimes(1)
    })

    it('two different IDs → both inserted locally and into Supabase', () => {
      const repo = new SupabaseTimelineRepository()

      repo.add(makeSignal('sig-a', 'job-1', 1000))
      repo.add(makeSignal('sig-b', 'job-1', 2000))

      expect(repo.getAll()).toHaveLength(2)
      expect(mockInsert).toHaveBeenCalledTimes(2)
    })

    it('different IDs with same jobId and type are both stored', () => {
      const repo = new SupabaseTimelineRepository()

      repo.add(makeSignal('sig-x', 'job-2', 1000))
      repo.add(makeSignal('sig-y', 'job-2', 2000))

      expect(repo.getAll()).toHaveLength(2)
      expect(mockInsert).toHaveBeenCalledTimes(2)
    })
  })
})
