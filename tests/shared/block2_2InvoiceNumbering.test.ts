/**
 * Sub-block 2.2 — Sequential Invoice Numbers
 *
 * Verifies:
 *   A. Draft invoices carry no number (invoiceNumber = '')
 *   B. InMemoryInvoiceRepository assigns a sequential number on draft → issued
 *   C. Number format matches FX-YYYY-NNNN
 *   D. Numbers are unique and monotonically increasing
 *   E. Already-assigned numbers are not re-assigned on further updates
 *   F. SupabaseInvoiceRepository re-reads the DB-assigned number after issued update
 *   G. Regression — 2.4 validation still passes with empty invoiceNumber
 *   H. No Math.random()-based path remains active (engine never generates a number)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Supabase mock ─────────────────────────────────────────────────────────────

const { mockUpdateEq, mockSelectNumberSingle } = vi.hoisted(() => ({
  mockUpdateEq: vi.fn(),
  mockSelectNumberSingle: vi.fn(),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockImplementation((fields: string) => {
        if (fields === 'invoice_number') {
          // Re-read path after issued transition
          return {
            eq: vi.fn().mockReturnValue({
              single: mockSelectNumberSingle,
            }),
          }
        }
        // initialize() path — select('*')
        return {
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        }
      }),
      update: vi.fn().mockReturnValue({
        eq: mockUpdateEq,
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
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
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { InMemoryInvoiceRepository } from '../../src/lib/invoices/repository/InMemoryInvoiceRepository'
import { SupabaseInvoiceRepository } from '../../src/lib/invoices/repository/SupabaseInvoiceRepository'
import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import { createInvoiceFromJob } from '../../src/lib/invoices/invoiceEngine'
import type { Invoice } from '../../src/lib/invoices/types'
import type { Job } from '../../src/lib/jobs'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssuableDraft(id = 'inv_job-1', jobId = 'job-1'): Invoice {
  return {
    id,
    jobId,
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: 'Testbetrieb GmbH',
      issuerAddress: 'Musterstraße 1, 12345 Berlin',
      customerName: 'Max Mustermann',
    },
    lineItems: [
      { id: `li_${jobId}`, label: 'Sanitärarbeiten', quantity: 1, unitPrice: 840.34, total: 840.34 },
    ],
    amounts: { netAmount: 840.34, taxAmount: 159.66, grossAmount: 1000.0 },
    issuedAt: 0,
    issuedAtLabel: 'Noch nicht ausgestellt',
    dueAtLabel: 'Noch nicht fällig',
    sentAt: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function makeJob(id = 'job-1'): Job {
  return {
    id,
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    amount: '1.000 €',
  } as Job
}

// ── A. Draft invoices carry no number ────────────────────────────────────────

describe('Sub-block 2.2 — Sequential Invoice Numbers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUpdateEq.mockResolvedValue({ error: null })
    mockSelectNumberSingle.mockResolvedValue({
      data: { invoice_number: 'FX-2026-0001' },
      error: null,
    })
  })

  describe('A. Draft invoices carry no invoice number', () => {
    it('createInvoiceFromJob produces a draft with invoiceNumber = ""', () => {
      const invoice = createInvoiceFromJob(makeJob())
      expect(invoice.status).toBe('draft')
      expect(invoice.invoiceNumber).toBe('')
    })

    it('makeIssuableDraft fixture has invoiceNumber = ""', () => {
      expect(makeIssuableDraft().invoiceNumber).toBe('')
    })
  })

  // ── B. InMemory assigns sequential number on issued transition ────────────

  describe('B. InMemoryInvoiceRepository — number assigned on draft → issued', () => {
    it('number is assigned when update() produces an issued invoice', async () => {
      const repo = new InMemoryInvoiceRepository([])
      const draft = makeIssuableDraft()
      await repo.add(draft)

      await repo.update(draft.id, (inv) => transitionInvoiceStatus(inv, 'issued'))

      const all = repo.getAll()
      expect(all[0].invoiceNumber).not.toBe('')
      expect(all[0].invoiceNumber).toBeTruthy()
    })

    it('number is NOT assigned for non-issued transitions', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())

      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'cancelled'))

      expect(repo.getAll()[0].invoiceNumber).toBe('')
    })
  })

  // ── C. Format matches FX-YYYY-NNNN ───────────────────────────────────────

  describe('C. Invoice number format', () => {
    it('number matches FX-YYYY-NNNN pattern', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const number = repo.getAll()[0].invoiceNumber
      expect(number).toMatch(/^FX-\d{4}-\d{4}$/)
    })

    it('year segment matches current year', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const number = repo.getAll()[0].invoiceNumber
      const year = new Date().getFullYear().toString()
      expect(number).toContain(`FX-${year}-`)
    })

    it('sequence segment is zero-padded to 4 digits', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const number = repo.getAll()[0].invoiceNumber
      const seq = number.split('-')[2]
      expect(seq).toHaveLength(4)
      expect(Number(seq)).toBeGreaterThan(0)
    })
  })

  // ── D. Unique and monotonically increasing numbers ────────────────────────

  describe('D. Numbers are unique and monotonically increasing', () => {
    it('two invoices in the same repository get different numbers', async () => {
      const repo = new InMemoryInvoiceRepository([])
      const draft1 = makeIssuableDraft('inv_job-1', 'job-1')
      const draft2 = makeIssuableDraft('inv_job-2', 'job-2')

      await repo.add(draft1)
      await repo.add(draft2)
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))
      await repo.update('inv_job-2', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const invoices = repo.getAll()
      const n1 = invoices.find((i) => i.id === 'inv_job-1')!.invoiceNumber
      const n2 = invoices.find((i) => i.id === 'inv_job-2')!.invoiceNumber

      expect(n1).not.toBe(n2)
    })

    it('second number has a higher sequence value than the first', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft('inv_job-1', 'job-1'))
      await repo.add(makeIssuableDraft('inv_job-2', 'job-2'))
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))
      await repo.update('inv_job-2', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const invoices = repo.getAll()
      const seq = (id: string) =>
        Number(invoices.find((i) => i.id === id)!.invoiceNumber.split('-')[2])

      expect(seq('inv_job-2')).toBeGreaterThan(seq('inv_job-1'))
    })

    it('a fresh repository instance starts its counter at 1', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const number = repo.getAll()[0].invoiceNumber
      expect(number.endsWith('-0001')).toBe(true)
    })
  })

  // ── E. Already-assigned numbers are stable ────────────────────────────────

  describe('E. Assigned numbers are not re-assigned on further updates', () => {
    it('issued → sent does not change the invoiceNumber', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const numberAfterIssued = repo.getAll()[0].invoiceNumber

      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'sent'))

      expect(repo.getAll()[0].invoiceNumber).toBe(numberAfterIssued)
    })

    it('sent → paid does not change the invoiceNumber', async () => {
      const repo = new InMemoryInvoiceRepository([])
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'sent'))

      const numberAfterSent = repo.getAll()[0].invoiceNumber

      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'paid'))

      expect(repo.getAll()[0].invoiceNumber).toBe(numberAfterSent)
    })
  })

  // ── F. SupabaseInvoiceRepository re-reads number after issued update ──────

  describe('F. SupabaseInvoiceRepository — re-reads DB-assigned number after issued', () => {
    it('after issued update, local cache contains the DB-assigned number', async () => {
      mockSelectNumberSingle.mockResolvedValueOnce({
        data: { invoice_number: 'FX-2026-0001' },
        error: null,
      })

      const repo = new SupabaseInvoiceRepository()
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      const invoice = repo.getAll().find((i) => i.id === 'inv_job-1')!
      expect(invoice.invoiceNumber).toBe('FX-2026-0001')
    })

    it('re-read select is called when transitioning to issued', async () => {
      const repo = new SupabaseInvoiceRepository()
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'issued'))

      expect(mockSelectNumberSingle).toHaveBeenCalledTimes(1)
    })

    it('re-read select is NOT called for non-issued transitions', async () => {
      const repo = new SupabaseInvoiceRepository()
      await repo.add(makeIssuableDraft())
      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'cancelled'))

      expect(mockSelectNumberSingle).not.toHaveBeenCalled()
    })

    it('re-read select is NOT called for already-issued → sent transition', async () => {
      mockSelectNumberSingle.mockResolvedValueOnce({
        data: { invoice_number: 'FX-2026-0001' },
        error: null,
      })

      const repo = new SupabaseInvoiceRepository()
      // Add an already-issued invoice (no re-read needed for non-draft→issued)
      const issued: Invoice = { ...makeIssuableDraft(), status: 'issued', invoiceNumber: 'FX-2026-0001', issuedAt: 1_000 }
      await repo.add(issued)
      vi.clearAllMocks()
      mockUpdateEq.mockResolvedValue({ error: null })

      await repo.update('inv_job-1', (inv) => transitionInvoiceStatus(inv, 'sent'))

      expect(mockSelectNumberSingle).not.toHaveBeenCalled()
    })
  })

  // ── G. Regression — 2.4 validation still works ───────────────────────────

  describe('G. 2.4 precondition validation regression', () => {
    it('empty invoiceNumber does not block issuance (validation does not check it)', () => {
      const invoice = makeIssuableDraft()
      expect(invoice.invoiceNumber).toBe('')
      // Should not throw — number is an output, not a precondition
      expect(() => transitionInvoiceStatus(invoice, 'issued')).not.toThrow()
    })

    it('missing issuerAddress still blocks issuance', () => {
      const invoice = makeIssuableDraft()
      const bad = {
        ...invoice,
        parties: { ...invoice.parties, issuerAddress: '' },
      }
      expect(() => transitionInvoiceStatus(bad, 'issued')).toThrow(/issuerAddress/)
    })
  })

  // ── H. Engine never generates a number ───────────────────────────────────

  describe('H. Engine does not generate invoice numbers', () => {
    it('transitionInvoiceStatus does not assign invoiceNumber (stays empty for draft → issued)', () => {
      const draft = makeIssuableDraft()
      const result = transitionInvoiceStatus(draft, 'issued')
      // The engine returns the invoice with the same (empty) invoiceNumber.
      // Number assignment is the repository's responsibility.
      expect(result.invoiceNumber).toBe('')
    })

    it('no Math.random() in the transition output', () => {
      // Verifies the engine result is stable / deterministic across calls
      const draft = makeIssuableDraft()
      const r1 = transitionInvoiceStatus(draft, 'issued')
      const r2 = transitionInvoiceStatus(draft, 'issued')
      // Both should have the same invoiceNumber (empty — not random)
      expect(r1.invoiceNumber).toBe(r2.invoiceNumber)
      expect(r1.invoiceNumber).toBe('')
    })
  })
})
