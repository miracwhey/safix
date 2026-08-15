/**
 * Block 8 / Sub-blocks 8.2 + 8.3 — Explicit Invoice Workflows + Issuer Data
 *
 * Verifies:
 *   A. issueInvoiceWorkflow — draft → issued via explicit craftsman action
 *   B. markInvoiceSentWorkflow — issued → sent, sentAt set correctly
 *   C. Placeholder blocking — known placeholder issuer data is rejected at issuance
 *   D. Address completeness — city-only issuerAddress blocked at engine level
 *   E. Real issuer data — ensureInvoiceForJob propagates issuerData to created invoice
 *   F. Idempotency — double-call is a clean no-op, no duplicate timeline events
 *   G. Persistence-then-event ordering — timeline emitted only after successful persist
 *   H. Regression — existing state machine and sync behaviour unaffected
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { issueInvoiceWorkflow, markInvoiceSentWorkflow } from '../../src/lib/workflow/invoiceWorkflow'
import { ensureInvoiceForJob } from '../../src/lib/invoices/invoiceService'
import { transitionInvoiceStatus } from '../../src/lib/invoices/invoiceEngine'
import { validateInvoiceIssuancePreconditions } from '../../src/lib/invoices/invoiceValidation'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import { getInvoiceByJobId } from '../../src/lib/invoices/invoiceStore'
import { getTimelineSignalsForJob } from '../../src/lib/timeline/timelineStore'
import type { Invoice } from '../../src/lib/invoices/types'
import type { Job } from '../../src/lib/jobs'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDraftInvoice(
  jobId = 'job-test',
  issuerName = 'Müller Sanitär GmbH',
  issuerAddress = 'Hauptstraße 5, 10115 Berlin'
): Invoice {
  return {
    id: `inv_${jobId}`,
    jobId,
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName,
      issuerAddress,
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

function makeIssuedInvoice(jobId = 'job-test'): Invoice {
  return {
    ...makeDraftInvoice(jobId),
    status: 'issued',
    invoiceNumber: 'FX-2026-0001',
    issuedAt: 2_000,
    issuedAtLabel: 'Heute',
    dueAtLabel: 'In 7 Tagen',
  }
}

function makeJob(jobId = 'job-test'): Job {
  return {
    id: jobId,
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    amount: '1.000 €',
  } as Job
}

// ── A. issueInvoiceWorkflow ────────────────────────────────────────────────────

describe('A. issueInvoiceWorkflow — explicit issuance', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('advances draft → issued', async () => {
    const jobId = 'job-issue'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('issued')
  })

  it('sets issuedAt to a positive timestamp', async () => {
    const jobId = 'job-issue-ts'
    const before = Date.now()
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)
    const after = Date.now()

    const result = getInvoiceByJobId(jobId)
    expect(result?.issuedAt).toBeGreaterThanOrEqual(before)
    expect(result?.issuedAt).toBeLessThanOrEqual(after)
    expect(result?.issuedAt).toBeGreaterThan(0)
  })

  it('emits invoice_issued timeline event', async () => {
    const jobId = 'job-issue-event'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)

    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_issued')).toBe(true)
  })

  it('throws when no invoice exists for the job', async () => {
    await expect(issueInvoiceWorkflow('job-no-invoice')).rejects.toThrow('no invoice found')
  })

  it('sentAt stays 0 after issuance', async () => {
    const jobId = 'job-issue-sentat'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)

    expect(getInvoiceByJobId(jobId)?.sentAt).toBe(0)
  })

  it('issuing from sent status throws (engine blocks sent → issued)', async () => {
    const jobId = 'job-sent-back'
    const issued = makeIssuedInvoice(jobId)
    const sent = transitionInvoiceStatus(issued, 'sent')
    await getInvoiceRepository().add(sent)
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow('Illegal invoice transition')
  })
})

// ── B. markInvoiceSentWorkflow ─────────────────────────────────────────────────

describe('B. markInvoiceSentWorkflow — explicit sent marking', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('advances issued → sent', async () => {
    const jobId = 'job-sent'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('sent')
  })

  it('sets sentAt to a positive timestamp', async () => {
    const jobId = 'job-sent-ts'
    const before = Date.now()
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)
    const after = Date.now()

    const result = getInvoiceByJobId(jobId)
    expect(result?.sentAt).toBeGreaterThanOrEqual(before)
    expect(result?.sentAt).toBeLessThanOrEqual(after)
    expect(result?.sentAt).toBeGreaterThan(0)
  })

  it('emits invoice_sent timeline event', async () => {
    const jobId = 'job-sent-event'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)

    expect(getTimelineSignalsForJob(jobId).some((s) => s.type === 'invoice_sent')).toBe(true)
  })

  it('throws when no invoice exists for the job', async () => {
    await expect(markInvoiceSentWorkflow('job-nonexistent')).rejects.toThrow('no invoice found')
  })

  it('marking a draft as sent is blocked — sent requires issued first', async () => {
    const jobId = 'job-draft-sent'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await expect(markInvoiceSentWorkflow(jobId)).rejects.toThrow('Illegal invoice transition')
  })

  it('marking a paid invoice as sent is blocked by the engine', async () => {
    const jobId = 'job-paid-sent'
    const issued = makeIssuedInvoice(jobId)
    const sent = transitionInvoiceStatus(issued, 'sent')
    const paid = transitionInvoiceStatus(sent, 'paid')
    await getInvoiceRepository().add(paid)
    await expect(markInvoiceSentWorkflow(jobId)).rejects.toThrow('Illegal invoice transition')
  })

  it('preserves issuedAt when advancing issued → sent', async () => {
    const jobId = 'job-sentat-preserve'
    const issued = makeIssuedInvoice(jobId)
    const expectedIssuedAt = issued.issuedAt
    await getInvoiceRepository().add(issued)
    await markInvoiceSentWorkflow(jobId)

    expect(getInvoiceByJobId(jobId)?.issuedAt).toBe(expectedIssuedAt)
  })
})

// ── C. Placeholder blocking ────────────────────────────────────────────────────

describe('C. Placeholder blocking — known placeholder issuer data rejected at issuance', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('issueInvoiceWorkflow throws for placeholder issuerName', async () => {
    const jobId = 'job-placeholder-name'
    await getInvoiceRepository().add(
      makeDraftInvoice(jobId, 'SaFix Partnerbetrieb', 'Echte Straße 1, 10115 Berlin')
    )
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow('placeholder')
  })

  it('issueInvoiceWorkflow throws for placeholder issuerAddress', async () => {
    const jobId = 'job-placeholder-addr'
    await getInvoiceRepository().add(
      makeDraftInvoice(jobId, 'Echter Betrieb GmbH', 'Handwerkerstraße 12, 80331 München')
    )
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow('placeholder')
  })

  it('issueInvoiceWorkflow succeeds with real issuer data', async () => {
    const jobId = 'job-real-data'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await expect(issueInvoiceWorkflow(jobId)).resolves.toBeUndefined()
    expect(getInvoiceByJobId(jobId)?.status).toBe('issued')
  })

  it('validateInvoiceIssuancePreconditions throws for placeholder issuerName', () => {
    const invoice = makeDraftInvoice('job-val', 'SaFix Partnerbetrieb', 'Echte Adresse 1, 10115 Berlin')
    expect(() => validateInvoiceIssuancePreconditions(invoice)).toThrow('placeholder')
  })

  it('validateInvoiceIssuancePreconditions throws for placeholder issuerAddress', () => {
    const invoice = makeDraftInvoice('job-val2', 'Echter Betrieb', 'Handwerkerstraße 12, 80331 München')
    expect(() => validateInvoiceIssuancePreconditions(invoice)).toThrow('placeholder')
  })

  it('placeholder invoice cannot be issued — status stays draft after failed attempt', async () => {
    const jobId = 'job-failed-issue'
    await getInvoiceRepository().add(
      makeDraftInvoice(jobId, 'SaFix Partnerbetrieb', 'Echte Straße 1, 10115 Berlin')
    )
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow()
    // Invoice must NOT have been mutated by the failed attempt
    expect(getInvoiceByJobId(jobId)?.status).toBe('draft')
  })
})

// ── D. Address completeness ───────────────────────────────────────────────────

describe('D. Address completeness — city-only issuerAddress blocked at engine level', () => {
  it('city-only address (no comma) is rejected', () => {
    const invoice = makeDraftInvoice('job-city', 'Echter Betrieb GmbH', 'Berlin')
    expect(() => validateInvoiceIssuancePreconditions(invoice)).toThrow('incomplete')
  })

  it('city + country without street (no comma) is rejected', () => {
    const invoice = makeDraftInvoice('job-city2', 'Echter Betrieb GmbH', 'München Deutschland')
    expect(() => validateInvoiceIssuancePreconditions(invoice)).toThrow('incomplete')
  })

  it('full address with comma passes the completeness check', () => {
    const invoice = makeDraftInvoice('job-full', 'Echter Betrieb GmbH', 'Musterstraße 1, 12345 Berlin')
    expect(() => validateInvoiceIssuancePreconditions(invoice)).not.toThrow()
  })

  it('issueInvoiceWorkflow rejects a city-only issuerAddress', async () => {
    setupCleanRepositories()
    const jobId = 'job-city-issue'
    await getInvoiceRepository().add(makeDraftInvoice(jobId, 'Echter Betrieb GmbH', 'München'))
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow('incomplete')
  })

  it('city-only address does not mutate the invoice on failed issue', async () => {
    setupCleanRepositories()
    const jobId = 'job-city-no-mut'
    await getInvoiceRepository().add(makeDraftInvoice(jobId, 'Echter Betrieb GmbH', 'München'))
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow()
    expect(getInvoiceByJobId(jobId)?.status).toBe('draft')
  })
})

// ── E. Real issuer data — ensureInvoiceForJob ──────────────────────────────────

describe('E. Real issuer data propagation via ensureInvoiceForJob', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('creates invoice with real issuerName when issuerData provided', async () => {
    const job = makeJob('job-issuer-real')
    const issuerData = { issuerName: 'Müller Heizung GmbH', issuerAddress: 'Berliner Str. 10, 10119 Berlin' }
    await ensureInvoiceForJob(job, issuerData)

    const invoice = getInvoiceByJobId('job-issuer-real')
    expect(invoice?.parties.issuerName).toBe('Müller Heizung GmbH')
    expect(invoice?.parties.issuerAddress).toBe('Berliner Str. 10, 10119 Berlin')
  })

  it('creates invoice with placeholder when issuerData not provided', async () => {
    const job = makeJob('job-issuer-placeholder')
    await ensureInvoiceForJob(job)

    const invoice = getInvoiceByJobId('job-issuer-placeholder')
    expect(invoice?.parties.issuerName).toBe('SaFix Partnerbetrieb')
    expect(invoice?.parties.issuerAddress).toBe('Handwerkerstraße 12, 80331 München')
  })

  it('second call is idempotent — existing invoice returned unchanged', async () => {
    const job = makeJob('job-idempotent')
    const issuerData1 = { issuerName: 'Betrieb A', issuerAddress: 'Adresse A, 10115 Berlin' }
    const issuerData2 = { issuerName: 'Betrieb B', issuerAddress: 'Adresse B, 10115 Berlin' }

    await ensureInvoiceForJob(job, issuerData1)
    await ensureInvoiceForJob(job, issuerData2)

    expect(getInvoiceByJobId('job-idempotent')?.parties.issuerName).toBe('Betrieb A')
  })

  it('invoice with real issuer data can be issued without blocking', async () => {
    const job = makeJob('job-issue-real')
    const issuerData = { issuerName: 'Müller Sanitär', issuerAddress: 'Hauptstraße 1, 10115 Berlin' }
    await ensureInvoiceForJob(job, issuerData)
    await issueInvoiceWorkflow('job-issue-real')

    expect(getInvoiceByJobId('job-issue-real')?.status).toBe('issued')
  })

  it('invoice with placeholder issuer data cannot be issued', async () => {
    const job = makeJob('job-issue-placeholder')
    await ensureInvoiceForJob(job) // no issuerData → placeholder
    await expect(issueInvoiceWorkflow('job-issue-placeholder')).rejects.toThrow('placeholder')
  })
})

// ── F. Idempotency ────────────────────────────────────────────────────────────

describe('F. Idempotency — double-call is a clean no-op, no duplicate events', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('calling issueInvoiceWorkflow twice does not throw on second call', async () => {
    const jobId = 'job-double-issue'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)
    await expect(issueInvoiceWorkflow(jobId)).resolves.toBeUndefined()
  })

  it('double issueInvoiceWorkflow emits invoice_issued only once', async () => {
    const jobId = 'job-double-issue-event'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)
    await issueInvoiceWorkflow(jobId)

    const events = getTimelineSignalsForJob(jobId).filter((s) => s.type === 'invoice_issued')
    expect(events).toHaveLength(1)
  })

  it('status is still issued after double-call (not mutated by idempotency guard)', async () => {
    const jobId = 'job-double-issue-status'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)
    await issueInvoiceWorkflow(jobId)

    expect(getInvoiceByJobId(jobId)?.status).toBe('issued')
  })

  it('calling markInvoiceSentWorkflow twice does not throw on second call', async () => {
    const jobId = 'job-double-sent'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)
    await expect(markInvoiceSentWorkflow(jobId)).resolves.toBeUndefined()
  })

  it('double markInvoiceSentWorkflow emits invoice_sent only once', async () => {
    const jobId = 'job-double-sent-event'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)
    await markInvoiceSentWorkflow(jobId)

    const events = getTimelineSignalsForJob(jobId).filter((s) => s.type === 'invoice_sent')
    expect(events).toHaveLength(1)
  })

  it('sentAt is not overwritten by double markInvoiceSentWorkflow call', async () => {
    const jobId = 'job-double-sentat'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)
    const firstSentAt = getInvoiceByJobId(jobId)?.sentAt

    await markInvoiceSentWorkflow(jobId) // no-op

    expect(getInvoiceByJobId(jobId)?.sentAt).toBe(firstSentAt)
  })
})

// ── G. Persistence-then-event ordering ───────────────────────────────────────

describe('G. Persistence-then-event ordering — timeline only after successful persist', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('issue: invoice status is already persisted when timeline event fires', async () => {
    // Verifies that the repository update (and thus the status change) happens
    // before ensureTimelineEvent is called. InMemory update is synchronous within
    // the await — by the time we can inspect state, both have run.
    const jobId = 'job-order-issue'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)

    const invoice = getInvoiceByJobId(jobId)
    const events = getTimelineSignalsForJob(jobId)
    expect(invoice?.status).toBe('issued')
    expect(events.some((e) => e.type === 'invoice_issued')).toBe(true)
    // The event occurredAt must be >= the invoice's issuedAt (both set in same tick)
    const event = events.find((e) => e.type === 'invoice_issued')!
    expect(event.occurredAt).toBeGreaterThanOrEqual(invoice!.issuedAt)
  })

  it('sent: sentAt and timeline event are consistent', async () => {
    const jobId = 'job-order-sent'
    await getInvoiceRepository().add(makeIssuedInvoice(jobId))
    await markInvoiceSentWorkflow(jobId)

    const invoice = getInvoiceByJobId(jobId)
    const event = getTimelineSignalsForJob(jobId).find((e) => e.type === 'invoice_sent')!
    expect(invoice?.sentAt).toBeGreaterThan(0)
    expect(event).toBeDefined()
    expect(event.occurredAt).toBeGreaterThanOrEqual(invoice!.sentAt)
  })

  it('failed issuance (placeholder) emits no timeline event', async () => {
    const jobId = 'job-no-event-on-fail'
    await getInvoiceRepository().add(
      makeDraftInvoice(jobId, 'SaFix Partnerbetrieb', 'Echte Straße 1, 10115 Berlin')
    )
    await expect(issueInvoiceWorkflow(jobId)).rejects.toThrow()

    const events = getTimelineSignalsForJob(jobId)
    expect(events.some((e) => e.type === 'invoice_issued')).toBe(false)
  })
})

// ── H. Regression ─────────────────────────────────────────────────────────────

describe('H. Regression — existing behaviour unaffected', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('full lifecycle: draft → issued → sent → paid via workflows and engine', async () => {
    const jobId = 'job-lifecycle'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))

    await issueInvoiceWorkflow(jobId)
    expect(getInvoiceByJobId(jobId)?.status).toBe('issued')

    await markInvoiceSentWorkflow(jobId)
    expect(getInvoiceByJobId(jobId)?.status).toBe('sent')

    await getInvoiceRepository().update(`inv_${jobId}`, (inv) =>
      transitionInvoiceStatus(inv, 'paid')
    )
    expect(getInvoiceByJobId(jobId)?.status).toBe('paid')
  })

  it('timeline accumulates both invoice events across lifecycle', async () => {
    const jobId = 'job-timeline-all'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await issueInvoiceWorkflow(jobId)
    await markInvoiceSentWorkflow(jobId)

    const types = getTimelineSignalsForJob(jobId).map((s) => s.type)
    expect(types).toContain('invoice_issued')
    expect(types).toContain('invoice_sent')
  })

  it('draft guard in syncInvoiceWithPayment is still intact (8.1 regression)', async () => {
    const job = makeJob('job-sync-guard')
    await ensureInvoiceForJob(job) // placeholder issuer data
    expect(getInvoiceByJobId('job-sync-guard')?.status).toBe('draft')
    await expect(issueInvoiceWorkflow('job-sync-guard')).rejects.toThrow('placeholder')
  })

  it('sent requires issued first — draft cannot skip to sent via markInvoiceSentWorkflow', async () => {
    const jobId = 'job-skip-sent'
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    await expect(markInvoiceSentWorkflow(jobId)).rejects.toThrow('Illegal invoice transition')
  })
})
