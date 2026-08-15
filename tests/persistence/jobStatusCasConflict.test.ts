/**
 * H12 — jobs.status compare-and-set (CAS) write path.
 *
 * `updateJobStatus` pre-validates transitions against the LOCAL cache; before
 * H12 the repository then wrote blindly (`UPDATE … WHERE id = ?`), so a stale
 * cache could clobber a row another writer (stripe-webhook, cron
 * reconciliation, second device) had already moved on — including OUT of a
 * terminal status. The repository now re-checks the expected status in the
 * WHERE clause (`.eq('status', expectedStatus)`).
 *
 * Verified here:
 *   1. CAS conflict (0 rows matched) → JobStatusCasConflictError, cache
 *      rolled back, NOT enqueued for offline replay (a full-row replay would
 *      bypass the CAS), NOT recorded as a persistence failure (interactive
 *      error → UI, not SyncStatusBar).
 *   2. CAS success (1 row matched) → resolves, no enqueue, cache keeps update.
 *   3. DB error on the CAS write (transient network error OR 23514 from the
 *      new jobs_terminal_status_guard trigger) → rollback +
 *      recordPersistenceFailure + throw, but NEVER enqueued: the
 *      pending-mutation replay runs `update().eq('id', …)` WITHOUT the
 *      status predicate, so a queued CAS payload would later apply as a
 *      blind full-row write and bypass the CAS (MED-1 repair).
 *   4. update() WITHOUT expectedStatus → exact legacy chain (no .select(),
 *      error → enqueue).  classifyFailure still maps 23514 →
 *      'business-rejected' so a replayed non-CAS queue entry is dropped
 *      permanently (no endless SyncStatusBar loop).
 *   5. InMemoryJobRepository parity: stale expectedStatus throws without
 *      mutation or notify.
 *   6. updateJobStatus wires { expectedStatus: current.status } through to
 *      the repository.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────
//
// `update().eq('id')` must be BOTH awaitable (legacy non-CAS path) and
// chainable via `.eq('status').select('id')` (CAS path).

const { mockCasSelect, mockLegacyUpdate, mockSecondEq } = vi.hoisted(() => ({
  mockCasSelect: vi.fn(),
  mockLegacyUpdate: vi.fn(),
  mockSecondEq: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockImplementation(() => ({
          // CAS path: .eq('status', expected).select('id')
          eq: mockSecondEq.mockImplementation(() => ({
            select: vi.fn().mockImplementation(() => mockCasSelect()),
          })),
          // Legacy path: awaited directly after .eq('id', …)
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve(mockLegacyUpdate()).then(resolve, reject),
        })),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })),
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
const mockRecordFailure = vi.fn()

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...args),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: () => false,
  getPendingMutationOperation: () => undefined,
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

vi.mock('../../src/lib/observability', () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarning: vi.fn(),
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { SupabaseJobRepository } from '../../src/lib/jobs/repository/SupabaseJobRepository'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import { JobStatusCasConflictError } from '../../src/lib/jobs/repository/JobRepository'
import { setJobRepository } from '../../src/lib/jobs/repository'
import { updateJobStatus } from '../../src/lib/jobs/service'
import {
  classifyFailure,
  isPermanentKind,
  isRetryableKind,
} from '../../src/lib/persistence/classifyFailure'
import type { Job } from '../../src/lib/jobs/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-cas-1',
    projectId: '',
    title: 'CAS-Testauftrag',
    customer: 'Testkunde',
    location: 'Hannover',
    dateLabel: 'Heute',
    status: 'in_progress',
    amount: '1.000 €',
    description: 'Testbeschreibung',
    paymentState: 'in_escrow',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  }
}

const TERMINAL_TRIGGER_ERROR = {
  code: '23514',
  message:
    'terminal_status_immutable: job job-cas-1 cannot leave terminal status completed (attempted in_progress)',
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockCasSelect.mockReset()
  mockLegacyUpdate.mockReset()
  mockSecondEq.mockClear()
  mockEnqueue.mockReset()
  mockRecordFailure.mockReset()

  mockCasSelect.mockResolvedValue({ data: [{ id: 'job-cas-1' }], error: null })
  mockLegacyUpdate.mockResolvedValue({ error: null })
})

function makeSupabaseRepoWithJob(job: Job): SupabaseJobRepository {
  const repo = new SupabaseJobRepository()
  // @ts-expect-error — inject cache directly, bypassing initialize()
  repo['jobs'] = [job]
  return repo
}

// ── SupabaseJobRepository — CAS write path ────────────────────────────────────

describe('SupabaseJobRepository.update() with expectedStatus (CAS)', () => {
  it('CAS conflict (0 rows): throws JobStatusCasConflictError, no enqueue, no persistence failure, cache rolled back', async () => {
    mockCasSelect.mockResolvedValueOnce({ data: [], error: null })
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))

    await expect(
      repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
        expectedStatus: 'in_progress',
      }),
    ).rejects.toMatchObject({
      name: 'JobStatusCasConflictError',
      isJobStatusCasConflict: true,
    })

    // KEIN Voll-Row-Replay — würde den CAS umgehen und neuere Rows clobbern.
    expect(mockEnqueue).not.toHaveBeenCalled()
    // Interaktive Aktion — Fehler gehört der UI, nicht der SyncStatusBar.
    expect(mockRecordFailure).not.toHaveBeenCalled()
    // Optimistic update muss zurückgerollt sein.
    expect(repo.getById('job-cas-1')?.status).toBe('in_progress')
  })

  it('CAS conflict notifies subscribers of the rollback', async () => {
    mockCasSelect.mockResolvedValueOnce({ data: [], error: null })
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))
    const listener = vi.fn()
    repo.subscribe(listener)

    await expect(
      repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
        expectedStatus: 'in_progress',
      }),
    ).rejects.toBeInstanceOf(JobStatusCasConflictError)

    // Optimistic notify + rollback notify
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('CAS success (1 row): resolves, no enqueue, cache keeps the update', async () => {
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))

    await repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
      expectedStatus: 'in_progress',
    })

    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(mockRecordFailure).not.toHaveBeenCalled()
    expect(repo.getById('job-cas-1')?.status).toBe('waiting_payment')
    // CAS predicate was actually sent
    expect(mockSecondEq).toHaveBeenCalledWith('status', 'in_progress')
  })

  it('transient DB error on CAS write: rollback + recordFailure + throw, NO enqueue (no blind full-row replay)', async () => {
    // MED-1 repair: the replay path (flushPendingMutations) executes
    // `update().eq('id', …)` WITHOUT the status predicate.  Enqueueing a
    // failed CAS write would therefore replay it as an unconditional
    // full-row write — exactly the clobber H12 closed.
    const NETWORK_ERROR = { message: 'TypeError: Failed to fetch' }
    mockCasSelect.mockResolvedValueOnce({ data: null, error: NETWORK_ERROR })
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))

    await expect(
      repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
        expectedStatus: 'in_progress',
      }),
    ).rejects.toMatchObject({ message: 'TypeError: Failed to fetch' })

    // KEIN Enqueue — der Replay kann das CAS-Praedikat nicht tragen.
    expect(mockEnqueue).not.toHaveBeenCalled()
    // Observability bleibt: der Fehler wird als Persistence-Failure erfasst.
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'jobs', operation: 'update', entityId: 'job-cas-1' }),
    )
    expect(repo.getById('job-cas-1')?.status).toBe('in_progress')
  })

  it('DB error on CAS write (trigger 23514): rollback + recordFailure + throw, NO enqueue', async () => {
    mockCasSelect.mockResolvedValueOnce({ data: null, error: TERMINAL_TRIGGER_ERROR })
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))

    await expect(
      repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
        expectedStatus: 'in_progress',
      }),
    ).rejects.toMatchObject({ code: '23514' })

    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'jobs', operation: 'update', entityId: 'job-cas-1' }),
    )
    // Auch permanente Trigger-Rejects werden im CAS-Pfad nicht enqueued —
    // ein Replay wuerde ohne Praedikat laufen und ist nicht garantiert,
    // erneut mit 23514 zu scheitern (DB-Zustand kann sich geaendert haben).
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(repo.getById('job-cas-1')?.status).toBe('in_progress')
  })

  it('transient DB error on CAS write notifies subscribers of the rollback', async () => {
    mockCasSelect.mockResolvedValueOnce({
      data: null,
      error: { message: 'network request failed' },
    })
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))
    const listener = vi.fn()
    repo.subscribe(listener)

    await expect(
      repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
        expectedStatus: 'in_progress',
      }),
    ).rejects.toBeDefined()

    // Optimistic notify + rollback notify
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('update() WITHOUT expectedStatus keeps the exact legacy chain (no .select, error → enqueue)', async () => {
    mockLegacyUpdate.mockResolvedValueOnce({ error: { message: 'network error' } })
    const repo = makeSupabaseRepoWithJob(makeJob({ status: 'in_progress' }))

    await expect(
      repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' })),
    ).rejects.toBeDefined()

    // Legacy offline-queue UX unchanged
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'update', table: 'jobs', entityId: 'job-cas-1' }),
    )
    expect(mockRecordFailure).toHaveBeenCalled()
    // The CAS-only `.eq('status', …).select('id')` continuation never ran
    expect(mockCasSelect).not.toHaveBeenCalled()
    expect(repo.getById('job-cas-1')?.status).toBe('in_progress')
  })
})

// ── classifyFailure coupling — trigger rejects must drop permanently ─────────

describe('classifyFailure × jobs_terminal_status_guard (23514)', () => {
  it("maps code 23514 to 'business-rejected' (permanent, non-retryable)", () => {
    const kind = classifyFailure(TERMINAL_TRIGGER_ERROR)
    expect(kind).toBe('business-rejected')
    expect(isRetryableKind(kind)).toBe(false)
    expect(isPermanentKind(kind)).toBe(true)
  })
})

// ── InMemoryJobRepository parity ──────────────────────────────────────────────

describe('InMemoryJobRepository.update() CAS parity', () => {
  it('stale expectedStatus throws JobStatusCasConflictError without mutation or notify', async () => {
    const repo = new InMemoryJobRepository([makeJob({ status: 'completed' })])
    const listener = vi.fn()
    repo.subscribe(listener)
    const updater = vi.fn((job: Job) => ({ ...job, status: 'in_progress' as const }))

    await expect(
      repo.update('job-cas-1', updater, { expectedStatus: 'in_progress' }),
    ).rejects.toBeInstanceOf(JobStatusCasConflictError)

    expect(updater).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(repo.getById('job-cas-1')?.status).toBe('completed')
  })

  it('matching expectedStatus applies the update', async () => {
    const repo = new InMemoryJobRepository([makeJob({ status: 'in_progress' })])

    await repo.update('job-cas-1', (job) => ({ ...job, status: 'waiting_payment' }), {
      expectedStatus: 'in_progress',
    })

    expect(repo.getById('job-cas-1')?.status).toBe('waiting_payment')
  })

  it('update without options keeps legacy behavior (no CAS check)', async () => {
    const repo = new InMemoryJobRepository([makeJob({ status: 'in_progress' })])

    await repo.update('job-cas-1', (job) => ({ ...job, title: 'Umbenannt' }))

    expect(repo.getById('job-cas-1')?.title).toBe('Umbenannt')
  })
})

// ── Service wiring — updateJobStatus passes expectedStatus through ───────────

describe('updateJobStatus → repository CAS wiring', () => {
  it('passes { expectedStatus: current.status } as third argument to repo.update', async () => {
    const repo = new InMemoryJobRepository([makeJob({ status: 'in_progress' })])
    setJobRepository(repo)
    const updateSpy = vi.spyOn(repo, 'update')

    await updateJobStatus('job-cas-1', 'waiting_payment')

    expect(updateSpy).toHaveBeenCalledWith(
      'job-cas-1',
      expect.any(Function),
      { expectedStatus: 'in_progress' },
    )
  })

  it('happy path stays green: status transition is applied', async () => {
    const repo = new InMemoryJobRepository([makeJob({ status: 'in_progress' })])
    setJobRepository(repo)

    await updateJobStatus('job-cas-1', 'waiting_payment')

    expect(repo.getById('job-cas-1')?.status).toBe('waiting_payment')
  })

  it('illegal transitions still reject BEFORE any repository write (terminal status)', async () => {
    const repo = new InMemoryJobRepository([makeJob({ status: 'completed' })])
    setJobRepository(repo)
    const updateSpy = vi.spyOn(repo, 'update')

    await expect(updateJobStatus('job-cas-1', 'in_progress')).rejects.toThrow(
      /Illegal job status transition/,
    )
    expect(updateSpy).not.toHaveBeenCalled()
  })
})
