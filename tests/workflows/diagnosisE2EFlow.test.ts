import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOffersByConversationId } from '../../src/lib/offers/service'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import { getMessageRepository } from '../../src/lib/messages/repository/registry'
import { completeDiagnosisPayment, DIAGNOSIS_FEE_PERCENT } from '../../src/lib/payments/diagnosisPayment'
import type { Conversation } from '../../src/lib/messages/types'

/**
 * Far-future ISO date computed at import time. Acceptance tests below run the
 * real `acceptOfferWorkflow` which rejects offers whose `validUntil < today`,
 * so a hardcoded date would silently rot every time the wall-clock crosses it.
 * Keeping it relative to the current run prevents that class of time-bomb.
 */
const FAR_FUTURE_VALID_UNTIL = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10)

/** Minimal valid diagnosis params (satisfies offerDocumentValidator) */
const DIAG_DEFAULTS = {
  documentType: 'diagnosis' as const,
  scopeSummary: 'Heizungsdiagnose',
  assumptions: 'Keine Zusatzarbeiten ohne Rücksprache',
  validUntil: FAR_FUTURE_VALID_UNTIL,
}

function seedConversation(id: string, craftsmanUserId: string, customerUserId: string): Conversation {
  const conversation: Conversation = {
    id,
    projectId: `proj-${id}`,
    customerName: 'Test Kunde',
    customerAvatarUrl: '',
    craftsmanName: 'Test Handwerker',
    craftsmanHandle: 'handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId,
    customerUserId,
    projectTitle: 'Diagnose-Testprojekt',
    projectSubtitle: '',
  }
  getMessageRepository().addConversation(conversation)
  return conversation
}

describe('Diagnosis E2E Flow', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // -----------------------------------------------------------------------
  // 1. Erstellen
  // -----------------------------------------------------------------------

  describe('erstellen', () => {
    it('creates diagnosis offer with correct documentType and ISO validUntil', async () => {
      seedConversation('conv-diag-1', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-1',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
        validUntil: '2030-05-01',
        description: 'Heizungsdiagnose vor Ort',
      })

      expect(offer.status).toBe('pending')
      expect(offer.documentType).toBe('diagnosis')
      expect(offer.validUntil).toBe('2030-05-01')
      expect(offer.price).toBe('120 €')
    })

    it('normalizes German date format to ISO', async () => {
      seedConversation('conv-diag-2', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-2',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '150 €',
        ...DIAG_DEFAULTS,
        validUntil: '01.05.2030',
        scopeSummary: 'Elektrodiagnose',
      })

      expect(offer.validUntil).toBe('2030-05-01')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Preview
  // -----------------------------------------------------------------------

  describe('preview', () => {
    it('offer carries all diagnosis-specific fields', async () => {
      seedConversation('conv-diag-3', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-3',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
        validUntil: '2030-06-01',
      })

      expect(offer.documentType).toBe('diagnosis')
      expect(offer.offerMode).toBe('estimate') // legacy mode for non-binding
      expect(offer.scopeSummary).toBe('Heizungsdiagnose')
      expect(offer.offerRef).toBeDefined()
      expect(offer.sentAt).toBeDefined()
    })
  })

  // -----------------------------------------------------------------------
  // 3. Senden
  // -----------------------------------------------------------------------

  describe('senden', () => {
    it('persisted offer is queryable by conversationId', async () => {
      seedConversation('conv-diag-4', 'craft-1', 'cust-1')

      await createOfferWorkflow({
        conversationId: 'conv-diag-4',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
      })

      const offers = getOffersByConversationId('conv-diag-4')
      expect(offers).toHaveLength(1)
      expect(offers[0].documentType).toBe('diagnosis')
      expect(offers[0].status).toBe('pending')
    })
  })

  // -----------------------------------------------------------------------
  // 4. Kunde akzeptiert
  // -----------------------------------------------------------------------

  describe('Kunde akzeptiert', () => {
    it('acceptance creates job with jobKind=diagnosis and diagnosis payment', async () => {
      seedConversation('conv-diag-5', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-5',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted).toBeDefined()
      expect(accepted!.status).toBe('accepted')
      expect(accepted!.createdJobId).toBeDefined()

      // Job
      const job = getJobRepository().getById(accepted!.createdJobId!)
      expect(job).toBeDefined()
      expect(job!.jobKind).toBe('diagnosis')
      expect(job!.sourceConversationId).toBe('conv-diag-5')
      expect(job!.craftsmanUserId).toBe('craft-1')
      expect(job!.customerUserId).toBe('cust-1')
      expect(job!.paymentState).toBe('none')

      // Diagnosis payment record created
      const payment = getPaymentRepository().getByJobId(job!.id)
      expect(payment).toBeDefined()
      expect(payment!.state).toBe('diagnosis_payment_pending')
      expect(payment!.amounts.totalAmount).toBe(120)
    })

    it('does NOT create escrow or invoice for diagnosis', async () => {
      seedConversation('conv-diag-6', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-6',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '200 €',
        ...DIAG_DEFAULTS,
        scopeSummary: 'Elektrodiagnose',
      })

      await acceptOfferWorkflow(offer.id)

      const payment = getPaymentRepository().getByJobId(
        getOffersByConversationId('conv-diag-6')[0].createdJobId!
      )
      expect(payment).toBeDefined()
      expect(payment!.state).toBe('diagnosis_payment_pending')
      // depositAmount = net to craftsman (total - 5% fee)
      expect(payment!.amounts.depositAmount).toBe(200 - (200 * DIAGNOSIS_FEE_PERCENT / 100))
      expect(payment!.amounts.finalAmount).toBe(0) // no second tranche
    })
  })

  // -----------------------------------------------------------------------
  // 5. Zahlt (webhook)
  // -----------------------------------------------------------------------

  describe('zahlt (webhook)', () => {
    it('completeDiagnosisPayment transitions to diagnosis_payment_completed', async () => {
      seedConversation('conv-diag-7', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-7',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const jobId = accepted!.createdJobId!

      let payment = getPaymentRepository().getByJobId(jobId)
      expect(payment!.state).toBe('diagnosis_payment_pending')

      await completeDiagnosisPayment(jobId)

      payment = getPaymentRepository().getByJobId(jobId)
      expect(payment!.state).toBe('diagnosis_payment_completed')
    })

    it('completeDiagnosisPayment is idempotent', async () => {
      seedConversation('conv-diag-8', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-8',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const jobId = accepted!.createdJobId!

      await completeDiagnosisPayment(jobId)
      await completeDiagnosisPayment(jobId) // second call — no-op

      const payment = getPaymentRepository().getByJobId(jobId)
      expect(payment!.state).toBe('diagnosis_payment_completed')
    })
  })

  // -----------------------------------------------------------------------
  // 6. Status springt
  // -----------------------------------------------------------------------

  describe('Status springt', () => {
    it('full state chain: pending → accepted → payment_pending → payment_completed', async () => {
      seedConversation('conv-diag-9', 'craft-1', 'cust-1')

      // Step 1: Create
      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-9',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '150 €',
        ...DIAG_DEFAULTS,
        scopeSummary: 'Heizungsdiagnose komplett',
      })
      expect(offer.status).toBe('pending')

      // Step 2: Accept
      const accepted = await acceptOfferWorkflow(offer.id)
      expect(accepted!.status).toBe('accepted')
      const jobId = accepted!.createdJobId!
      const job = getJobRepository().getById(jobId)
      expect(job!.status).toBe('booked')
      expect(job!.jobKind).toBe('diagnosis')

      // Step 3: Payment pending
      let payment = getPaymentRepository().getByJobId(jobId)
      expect(payment!.state).toBe('diagnosis_payment_pending')

      // Step 4: Payment completed (webhook)
      await completeDiagnosisPayment(jobId)
      payment = getPaymentRepository().getByJobId(jobId)
      expect(payment!.state).toBe('diagnosis_payment_completed')

      // Offer still accepted
      const offers = getOffersByConversationId('conv-diag-9')
      expect(offers[0].status).toBe('accepted')
    })
  })

  // -----------------------------------------------------------------------
  // 7. Follow-up — binding_offer from completed diagnosis
  // -----------------------------------------------------------------------

  describe('Follow-up', () => {
    it('craftsman can create follow-up binding_offer with sourceDiagnosisId', async () => {
      seedConversation('conv-diag-10', 'craft-1', 'cust-1')

      // Diagnosis flow
      const diagOffer = await createOfferWorkflow({
        conversationId: 'conv-diag-10',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '120 €',
        ...DIAG_DEFAULTS,
      })
      const accepted = await acceptOfferWorkflow(diagOffer.id)
      await completeDiagnosisPayment(accepted!.createdJobId!)

      // Follow-up: new conversation for the binding_offer
      seedConversation('conv-followup-10', 'craft-1', 'cust-1')

      const followUp = await createOfferWorkflow({
        conversationId: 'conv-followup-10',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '2.500 €',
        documentType: 'binding_offer',
        scopeSummary: 'Heizungsreparatur nach Diagnose',
        scopeExcluded: 'Ersatzteile über 500 €',
        validUntil: FAR_FUTURE_VALID_UNTIL,
        sourceDiagnosisId: diagOffer.id,
      })

      expect(followUp.documentType).toBe('binding_offer')
      expect(followUp.sourceDiagnosisId).toBe(diagOffer.id)
      expect(followUp.status).toBe('pending')

      // Accept follow-up → standard job + escrow path
      const acceptedFollowUp = await acceptOfferWorkflow(followUp.id)
      expect(acceptedFollowUp!.status).toBe('accepted')
      const followUpJob = getJobRepository().getById(acceptedFollowUp!.createdJobId!)
      expect(followUpJob!.jobKind).toBe('standard')
      expect(followUpJob!.paymentState).toBe('deposit_required')
    })
  })

  // -----------------------------------------------------------------------
  // 8. 5% fee calculation
  // -----------------------------------------------------------------------

  describe('fee calculation', () => {
    it('5% platform fee is correctly calculated', async () => {
      seedConversation('conv-diag-11', 'craft-1', 'cust-1')

      const offer = await createOfferWorkflow({
        conversationId: 'conv-diag-11',
        customerUserId: 'cust-1',
        craftsmanUserId: 'craft-1',
        price: '200 €',
        ...DIAG_DEFAULTS,
      })

      const accepted = await acceptOfferWorkflow(offer.id)
      const payment = getPaymentRepository().getByJobId(accepted!.createdJobId!)

      expect(payment!.amounts.totalAmount).toBe(200)
      // 5% of 200 = 10 → craftsman net = 190
      expect(payment!.amounts.depositAmount).toBe(190)
      expect(payment!.amounts.finalAmount).toBe(0)
    })
  })
})
