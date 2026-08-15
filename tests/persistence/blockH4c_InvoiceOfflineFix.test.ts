/**
 * Block H-4c — Invoice Offline Fix: Codex-Findings P1 + P2 + P3
 *
 * P1 — Server-side INSERT conflicts (Postgres 23xxx / 42xxx) must NEVER be
 *      queued. The flush path replays with upsert — queuing would silently
 *      overwrite an existing invoice's authoritative state on next sync.
 *      23505 (duplicate key) additionally reloads the DB-authoritative version.
 *
 * P2 — update() must throw when a pending INSERT exists for the same invoice.
 *      The DB row does not exist yet, so UPDATE is a silent no-op and the
 *      assign_invoice_number DB trigger would not fire.
 *
 * P3 — Queued draft inserts must be hydrated into the local cache during
 *      loadForUser() so that drafts created offline remain visible after app
 *      restart even when the DB row has not been written yet.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { mockInsert, mockUpdateEq, mockSelectSingle, mockSelectAll } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockUpdateEq: vi.fn(),
  mockSelectSingle: vi.fn(),
  mockSelectAll: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockImplementation(() => ({
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => mockSelectAll()),
        eq: vi.fn().mockReturnValue({ single: vi.fn().mockImplementation(() => mockSelectSingle()) }),
      })),
      insert: mockInsert,
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockImplementation(() => mockUpdateEq()) }),
    })),
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'uid-1' } } },
      }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    // R4: loadForUser now opens a realtime channel for live invoice status.
    channel: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis(),
    }),
    removeChannel: vi.fn().mockResolvedValue(undefined),
  },
}))

// ── Persistence mock ──────────────────────────────────────────────────────────

const mockEnqueue = vi.fn()
const mockRecordFailure = vi.fn()
let pendingByEntity: Map<string, boolean>
let pendingMutations: unknown[]

vi.mock('../../src/lib/persistence', () => ({
  recordPersistenceFailure: (...args: unknown[]) => mockRecordFailure(...args),
  enqueuePendingMutation: (...args: unknown[]) => mockEnqueue(...args),
  hasPendingMutationForEntity: (_table: string, entityId: string) =>
    pendingByEntity.get(entityId) ?? false,
  getPendingMutations: () => pendingMutations,
}))

vi.mock('../../src/lib/observability', () => ({ logError: vi.fn(), logWarning: vi.fn() }))

// ── Imports ───────────────────────────────────────────────────────────────────

import { SupabaseInvoiceRepository } from '../../src/lib/invoices/repository/SupabaseInvoiceRepository'
import type { Invoice } from '../../src/lib/invoices/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

function makeDraftRow(draft: Invoice): Record<string, unknown> {
  return {
    id: draft.id,
    job_id: draft.jobId,
    invoice_number: draft.invoiceNumber,
    status: draft.status,
    parties: draft.parties,
    line_items: draft.lineItems,
    amounts: draft.amounts,
    issued_at: draft.issuedAt,
    issued_at_label: draft.issuedAtLabel,
    due_at_label: draft.dueAtLabel,
    sent_at: draft.sentAt,
    created_at: draft.createdAt,
    updated_at: draft.updatedAt,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Block H-4c — Invoice Offline Fix', () => {
  let repo: SupabaseInvoiceRepository

  beforeEach(() => {
    vi.clearAllMocks()
    pendingByEntity = new Map()
    pendingMutations = []
    mockSelectAll.mockResolvedValue({ data: [], error: null })
    mockUpdateEq.mockResolvedValue({ error: null })
    repo = new SupabaseInvoiceRepository()
  })

  // ── P1: Server-side INSERT conflicts ─────────────────────────────────────

  describe('P1 — server-side INSERT conflicts never queued', () => {
    it('23505 duplicate key: rolls back cache, never enqueues, never throws', async () => {
      const draft = makeDraft()
      mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key value' } })
      // Reload path: DB returns the existing invoice
      const dbVersion: Invoice = { ...draft, invoiceNumber: 'FX-2026-0001', status: 'issued' }
      mockSelectSingle.mockResolvedValueOnce({ data: makeDraftRow(dbVersion), error: null })

      await expect(repo.add(draft)).resolves.toBeUndefined()

      expect(mockEnqueue).not.toHaveBeenCalled()
      // Cache must contain the DB-authoritative version, not the local draft
      const cached = repo.getAll().find((inv) => inv.id === draft.id)
      expect(cached).toBeDefined()
      expect(cached!.status).toBe('issued')
    })

    it('23505: optimistic entry rolled back before reload', async () => {
      const draft = makeDraft()
      mockInsert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key value' } })
      // Reload returns nothing (race condition: row deleted between insert and read)
      mockSelectSingle.mockResolvedValueOnce({ data: null, error: null })

      const notified: Invoice[][] = []
      repo.subscribe(() => notified.push(repo.getAll()))

      await repo.add(draft)

      // At some point the cache must have been rolled back (empty)
      const wasRolledBack = notified.some((snap) => !snap.some((inv) => inv.id === draft.id))
      expect(wasRolledBack).toBe(true)
      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('other 23xxx (FK violation): rolls back, records failure under invoices, throws', async () => {
      const draft = makeDraft()
      const fkError = { code: '23503', message: 'FK constraint violation' }
      mockInsert.mockResolvedValueOnce({ error: fkError })

      await expect(repo.add(draft)).rejects.toBeDefined()

      expect(mockEnqueue).not.toHaveBeenCalled()
      expect(mockRecordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'invoices', operation: 'add', entityId: draft.id }),
      )
      // Rolled back: invoice removed from cache
      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(false)
    })

    it('42xxx schema error: never queued, throws', async () => {
      const draft = makeDraft()
      mockInsert.mockResolvedValueOnce({ error: { code: '42703', message: 'column does not exist' } })

      await expect(repo.add(draft)).rejects.toBeDefined()

      expect(mockEnqueue).not.toHaveBeenCalled()
    })

    it('transient/network error: still enqueued under invoices/draft', async () => {
      const draft = makeDraft()
      mockInsert.mockResolvedValueOnce({ error: { message: 'network timeout' } })

      await repo.add(draft)

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ domain: 'invoices/draft', table: 'invoices', entityId: draft.id }),
      )
    })
  })

  // ── P2: update() blocks on pending INSERT ────────────────────────────────

  describe('P2 — update() throws when pending INSERT exists', () => {
    it('throws descriptive error when pending mutation exists for the invoice', async () => {
      const draft = makeDraft()
      pendingByEntity.set(draft.id, true)

      await expect(
        repo.update(draft.id, (inv) => ({ ...inv, status: 'issued' as const })),
      ).rejects.toThrow(/cannot be updated/)
    })

    it('error message includes the invoice ID', async () => {
      const draft = makeDraft('inv-xyz')
      pendingByEntity.set(draft.id, true)

      await expect(
        repo.update(draft.id, (inv) => inv),
      ).rejects.toThrow('inv-xyz')
    })

    it('update() succeeds once pending mutation is cleared', async () => {
      const draft = makeDraft()
      mockInsert.mockResolvedValueOnce({ error: null })
      await repo.add(draft)

      // Pending flag not set → update must proceed
      await expect(
        repo.update(draft.id, (inv) => ({ ...inv, status: 'cancelled' as const })),
      ).resolves.toBeUndefined()

      expect(repo.getAll().find((inv) => inv.id === draft.id)!.status).toBe('cancelled')
    })
  })

  // ── P3: hydrateFromQueue on loadForUser ───────────────────────────────────

  describe('P3 — queued drafts hydrated into cache on loadForUser', () => {
    it('pending insert for own uid materializes into cache after initialize()', async () => {
      const draft = makeDraft()
      pendingMutations = [
        {
          table: 'invoices',
          operation: 'insert',
          entityId: draft.id,
          userId: 'uid-1',
          payload: makeDraftRow(draft),
        },
      ]
      // DB returns nothing (row not yet written)
      mockSelectAll.mockResolvedValueOnce({ data: [], error: null })

      await repo.initialize()

      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(true)
    })

    it('pending insert for different uid is NOT hydrated', async () => {
      const draft = makeDraft()
      pendingMutations = [
        {
          table: 'invoices',
          operation: 'insert',
          entityId: draft.id,
          userId: 'uid-other',
          payload: makeDraftRow(draft),
        },
      ]
      mockSelectAll.mockResolvedValueOnce({ data: [], error: null })

      await repo.initialize()

      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(false)
    })

    it('pending insert with no userId is hydrated (userId absent = any session)', async () => {
      const draft = makeDraft()
      pendingMutations = [
        {
          table: 'invoices',
          operation: 'insert',
          entityId: draft.id,
          // no userId field
          payload: makeDraftRow(draft),
        },
      ]
      mockSelectAll.mockResolvedValueOnce({ data: [], error: null })

      await repo.initialize()

      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(true)
    })

    it('pending insert skipped when entity already returned by DB', async () => {
      const draft = makeDraft()
      pendingMutations = [
        {
          table: 'invoices',
          operation: 'insert',
          entityId: draft.id,
          userId: 'uid-1',
          payload: makeDraftRow(draft),
        },
      ]
      // DB already has the row
      mockSelectAll.mockResolvedValueOnce({ data: [makeDraftRow(draft)], error: null })

      await repo.initialize()

      // Only one copy in cache (no duplicate)
      expect(repo.getAll().filter((inv) => inv.id === draft.id).length).toBe(1)
    })

    it('pending update mutations are ignored by hydration (insert-only)', async () => {
      const draft = makeDraft()
      pendingMutations = [
        {
          table: 'invoices',
          operation: 'update',
          entityId: draft.id,
          userId: 'uid-1',
          payload: makeDraftRow(draft),
        },
      ]
      mockSelectAll.mockResolvedValueOnce({ data: [], error: null })

      await repo.initialize()

      // update mutations do not create new cache entries
      expect(repo.getAll().some((inv) => inv.id === draft.id)).toBe(false)
    })

    it('malformed payload in queue does not crash repository load', async () => {
      pendingMutations = [
        {
          table: 'invoices',
          operation: 'insert',
          entityId: 'inv-corrupt',
          userId: 'uid-1',
          payload: { bad: 'data', no_id: true },
        },
      ]
      mockSelectAll.mockResolvedValueOnce({ data: [], error: null })

      await expect(repo.initialize()).resolves.toBeUndefined()
      expect(repo.isHydrated()).toBe(true)
    })
  })
})
