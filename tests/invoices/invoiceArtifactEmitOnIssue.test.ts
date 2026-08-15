/**
 * Block 2 — Invoice Thread-Artifact: emit-on-issue
 *
 * Verifies that issuing an invoice emits the Rechnung artifact into the
 * customer↔craftsman chat thread. The shared sink is
 * `emitInvoiceArtifactToThread(jobId)` (src/lib/workflow/invoiceWorkflow.ts),
 * reached from BOTH craftsman issue paths:
 *   - issueInvoiceWorkflow            (engine-thin / legacy)
 *   - issueInvoiceWithSnapshotWorkflow (§14 production path)
 *
 * It performs two coordinated writes:
 *   1. persistInvoiceArtifact  → deterministic thread_artifacts record
 *      id `ta_inv_<invoiceId>` (artifactType='invoice', invoiceId set,
 *      phase='issued', snapshotPrice=formatEuro(grossAmount),
 *      snapshotSummary=invoiceNumber, snapshotPhaseLabel='Rechnung gestellt',
 *      customer/craftsmanUserId from the job).
 *   2. sendMessageWorkflow(artifactType='Invoice', clientMessageId
 *      `inv-card-<invoiceId>`) → the artifact_card chat message.
 *
 * The thread is resolved from job.sourceConversationId ONLY — no
 * sourceConversationId means the emit is skipped (no thread_artifacts record).
 *
 * Wiring mirrors tests/shared/block8_2_3InvoiceWorkflowsAndIssuerData.test.ts
 * (setupCleanRepositories) + tests/chat/chatWorkflow.test.ts (InMemoryChat
 * repo + _seedThread). The two §14-snapshot data fetchers (provider profile +
 * customer billing) are genuinely Supabase-backed, so they are mocked for the
 * snapshot path only; the engine-thin path never touches them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mock the two external (Supabase-backed) snapshot data fetchers ──────────
// Used ONLY by issueInvoiceWithSnapshotWorkflow. importOriginal keeps every
// other export intact so the wider module graph is unaffected.
vi.mock('../../src/lib/providers/providerProfileService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/providers/providerProfileService')>()
  return { ...actual, getMyProviderProfile: vi.fn() }
})
vi.mock('../../src/lib/customer/customerBillingProfileService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/customer/customerBillingProfileService')>()
  return { ...actual, getCustomerBillingForInvoice: vi.fn() }
})

import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  issueInvoiceWorkflow,
  issueInvoiceWithSnapshotWorkflow,
} from '../../src/lib/workflow/invoiceWorkflow'
import { getInvoiceRepository } from '../../src/lib/invoices/repository'
import { getInvoiceByJobId } from '../../src/lib/invoices/invoiceStore'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getOfferRepository } from '../../src/lib/offers/repository/registry'
import { getThreadArtifactRepository } from '../../src/lib/messages/repository/threadArtifactRegistry'
import { InMemoryChatRepository } from '../../src/lib/chat/repository/InMemoryChatRepository'
import { setChatRepository } from '../../src/lib/chat/repository/registry'
import { formatEuro } from '../../src/lib/shared/formatters'
import { getMyProviderProfile } from '../../src/lib/providers/providerProfileService'
import { getCustomerBillingForInvoice } from '../../src/lib/customer/customerBillingProfileService'
import type { ProviderProfile } from '../../src/lib/providers/providerProfileService'
import type { ThreadArtifactRecord } from '../../src/lib/messages/threadArtifactRecord'
import type { ChatThreadViewModel } from '../../src/lib/chat/types'
import type { Invoice } from '../../src/lib/invoices/types'
import type { Job } from '../../src/lib/jobs'
import type { Offer } from '../../src/lib/offers/types'

// ── Constants / fixtures ────────────────────────────────────────────────────

const THREAD_ID = 'thread-inv-1'
const CUSTOMER_UID = 'cust-uid-1'
const CRAFTSMAN_UID = 'craft-uid-1'

type JobOpts = {
  customerUserId?: string
  craftsmanUserId?: string
  sourceConversationId?: string
  sourceOfferId?: string
}

function makeJob(jobId: string, opts: JobOpts = {}): Job {
  return {
    id: jobId,
    title: 'Sanitärarbeiten',
    customer: 'Max Mustermann',
    amount: '1.000 €',
    status: 'in_progress',
    customerUserId: opts.customerUserId,
    craftsmanUserId: opts.craftsmanUserId,
    sourceConversationId: opts.sourceConversationId,
    sourceOfferId: opts.sourceOfferId,
  } as unknown as Job
}

function makeDraftInvoice(jobId: string): Invoice {
  return {
    id: `inv_${jobId}`,
    jobId,
    invoiceNumber: '',
    status: 'draft',
    parties: {
      issuerName: 'Müller Sanitär GmbH',
      issuerAddress: 'Hauptstraße 5, 10115 Berlin',
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

function makeAcceptedOffer(offerId: string, jobId: string): Offer {
  return {
    id: offerId,
    conversationId: THREAD_ID,
    customerUserId: CUSTOMER_UID,
    craftsmanUserId: CRAFTSMAN_UID,
    price: '1.190 €',
    grossTotal: 119_000,
    netTotal: 100_000,
    vatRate: 19,
    lineItems: [
      { id: 'qli-1', label: 'Arbeitslohn', category: 'labor', netAmount: 80_000, quantity: 1 },
      { id: 'qli-2', label: 'Material', category: 'material', netAmount: 20_000, quantity: 1 },
    ],
    status: 'accepted',
    createdJobId: jobId,
    sentAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } as Offer
}

function makeProviderProfile(): ProviderProfile {
  return {
    id: 'prov-1',
    profileId: CRAFTSMAN_UID,
    companyName: 'Müller Sanitär GmbH',
    handle: 'mueller-sanitaer',
    description: null,
    city: 'Berlin',
    businessAddress: 'Hauptstraße 5, 10115 Berlin',
    tradeCategories: [],
    avatarUrl: null,
    isPublic: true,
    taxProfile: {
      taxNumber: '12/345/67890',
      vatId: 'DE123456789',
      legalForm: 'gmbh',
      isKleinunternehmer: false,
      defaultVatRate: 19,
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
    },
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeCustomerBilling() {
  return {
    userId: CUSTOMER_UID,
    billingName: 'Julia Neumann',
    billingAddressLine1: 'Mozartstraße 12',
    billingAddressLine2: null,
    billingPostalCode: '10115',
    billingCity: 'Berlin',
    billingCountry: 'DE',
    billingEmail: null,
    billingPhone: null,
    isBusiness: false,
    businessName: null,
    vatId: null,
  }
}

function seedThread(repo: InMemoryChatRepository, id = THREAD_ID): void {
  const now = Date.now()
  repo._seedThread({
    id,
    channelType: 'customer',
    customerUserId: CUSTOMER_UID,
    craftsmanUserId: CRAFTSMAN_UID,
    providerId: 'prov-1',
    legacyThreadId: null,
    legacySource: null,
    title: null,
    lastMessageId: null,
    lastMessageAt: null,
    lastMessageBody: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    participants: [],
    unreadCount: 0,
    migrationStatus: 'migration_complete',
  } as ChatThreadViewModel)
}

function invoiceArtifactRecords(invoiceId: string): ThreadArtifactRecord[] {
  return getThreadArtifactRepository()
    .getAll()
    .filter((r) => r.artifactType === 'invoice' && r.invoiceId === invoiceId)
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('Invoice thread-artifact — emit on issue', () => {
  let chatRepo: InMemoryChatRepository

  beforeEach(async () => {
    setupCleanRepositories()
    chatRepo = new InMemoryChatRepository()
    await chatRepo.initialize()
    setChatRepository(chatRepo)
    vi.clearAllMocks()
  })

  // (1) ta_inv_<id> record with correct artifactType/invoiceId/snapshot fields.
  it('issueInvoiceWorkflow persists the ta_inv_<id> record with the correct snapshot fields', async () => {
    const jobId = 'job-emit-1'
    const invoiceId = `inv_${jobId}`
    await getJobRepository().add(
      makeJob(jobId, {
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        sourceConversationId: THREAD_ID,
      }),
    )
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    seedThread(chatRepo)

    await issueInvoiceWorkflow(jobId)

    const issued = getInvoiceByJobId(jobId)!
    expect(issued.status).toBe('issued')

    const record = getThreadArtifactRepository()
      .getAll()
      .find((r) => r.id === `ta_inv_${invoiceId}`)

    expect(record).toBeDefined()
    expect(record!.artifactType).toBe('invoice')
    expect(record!.invoiceId).toBe(invoiceId)
    expect(record!.jobId).toBe(jobId)
    expect(record!.conversationId).toBe(THREAD_ID)
    expect(record!.phase).toBe('issued')
    expect(record!.snapshotPhaseLabel).toBe('Rechnung gestellt')
    // snapshotPrice = formatEuro(grossAmount) → "1.000,00 €"
    expect(record!.snapshotPrice).toBe(formatEuro(issued.amounts.grossAmount))
    // snapshotSummary = the invoice number on the issued invoice.
    expect(record!.snapshotSummary).toBe(issued.invoiceNumber)
    expect(record!.customerUserId).toBe(CUSTOMER_UID)
    expect(record!.craftsmanUserId).toBe(CRAFTSMAN_UID)
  })

  // (2) Idempotency — issuing twice yields exactly ONE ta_inv record.
  it('issuing twice yields exactly one ta_inv record (deterministic id + early-return)', async () => {
    const jobId = 'job-emit-idem'
    const invoiceId = `inv_${jobId}`
    await getJobRepository().add(
      makeJob(jobId, {
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        sourceConversationId: THREAD_ID,
      }),
    )
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    seedThread(chatRepo)

    await issueInvoiceWorkflow(jobId)
    // Second call early-returns (status === 'issued') before re-emitting.
    await issueInvoiceWorkflow(jobId)

    expect(invoiceArtifactRecords(invoiceId)).toHaveLength(1)
    expect(getThreadArtifactRepository().getAll().filter((r) => r.id === `ta_inv_${invoiceId}`)).toHaveLength(1)
  })

  // (3) Job WITHOUT sourceConversationId → emit skipped, NO invoice artifact.
  it('skips the emit (no thread_artifacts invoice record) when the job has no sourceConversationId', async () => {
    const jobId = 'job-no-thread'
    await getJobRepository().add(
      makeJob(jobId, {
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        // sourceConversationId intentionally omitted
      }),
    )
    await getInvoiceRepository().add(makeDraftInvoice(jobId))

    await issueInvoiceWorkflow(jobId)

    // Issue itself still succeeds — the emit is best-effort and skipped.
    expect(getInvoiceByJobId(jobId)?.status).toBe('issued')
    expect(getThreadArtifactRepository().getAll().filter((r) => r.artifactType === 'invoice')).toHaveLength(0)
  })

  // (4) Exactly one artifact_card chat message with artifactType='Invoice'.
  it('sends exactly one artifact_card with artifactType=Invoice and clientMessageId inv-card-<id>', async () => {
    const jobId = 'job-card'
    const invoiceId = `inv_${jobId}`
    await getJobRepository().add(
      makeJob(jobId, {
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        sourceConversationId: THREAD_ID,
      }),
    )
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    seedThread(chatRepo)

    await issueInvoiceWorkflow(jobId)

    const cards = chatRepo
      .getMessages(THREAD_ID)
      .filter((m) => m.messageType === 'artifact_card' && m.artifactType === 'Invoice')

    expect(cards).toHaveLength(1)
    expect(cards[0].artifactId).toBe(invoiceId)
    expect(cards[0].clientMessageId).toBe(`inv-card-${invoiceId}`)
  })

  // BONUS: the §14 production path (issueInvoiceWithSnapshotWorkflow) reaches
  // the SAME emit sink — proving emit-on-issue is path-agnostic.
  it('issueInvoiceWithSnapshotWorkflow also emits the ta_inv record + artifact_card', async () => {
    vi.mocked(getMyProviderProfile).mockResolvedValue(makeProviderProfile())
    vi.mocked(getCustomerBillingForInvoice).mockResolvedValue(makeCustomerBilling())

    const jobId = 'job-snap'
    const offerId = 'offer-snap'
    const invoiceId = `inv_${jobId}`
    await getJobRepository().add(
      makeJob(jobId, {
        customerUserId: CUSTOMER_UID,
        craftsmanUserId: CRAFTSMAN_UID,
        sourceConversationId: THREAD_ID,
        sourceOfferId: offerId,
      }),
    )
    await getOfferRepository().add(makeAcceptedOffer(offerId, jobId))
    await getInvoiceRepository().add(makeDraftInvoice(jobId))
    seedThread(chatRepo)

    await issueInvoiceWithSnapshotWorkflow(jobId, {
      servicePeriod: {
        from: new Date('2026-04-10').getTime(),
        to: new Date('2026-04-15').getTime(),
        label: 'Leistungszeitraum: 10.04.2026 – 15.04.2026',
      },
    })

    const issued = getInvoiceByJobId(jobId)!
    expect(issued.status).toBe('issued')

    const record = getThreadArtifactRepository()
      .getAll()
      .find((r) => r.id === `ta_inv_${invoiceId}`)
    expect(record).toBeDefined()
    expect(record!.artifactType).toBe('invoice')
    expect(record!.invoiceId).toBe(invoiceId)
    expect(record!.phase).toBe('issued')
    expect(record!.snapshotPhaseLabel).toBe('Rechnung gestellt')
    // Snapshot rebuilds amounts from the offer (net 1000 + 19% = gross 1190).
    expect(record!.snapshotPrice).toBe(formatEuro(issued.amounts.grossAmount))

    const cards = chatRepo
      .getMessages(THREAD_ID)
      .filter((m) => m.artifactType === 'Invoice')
    expect(cards).toHaveLength(1)
    expect(cards[0].clientMessageId).toBe(`inv-card-${invoiceId}`)
  })
})
