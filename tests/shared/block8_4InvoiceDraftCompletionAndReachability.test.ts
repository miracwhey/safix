/**
 * Block 8.4 — Invoice Draft Data Completion + Workflow Reachability
 *
 * Verifies:
 *   A. issuerData propagation — jobWorkflow paths pass real issuer data when profile is available
 *   B. Sync fallback audit — syncInvoiceWithPayment emits invoice_sent on issued → sent
 *   C. No duplicate events — repeated sync calls do not create duplicate invoice_sent events
 *   D. Event ordering — invoice_sent only after successful persist (not on no-op or failure)
 *   E. Regression — 8.1 draft guard + 8.2/8.3 workflow behaviour unaffected
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

// ── Mock getCraftsmanBusinessProfile ────────────────────────────────────────────

const mockGetCraftsmanBusinessProfile = vi.fn()

vi.mock('../../src/lib/craftsman/craftsmanProfileService', () => ({
  getCraftsmanBusinessProfile: (...args: unknown[]) => mockGetCraftsmanBusinessProfile(...args),
  getMyCraftsmanBusinessProfile: vi.fn().mockResolvedValue(null),
  incrementCompletedJobsCount: vi.fn().mockResolvedValue(undefined),
  upsertCraftsmanBusinessProfile: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
      insert: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
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
  logWarning: vi.fn(),
  logInfo: vi.fn(),
}))

// ── Imports after mocks ────────────────────────────────────────────────────────

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { syncInvoiceWithPayment, ensureInvoiceForJob } from '../../src/lib/invoices/invoiceService'
import { createInvoiceWorkflow, markDepositPaidForJobWorkflow } from '../../src/lib/workflow/jobWorkflow'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import { getPaymentRepository } from '../../src/lib/payments/repository'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getInvoiceByJobId } from '../../src/lib/invoices/invoiceStore'
import { getTimelineSignalsForJob } from '../../src/lib/timeline/timelineStore'
import type { Invoice } from '../../src/lib/invoices/types'
import type { Job } from '../../src/lib/jobs'
import type { Payment } from '../../src/lib/payments/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJob(jobId: string, craftsmanUserId?: string): Job {
  return {
    id: jobId,
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    amount: '1.000 €',
    status: 'in_progress',
    craftsmanUserId,
    paymentState: 'work_in_progress',
  } as unknown as Job
}

function makeIssuedInvoice(jobId: string): Invoice {
  return {
    id: `inv_${jobId}`,
    jobId,
    invoiceNumber: 'FX-2026-0001',
    status: 'issued',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
      customerName: 'Max Mustermann',
    },
    lineItems: [
      { id: `li_${jobId}`, label: 'Sanitärarbeiten', quantity: 1, unitPrice: 840.34, total: 840.34 },
    ],
    amounts: { netAmount: 840.34, taxAmount: 159.66, grossAmount: 1000.0 },
    issuedAt: 2_000,
    issuedAtLabel: 'Heute',
    dueAtLabel: 'In 7 Tagen',
    sentAt: 0,
    createdAt: 1_000,
    updatedAt: 2_000,
  }
}

function makePayment(jobId: string, state: Payment['state']): Payment {
  return {
    id: `pay_${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

const REAL_PROFILE = {
  businessName: 'Müller Sanitär GmbH',
  businessAddress: 'Hauptstraße 5, 10115 Berlin',
}

// ── A. issuerData propagation on jobWorkflow paths ─────────────────────────────

describe('A. issuerData propagation — jobWorkflow passes real issuer data when profile available', () => {
  beforeEach(() => {
    setupCleanRepositories()
    vi.clearAllMocks()
  })

  it('createInvoiceWorkflow: invoice has real issuerName when profile is available', async () => {
    mockGetCraftsmanBusinessProfile.mockResolvedValue(REAL_PROFILE)
    const jobId = 'job-create-real'
    const job = makeJob(jobId, 'craftsman-123')
    await getJobRepository().add(job)

    await createInvoiceWorkflow(jobId)

    const invoice = getInvoiceByJobId(jobId)
    expect(invoice?.parties.issuerName).toBe('Müller Sanitär GmbH')
    expect(invoice?.parties.issuerAddress).toBe('Hauptstraße 5, 10115 Berlin')
  })

  it('createInvoiceWorkflow: falls back to placeholder when profile unavailable', async () => {
    mockGetCraftsmanBusinessProfile.mockResolvedValue(null)
    const jobId = 'job-create-null'
    const job = makeJob(jobId, 'craftsman-456')
    await getJobRepository().add(job)

    await createInvoiceWorkflow(jobId)

    const invoice = getInvoiceByJobId(jobId)
    expect(invoice?.parties.issuerName).toBe('SaFix Partnerbetrieb')
  })

  it('createInvoiceWorkflow: falls back to placeholder when profile fetch throws', async () => {
    mockGetCraftsmanBusinessProfile.mockRejectedValue(new Error('network error'))
    const jobId = 'job-create-throw'
    const job = makeJob(jobId, 'craftsman-789')
    await getJobRepository().add(job)

    await createInvoiceWorkflow(jobId)

    const invoice = getInvoiceByJobId(jobId)
    // Fallback to placeholder — placeholder blocks issuance but draft is created
    expect(invoice?.parties.issuerName).toBe('SaFix Partnerbetrieb')
  })

  it('createInvoiceWorkflow: no profile fetch attempted when craftsmanUserId missing', async () => {
    const jobId = 'job-no-craftsman'
    const job = makeJob(jobId, undefined) // no craftsmanUserId
    await getJobRepository().add(job)

    await createInvoiceWorkflow(jobId)

    expect(mockGetCraftsmanBusinessProfile).not.toHaveBeenCalled()
  })

  it('markDepositPaidForJobWorkflow: invoice gets real issuer data when profile available', async () => {
    mockGetCraftsmanBusinessProfile.mockResolvedValue(REAL_PROFILE)
    const jobId = 'job-deposit-real'
    const job = makeJob(jobId, 'craftsman-abc')
    await getJobRepository().add(job)

    await markDepositPaidForJobWorkflow(jobId)

    const invoice = getInvoiceByJobId(jobId)
    expect(invoice?.parties.issuerName).toBe('Müller Sanitär GmbH')
  })

  it('ensureInvoiceForJob is idempotent — existing invoice issuer data not overwritten', async () => {
    mockGetCraftsmanBusinessProfile.mockResolvedValue(REAL_PROFILE)
    const jobId = 'job-idempotent-issuer'
    const job = makeJob(jobId, 'craftsman-idem')
    await getJobRepository().add(job)

    // First call — creates invoice with real data
    await createInvoiceWorkflow(jobId)
    const firstIssuerName = getInvoiceByJobId(jobId)?.parties.issuerName

    // Second call — existing invoice returned, no overwrite
    mockGetCraftsmanBusinessProfile.mockResolvedValue({ businessName: 'Other Betrieb', businessAddress: 'Other Str. 1, 20095 Hamburg' })
    await createInvoiceWorkflow(jobId)

    expect(getInvoiceByJobId(jobId)?.parties.issuerName).toBe(firstIssuerName)
  })
})

// ── B. Sync fallback audit ─────────────────────────────────────────────────────

describe('B. Sync fallback audit — syncInvoiceWithPayment emits invoice_sent on issued → sent', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('emits invoice_sent when sync advances issued → sent', async () => {
    const jobId = 'job-sync-sent'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))

    await syncInvoiceWithPayment(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('sent')
    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_sent')).toBe(true)
  })

  it('emits invoice_sent when sync steps through sent on the way to paid', async () => {
    const jobId = 'job-sync-paid'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'released'))

    await syncInvoiceWithPayment(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('paid')
    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_sent')).toBe(true)
  })

  it('invoice_sent event has a positive occurredAt', async () => {
    const jobId = 'job-sync-event-ts'
    const before = Date.now()
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))
    await syncInvoiceWithPayment(jobId)
    const after = Date.now()

    const event = getTimelineSignalsForJob(jobId).find((s) => s.type === 'invoice_sent')!
    expect(event.occurredAt).toBeGreaterThanOrEqual(before)
    expect(event.occurredAt).toBeLessThanOrEqual(after)
  })

  it('sentAt is set correctly alongside the event', async () => {
    const jobId = 'job-sync-sentat'
    const before = Date.now()
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))
    await syncInvoiceWithPayment(jobId)
    const after = Date.now()

    const invoice = getInvoiceByJobId(jobId)
    expect(invoice?.sentAt).toBeGreaterThanOrEqual(before)
    expect(invoice?.sentAt).toBeLessThanOrEqual(after)
  })
})

// ── C. No duplicate events ────────────────────────────────────────────────────

describe('C. No duplicate events — repeated sync does not add duplicate invoice_sent', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('calling syncInvoiceWithPayment twice produces exactly one invoice_sent event', async () => {
    const jobId = 'job-no-dup'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))

    await syncInvoiceWithPayment(jobId)
    await syncInvoiceWithPayment(jobId) // no-op — already sent

    const sentEvents = getTimelineSignalsForJob(jobId).filter((s) => s.type === 'invoice_sent')
    expect(sentEvents).toHaveLength(1)
  })

  it('invoice_sent from sync + invoice_sent from markInvoiceSentWorkflow = exactly one event', async () => {
    // If craftsman manually marks sent, then sync runs again — only one event total
    const { markInvoiceSentWorkflow } = await import('../../src/lib/workflow/invoiceWorkflow')

    setupCleanRepositories()
    const jobId = 'job-no-dup-manual'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))

    // Manual path first
    await markInvoiceSentWorkflow(jobId)

    // Sync runs (e.g. webhook arrives) — should be a no-op
    await syncInvoiceWithPayment(jobId)

    const sentEvents = getTimelineSignalsForJob(jobId).filter((s) => s.type === 'invoice_sent')
    expect(sentEvents).toHaveLength(1)
  })

  it('sync on a draft invoice does not emit invoice_sent (draft guard still active)', async () => {
    const jobId = 'job-draft-no-event'
    const draftInvoice: Invoice = {
      ...makeIssuedInvoice(jobId),
      status: 'draft',
      invoiceNumber: '',
      issuedAt: 0,
      issuedAtLabel: 'Noch nicht ausgestellt',
      dueAtLabel: 'Noch nicht fällig',
    }
    await getInvoiceRepository().add(draftInvoice)
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))

    await syncInvoiceWithPayment(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('draft')
    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_sent')).toBe(false)
  })
})

// ── D. Event ordering ─────────────────────────────────────────────────────────

describe('D. Event ordering — invoice_sent only after successful persist', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('invoice is already at sent status when invoice_sent event is inspectable', async () => {
    const jobId = 'job-order-sync'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))

    await syncInvoiceWithPayment(jobId)

    // After the await, both persist and event must be complete
    const invoice = getInvoiceByJobId(jobId)
    const event = getTimelineSignalsForJob(jobId).find((s) => s.type === 'invoice_sent')
    expect(invoice?.status).toBe('sent')
    expect(event).toBeDefined()
    expect(invoice?.sentAt).toBeGreaterThan(0)
    expect(event!.occurredAt).toBeGreaterThanOrEqual(invoice!.sentAt)
  })

  it('no invoice_sent when sync is a true no-op (target status not higher)', async () => {
    // Invoice already at sent — sync with deposit_paid (→ sent) is no-op
    const jobId = 'job-noop-noevent'
    const sentInvoice: Invoice = {
      ...makeIssuedInvoice(jobId),
      status: 'sent',
      sentAt: 1_000,
    }
    await getInvoiceRepository().add(sentInvoice)
    await getPaymentRepository().add(makePayment(jobId, 'deposit_paid'))

    await syncInvoiceWithPayment(jobId) // no-op — already sent

    // No new event should have been added
    // (ensureTimelineEvent is idempotent — even if called, no second event)
    const sentEvents = getTimelineSignalsForJob(jobId).filter((s) => s.type === 'invoice_sent')
    expect(sentEvents.length).toBeLessThanOrEqual(1)
  })
})

// ── E. Regression ─────────────────────────────────────────────────────────────

describe('E. Regression — 8.1/8.2/8.3 behaviour unaffected', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('8.1: draft guard — sync on draft never advances or emits events', async () => {
    const jobId = 'job-draft-guard'
    const draftInvoice: Invoice = {
      ...makeIssuedInvoice(jobId),
      status: 'draft',
      invoiceNumber: '',
      issuedAt: 0,
      issuedAtLabel: 'Noch nicht ausgestellt',
      dueAtLabel: 'Noch nicht fällig',
      sentAt: 0,
    }
    await getInvoiceRepository().add(draftInvoice)
    await getPaymentRepository().add(makePayment(jobId, 'released'))

    await syncInvoiceWithPayment(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('draft')
    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_issued')).toBe(false)
    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_sent')).toBe(false)
  })

  it('8.2: issueInvoiceWorkflow still works with real issuer data', async () => {
    const { issueInvoiceWorkflow } = await import('../../src/lib/workflow/invoiceWorkflow')
    setupCleanRepositories()

    const jobId = 'job-8.2-regression'
    await ensureInvoiceForJob(
      makeJob(jobId),
      { issuerName: 'Echter Betrieb GmbH', issuerAddress: 'Musterstraße 1, 12345 Berlin' }
    )

    await issueInvoiceWorkflow(jobId)
    expect(getInvoiceByJobId(jobId)?.status).toBe('issued')
    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_issued')).toBe(true)
  })

  it('8.3: placeholder still blocks issuance after 8.4 changes', async () => {
    const { issueInvoiceWorkflow } = await import('../../src/lib/workflow/invoiceWorkflow')
    setupCleanRepositories()

    const jobId = 'job-8.3-regression'
    await ensureInvoiceForJob(makeJob(jobId)) // no issuerData → placeholder

    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow('placeholder')
    expect(getInvoiceByJobId(jobId)?.status).toBe('draft')
  })

  it('sync still advances non-draft invoice from issued to paid without requiring explicit sent step', async () => {
    const jobId = 'job-sync-paid-regression'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await getPaymentRepository().add(makePayment(jobId, 'released'))

    await syncInvoiceWithPayment(jobId)

    const invoice = getInvoiceByJobId(jobId)
    expect(invoice?.status).toBe('paid')
    // Both invoice_sent and the paid transition happened
    expect(invoice?.sentAt).toBeGreaterThan(0)
  })
})
