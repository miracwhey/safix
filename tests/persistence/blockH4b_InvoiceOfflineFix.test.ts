/**
 * Block H-4b — Invoice Offline Fix: Codex-Findings P1 + P2
 *
 * P1 — Invoice UPDATE failures must remain escalatable via the non-queued 'invoices'
 *      domain (15 s age threshold). They must NOT fall under 'invoices/draft' (queued).
 *
 * P2 — When add() short-circuits via the pre-flight guard (draft already queued
 *      from a prior offline session), the invoice must be present in the local cache
 *      and notify() must fire so the UI renders the draft immediately.
 *
 * Also verifies: pre-flight guard prevents a duplicate queue entry.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { mockInsert, mockUpdateEq } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockUpdateEq: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      insert: mockInsert,
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockImplementation(() => mockUpdateEq()) }),
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
  },
}))

// ── Persistence mock ──────────────────────────────────────────────────────────

const mockEnqueue = vi.fn()
const mockRecordFailure = vi.fn()
let pendingByEntity: Map<string, boolean>

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...args),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: (_table: string, entityId: string) =>
    pendingByEntity.get(entityId) ?? false,
  getPendingMutations: () => [],
  isServerSideError: () => false,
  isDuplicateKeyError: () => false,
}))

vi.mock('../../src/lib/observability', () => ({ logError: vi.fn() }))

// ── Imports ───────────────────────────────────────────────────────────────────

import { SupabaseInvoiceRepository } from '../../src/lib/invoices/repository/SupabaseInvoiceRepository'
import type { Invoice } from '../../src/lib/invoices/types'

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeDraft(id = 'inv-1', jobId = 'job-1'): Invoice {
  const now = Date.now()
  return {
    id,
    jobId,
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: 'Testbetrieb GmbH',
      issuerAddress: 'Musterstr. 1, 12345 Berlin',
      customerName: 'Max Mustermann',
    },
    lineItems: [{ id: 'li-1', label: 'Arbeit', quantity: 1, unitPrice: 1000, total: 1000 }],
    amounts: { netAmount: 1000, taxAmount: 190, grossAmount: 1190 },
    issuedAt: 0,
    issuedAtLabel: '',
    dueAtLabel: '',
    sentAt: 0,
    createdAt: now,
    updatedAt: now,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block H-4b — Invoice Offline Fix', () => {
  let repo: SupabaseInvoiceRepository

  beforeEach(() => {
    vi.clearAllMocks()
    pendingByEntity = new Map()
    repo = new SupabaseInvoiceRepository()
  })

  // ── P2: pre-flight guard restores local cache visibility ──────────────────

  describe('P2 — queued draft stays visible in local cache after reload', () => {
    it('adds invoice to cache and notifies when pending mutation exists but entity is not cached', async () => {
      const draft = makeDraft()
      // Simulate: prior offline session queued this draft; DB row doesn't exist yet.
      pendingByEntity.set(draft.id, true)

      const notified: number[] = []
      repo.subscribe(() => notified.push(repo.getAll().length))

      await repo.add(draft)

      // Cache must contain the draft
      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(true)
      // Subscriber must have been notified
      expect(notified.length).toBeGreaterThan(0)
      // No DB write attempted (pending flag = skip)
      expect(mockInsert).not.toHaveBeenCalled()
      // No duplicate queue entry
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('does not duplicate cache entry when pending mutation exists and entity is already cached', async () => {
      const draft = makeDraft()
      // Seed the cache via a successful first add()
      mockInsert.mockResolvedValueOnce({ error: null })
      await repo.add(draft)
      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(true)

      // Now the queue has an entry for this draft (e.g. next flush is pending)
      pendingByEntity.set(draft.id, true)
      const countBefore = repo.getAll().length

      // Second add() — pre-flight triggers, entity already in cache
      await repo.add(draft)

      expect(repo.getAll().length).toBe(countBefore)
      expect(mockEnqueue).not.toHaveBeenCalled()
    })
  })

  // ── P1: add() uses 'invoices/draft', update() uses 'invoices' ─────────────

  describe('P1 — domain split keeps UPDATE failures under non-queued domain', () => {
    it('add() on DB failure records failure under invoices/draft and enqueues under invoices/draft', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'network error' } })
      const draft = makeDraft()
      await repo.add(draft)

      // Failure recorded under 'invoices/draft' (queued domain)
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'invoices/draft', operation: 'add', entityId: draft.id }),
      )
      // Queue entry also under 'invoices/draft'
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'invoices/draft', table: 'invoices', entityId: draft.id }),
      )
    })

    it('update() on DB failure records failure under invoices (non-queued domain)', async () => {
      // Seed the cache so update has an entity to update
      mockInsert.mockResolvedValueOnce({ error: null })
      const draft = makeDraft()
      await repo.add(draft)

      mockUpdateEq.mockResolvedValueOnce({ error: { message: 'network error' } })

      await expect(
        repo.update(draft.id, (inv) => ({ ...inv, status: 'issued' as const })),
      ).rejects.toBeDefined()

      // Failure must be under 'invoices' (non-queued) — NOT 'invoices/draft'
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'invoices', operation: 'update', entityId: draft.id }),
      )
      // No pending mutation enqueued for the update path
      expect(mockEnqueue).not.toHaveBeenCalled()
    })
  })

  // ── P2: no duplicate queue entry on repeated offline add() calls ──────────

  describe('P2 — no duplicate pending mutation on repeated offline add()', () => {
    it('does not enqueue a second mutation when pre-flight guard triggers', async () => {
      mockInsert.mockResolvedValueOnce({ error: { message: 'offline' } })
      const draft = makeDraft()

      // First offline add: fails → enqueues
      await repo.add(draft)
      expect(mockEnqueue).toHaveBeenCalledTimes(1)

      // Simulate: queue now has an entry for this draft
      pendingByEntity.set(draft.id, true)
      mockEnqueue.mockClear()

      // Second add (e.g. createInvoiceWorkflow called again after reload)
      await repo.add(draft)

      // Guard must have fired → no second enqueue
      expect(mockEnqueue).not.toHaveBeenCalled()
      // DB not called again
      expect(mockInsert).toHaveBeenCalledTimes(1)
    })
  })
})
