/**
 * Hydration Gate — TimelineRepository
 *
 * Verifies that addTimelineEvent() and ensureTimelineEvent() are fail-closed
 * when the timeline repository is not yet hydrated. An unhydrated repository
 * must never be queried or written to — doing so could silently interpret
 * "no events loaded yet" as "no events exist", producing duplicate writes on
 * re-hydration or losing events permanently.
 *
 * Covers:
 *   A. addTimelineEvent() skips write and logs warning when unhydrated
 *   B. addTimelineEvent() writes correctly when hydrated
 *   C. ensureTimelineEvent() skips write and logs warning when unhydrated
 *   D. ensureTimelineEvent() writes correctly when hydrated
 *   E. ensureTimelineEvent() is idempotent when hydrated and event exists
 *   F. No regression: in-memory repository (isHydrated = true) is unaffected
 */

// ── Mocks must come before imports ──────────────────────────────────────────

const mockLogWarning = vi.fn()

vi.mock('../../src/lib/observability', () => ({
  logWarning: (...args: unknown[]) => mockLogWarning(...args),
  logError: vi.fn(),
  logInfo: vi.fn(),
}))

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { addTimelineEvent, ensureTimelineEvent } from '../../src/lib/timeline/timelineService'
import { setTimelineRepository } from '../../src/lib/timeline/repository'
import { InMemoryTimelineRepository } from '../../src/lib/timeline/repository/InMemoryTimelineRepository'
import type { TimelineRepository } from '../../src/lib/timeline/repository/TimelineRepository'
import type { ProjectTimelineEventType, ProjectTimelineSignal } from '../../src/lib/timeline/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSignal(
  jobId: string,
  type: ProjectTimelineEventType,
  id = `timeline-${jobId}-${type}`
): ProjectTimelineSignal {
  return { id, jobId, type, occurredAt: Date.now() }
}

/**
 * A timeline repository stub whose hydrated state can be toggled.
 * Tracks add() calls to verify write behavior.
 */
class ControllableTimelineRepository implements TimelineRepository {
  private _hydrated: boolean
  readonly addCalls: ProjectTimelineSignal[] = []
  private signals: ProjectTimelineSignal[] = []
  private readonly listeners = new Set<() => void>()

  constructor(hydrated: boolean) {
    this._hydrated = hydrated
  }

  setHydrated(value: boolean): void {
    this._hydrated = value
  }

  async initialize(): Promise<void> {}

  isHydrated(): boolean {
    return this._hydrated
  }

  notify(): void {
    this.listeners.forEach((l) => l())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getAll(): ProjectTimelineSignal[] {
    return [...this.signals]
  }

  getForJob(jobId: string): ProjectTimelineSignal[] {
    return this.signals.filter((s) => s.jobId === jobId)
  }

  hasEventOfType(jobId: string, type: ProjectTimelineEventType): boolean {
    return this.signals.some((s) => s.jobId === jobId && s.type === type)
  }

  add(signal: ProjectTimelineSignal): void {
    this.addCalls.push(signal)
    this.signals = [...this.signals, signal]
    this.notify()
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Timeline hydration gate', () => {
  let repo: ControllableTimelineRepository

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new ControllableTimelineRepository(false)
    setTimelineRepository(repo)
  })

  afterEach(() => {
    // Restore in-memory repo so other tests are unaffected
    setTimelineRepository(new InMemoryTimelineRepository())
  })

  // ── A. addTimelineEvent — unhydrated ────────────────────────────────────────

  describe('A. addTimelineEvent() when repository is unhydrated', () => {
    it('does not call add() on the repository', () => {
      const signal = makeSignal('job-1', 'payment_released')
      addTimelineEvent(signal)
      expect(repo.addCalls).toHaveLength(0)
    })

    it('logs timeline.add.skipped_unhydrated warning', () => {
      const signal = makeSignal('job-1', 'payment_released')
      addTimelineEvent(signal)
      expect(mockLogWarning).toHaveBeenCalledWith(
        'timeline.add.skipped_unhydrated',
        expect.objectContaining({ jobId: 'job-1', type: 'payment_released' })
      )
    })

    it('does not throw', () => {
      const signal = makeSignal('job-1', 'job_completed')
      expect(() => addTimelineEvent(signal)).not.toThrow()
    })
  })

  // ── B. addTimelineEvent — hydrated ──────────────────────────────────────────

  describe('B. addTimelineEvent() when repository is hydrated', () => {
    beforeEach(() => {
      repo.setHydrated(true)
    })

    it('calls add() on the repository', () => {
      const signal = makeSignal('job-2', 'payment_released')
      addTimelineEvent(signal)
      expect(repo.addCalls).toHaveLength(1)
      expect(repo.addCalls[0]).toMatchObject({ jobId: 'job-2', type: 'payment_released' })
    })

    it('does not log a warning', () => {
      addTimelineEvent(makeSignal('job-2', 'payment_released'))
      expect(mockLogWarning).not.toHaveBeenCalled()
    })
  })

  // ── C. ensureTimelineEvent — unhydrated ─────────────────────────────────────

  describe('C. ensureTimelineEvent() when repository is unhydrated', () => {
    it('does not call add() on the repository', () => {
      ensureTimelineEvent({ jobId: 'job-3', type: 'job_completed' })
      expect(repo.addCalls).toHaveLength(0)
    })

    it('logs timeline.ensure.skipped_unhydrated warning', () => {
      ensureTimelineEvent({ jobId: 'job-3', type: 'job_completed' })
      expect(mockLogWarning).toHaveBeenCalledWith(
        'timeline.ensure.skipped_unhydrated',
        expect.objectContaining({ jobId: 'job-3', type: 'job_completed' })
      )
    })

    it('does not read hasEventOfType when unhydrated', () => {
      // hasEventOfType on an unhydrated repo would wrongly return false,
      // treating "not loaded" as "does not exist" — the guard prevents this
      const hasEventSpy = vi.spyOn(repo, 'hasEventOfType')
      ensureTimelineEvent({ jobId: 'job-3', type: 'job_completed' })
      expect(hasEventSpy).not.toHaveBeenCalled()
    })

    it('does not throw', () => {
      expect(() =>
        ensureTimelineEvent({ jobId: 'job-3', type: 'job_completed' })
      ).not.toThrow()
    })
  })

  // ── D. ensureTimelineEvent — hydrated ───────────────────────────────────────

  describe('D. ensureTimelineEvent() when repository is hydrated', () => {
    beforeEach(() => {
      repo.setHydrated(true)
    })

    it('calls add() when event does not exist', () => {
      ensureTimelineEvent({ jobId: 'job-4', type: 'payment_released' })
      expect(repo.addCalls).toHaveLength(1)
      expect(repo.addCalls[0]).toMatchObject({ jobId: 'job-4', type: 'payment_released' })
    })

    it('does not log a warning', () => {
      ensureTimelineEvent({ jobId: 'job-4', type: 'payment_released' })
      expect(mockLogWarning).not.toHaveBeenCalled()
    })
  })

  // ── E. ensureTimelineEvent — idempotent when hydrated ───────────────────────

  describe('E. ensureTimelineEvent() is idempotent when event already exists', () => {
    beforeEach(() => {
      repo.setHydrated(true)
    })

    it('does not add a second event when the same type already exists', () => {
      ensureTimelineEvent({ jobId: 'job-5', type: 'job_completed' })
      ensureTimelineEvent({ jobId: 'job-5', type: 'job_completed' })
      expect(repo.addCalls).toHaveLength(1)
    })

    it('adds for a different job even if same type exists for another', () => {
      ensureTimelineEvent({ jobId: 'job-5', type: 'job_completed' })
      ensureTimelineEvent({ jobId: 'job-6', type: 'job_completed' })
      expect(repo.addCalls).toHaveLength(2)
    })
  })

  // ── F. No regression for InMemoryTimelineRepository ─────────────────────────

  describe('F. InMemoryTimelineRepository (always hydrated) is unaffected', () => {
    beforeEach(() => {
      setTimelineRepository(new InMemoryTimelineRepository())
    })

    it('addTimelineEvent writes without warning', () => {
      const signal = makeSignal('job-mem', 'payment_released')
      addTimelineEvent(signal)
      expect(mockLogWarning).not.toHaveBeenCalled()
    })

    it('ensureTimelineEvent writes without warning', () => {
      ensureTimelineEvent({ jobId: 'job-mem', type: 'job_completed' })
      expect(mockLogWarning).not.toHaveBeenCalled()
    })
  })
})
