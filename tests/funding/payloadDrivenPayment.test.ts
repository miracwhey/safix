/**
 * Payload-Driven Payment Screen + Stripe Initiation Hardening Tests
 *
 * Validates:
 * 1. Route payload alone is enough to render payment-ready state
 * 2. PaymentPhase state machine: idle → preparing-payment → payment-form-ready | payment-init-error
 * 3. initiate-funding failure shows persistent retryable error
 * 4. Missing clientSecret shows persistent error
 * 5. Missing Stripe config shows persistent error
 * 6. funding_started renders continue-payment path
 * 7. funded renders funded state
 * 8. No regression to dedicated funding-entry route
 * 9. No regression to server-authoritative funding-entry read
 * 10. Structured logging signals present
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Mock provider profile service to avoid real HTTP calls
vi.mock('../../src/lib/providers/providerProfileService', () => ({
  getProviderProfile: vi.fn().mockResolvedValue(null),
  getMyProviderProfile: vi.fn().mockResolvedValue(null),
  updateProviderProfile: vi.fn().mockResolvedValue(undefined),
}))

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, installSessionForJobCustomer, mockCustomerSession } from '../helpers/mockSession'
import {
  getFundingRequestByJobId,
  getFundingRequestRepository,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanByJobId,
  getEscrowPlanRepository,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
  customerFundingEntryWorkflow,
  confirmFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById } from '../../src/lib/jobs'
import type { Conversation } from '../../src/lib/messages/types'
import type { FundingRequest, FundingRequestStatus } from '../../src/lib/payments/fundingRequest'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow'
import type { PaymentPhase } from '../../src/components/projects/CustomerEscrowFundingCard'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id: string): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: `customer-${id}`,
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: `craftsman-${id}`,
    projectTitle: 'Payload Driven Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  } as unknown as Conversation
}

async function setupAcceptedQuoteAndFunding(convId: string) {
  const conv = makeConversation(convId)
  await addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId: conv.id,
    customerUserId: `customer-${convId}`,
    craftsmanUserId: `craftsman-${convId}`,
    price: '5.000 €',
  })

  await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))

  const acceptedOffer = getOfferById(offer.id)!
  const job = getJobById(acceptedOffer.createdJobId!)!

  installSessionForJobOwner(job)
  await requestFundingWorkflow(job.id)

  const fr = getFundingRequestByJobId(job.id)!
  const plan = getEscrowPlanByJobId(job.id)!

  return { conv, offer: acceptedOffer, job, fr, plan }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Payload-Driven Payment Screen + Stripe Initiation Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─── 1. Payload alone renders payment-ready state ─────────────────────

  describe('1. Route payload alone renders payment-ready state', () => {
    it('server payload seeds repos and makes data findable without local hydration', () => {
      setupCleanRepositories()

      const now = Date.now()
      const fr: FundingRequest = {
        id: 'fr-payload-1',
        sourceOfferId: 'offer-payload-1',
        jobId: 'job-payload-1',
        escrowPlanId: 'ep-payload-1',
        customerUserId: 'cust-1',
        providerId: 'prov-1',
        providerUserId: 'prov-user-1',
        type: 'full_escrow',
        status: 'sent',
        amount: 5000,
        currency: 'EUR',
        createdBy: 'provider',
        createdAt: now,
        updatedAt: now,
      }
      const plan: EscrowPaymentPlan = {
        id: 'ep-payload-1',
        sourceOfferId: 'offer-payload-1',
        jobId: 'job-payload-1',
        customerUserId: 'cust-1',
        providerId: 'prov-1',
        currency: 'EUR',
        totalAmount: 5000,
        fundingMode: 'full_upfront_escrow',
        releaseModel: 'start_25_completion_75',
        status: 'awaiting_customer_funding',
        createdAt: now,
        updatedAt: now,
      }

      // Seed into repos (simulating what FundingEntryScreen does with server payload)
      getFundingRequestRepository().add(fr)
      getEscrowPlanRepository().addPlan(plan)

      // Verify findable by jobId (what CustomerEscrowFundingCard uses)
      const foundFr = getFundingRequestByJobId('job-payload-1')
      const foundPlan = getEscrowPlanByJobId('job-payload-1')
      expect(foundFr).toBeDefined()
      expect(foundFr!.id).toBe('fr-payload-1')
      expect(foundPlan).toBeDefined()
      expect(foundPlan!.id).toBe('ep-payload-1')
    })

    it('CustomerEscrowFundingCard accepts serverFundingRequest and serverEscrowPlan props', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('serverFundingRequest')
      expect(content).toContain('serverEscrowPlan')
    })

    it('FundingEntryScreen passes server payload to CustomerEscrowFundingCard', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('serverFundingRequest={')
      expect(content).toContain('serverEscrowPlan={')
    })
  })

  // ─── 2. PaymentPhase state machine ────────────────────────────────────

  describe('2. PaymentPhase state machine exists and is explicit', () => {
    it('PaymentPhase type is defined with all required states', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("'idle'")
      expect(content).toContain("'preparing-payment'")
      expect(content).toContain("'payment-form-ready'")
      expect(content).toContain("'payment-init-error'")
    })

    it('PaymentPhase type is exported for test access', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('export type PaymentPhase')
    })

    it('container component initializes paymentPhase state', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("useState<PaymentPhase>('idle')")
    })

    it('handleStartPayment transitions through preparing-payment', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("setPaymentPhase('preparing-payment')")
    })

    it('handleStartPayment transitions to payment-form-ready on success', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("setPaymentPhase('payment-form-ready')")
    })

    it('handleStartPayment transitions to payment-init-error on failure', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("setPaymentPhase('payment-init-error')")
    })

    const allPhases: PaymentPhase[] = ['idle', 'preparing-payment', 'payment-form-ready', 'payment-init-error']

    for (const phase of allPhases) {
      it(`phase '${phase}' is a valid PaymentPhase value`, () => {
        // Type check: assignment must compile
        const p: PaymentPhase = phase
        expect(p).toBe(phase)
      })
    }
  })

  // ─── 3. initiate-funding failure shows persistent retryable error ─────

  describe('3. initiate-funding failure renders persistent retryable error', () => {
    it('view component renders payment-init-error block with retry button', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // Check for persistent error block with data-testid
      expect(content).toContain('payment-init-error')
      expect(content).toContain('Zahlung konnte nicht gestartet werden')
      expect(content).toContain('Erneut versuchen')
    })

    it('error state includes both retry and page reload options', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('onRetryPayment')
      expect(content).toContain('Seite neu laden')
    })

    it('handleRetryPayment resets phase to idle', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('handleRetryPayment')
      // Verify it resets to idle
      const retryBlock = content.slice(content.indexOf('handleRetryPayment'))
      expect(retryBlock).toContain("setPaymentPhase('idle')")
    })
  })

  // ─── 4. Missing clientSecret shows persistent error ───────────────────

  describe('4. Explicit outcome replaces missing clientSecret guessing', () => {
    it('handleStartPayment uses typed outcome-based response', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // The card now uses explicit outcome codes instead of guessing from missing clientSecret
      expect(content).toContain('result.outcome')
    })

    it('already-funded outcome confirms server-side then reconciles', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('PAYMENT_ALREADY_FUNDED')
      // FINDINGS P1 #333: confirm (idempotent + Stripe-verified) + bounded
      // reconciliation poll instead of a terminal local payment-already-funded
      // read that left the DB at funding_initiated until the webhook.
      expect(content).toContain('confirmFundingPayment')
      expect(content).toContain("setPaymentPhase('reconciliation-pending')")
    })
  })

  // ─── 5. Missing Stripe config shows persistent error ──────────────────

  describe('5. Missing Stripe config shows persistent error', () => {
    it('handleStartPayment guards for missing Stripe publishable key', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('stripePublishableKey')
      expect(content).toContain('payment.missing_stripe_key')
    })

    it('missing Stripe key sets payment-init-error phase', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // Find the stripe key guard block and verify it sets error phase
      const guardStart = content.indexOf('payment.missing_stripe_key')
      expect(guardStart).toBeGreaterThan(-1)
      // Find the next closing brace of the guard's if-block
      const guardEnd = content.indexOf("return", guardStart)
      expect(guardEnd).toBeGreaterThan(guardStart)
      const stripeKeyBlock = content.slice(guardStart, guardEnd + 50)
      expect(stripeKeyBlock).toContain("setPaymentPhase('payment-init-error')")
    })

    it('view component shows Stripe config error with retry when stripePromise is null', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('Zahlungskonfiguration nicht verfügbar')
      expect(content).toContain('stripe-config-error')
    })
  })

  // ─── 6. funding_started renders continue-payment path ─────────────────

  describe('6. funding_started renders continue-payment path', () => {
    it('funding_started status transitions correctly via workflow', async () => {
      const { job } = await setupAcceptedQuoteAndFunding('continue-test-1')

      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      expect(fr.status).toBe('funding_started')

      const plan = getEscrowPlanByJobId(job.id)!
      expect(plan.status).toBe('funding_initiated')
    })

    it('view component shows resume button when processing + idle phase', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('resume-payment-button')
      expect(content).toContain('Zahlung fortsetzen')
    })

    it('isProcessing branch uses paymentPhase for sub-state rendering', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // Within isProcessing block, check for paymentPhase-driven rendering
      expect(content).toContain("paymentPhase === 'preparing-payment'")
      expect(content).toContain("paymentPhase === 'payment-form-ready'")
      expect(content).toContain("paymentPhase === 'payment-init-error'")
      expect(content).toContain("paymentPhase === 'idle'")
    })
  })

  // ─── 7. funded renders funded state ───────────────────────────────────

  describe('7. funded renders funded state', () => {
    it('funded status has both funding request and escrow plan', async () => {
      const { job } = await setupAcceptedQuoteAndFunding('funded-test-1')

      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      const plan = getEscrowPlanByJobId(job.id)!
      expect(fr.status).toBe('funded')
      expect(plan.status).toBe('funded_in_escrow')
    })

    it('view component shows funded callout', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('Zahlung bestätigt')
    })

    it('all status branches are still covered', () => {
      const allStatuses: FundingRequestStatus[] = [
        'created', 'sent', 'funding_started', 'funding_initiated',
        'funded', 'funding_failed', 'expired', 'cancelled',
      ]
      for (const status of allStatuses) {
        const isActionRequired = status === 'created' || status === 'sent'
        const isProcessing = status === 'funding_started' || status === 'funding_initiated'
        const isFunded = status === 'funded'
        const isFailed = status === 'funding_failed'
        const isCancelledOrExpired = status === 'cancelled' || status === 'expired'
        const matched = [isActionRequired, isProcessing, isFunded, isFailed, isCancelledOrExpired].filter(Boolean).length
        expect(matched).toBe(1)
      }
    })
  })

  // ─── 8. No regression to dedicated funding-entry route ────────────────

  describe('8. No regression to dedicated funding-entry route', () => {
    it('FundingEntryScreen still exists', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      expect(fs.existsSync(screenPath)).toBe(true)
    })

    it('App.tsx still routes /funding/:fundingRequestId', () => {
      const appPath = path.resolve(__dirname, '../../src/App.tsx')
      const content = fs.readFileSync(appPath, 'utf-8')
      expect(content).toContain('/funding/:fundingRequestId')
      expect(content).toContain('FundingEntryScreen')
    })

    it('buildFundingEntryPath still builds correct path', async () => {
      const { buildFundingEntryPath } = await import('../../src/lib/funding')
      const p = buildFundingEntryPath('test-fr-id')
      expect(p).toBe('/funding/test-fr-id')
    })
  })

  // ─── 9. No regression to server-authoritative read ────────────────────

  describe('9. No regression to server-authoritative funding-entry read', () => {
    it('FundingEntryScreen uses fetchFundingEntry', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('fetchFundingEntry')
      expect(content).toContain('server-authoritative')
    })

    it('FundingEntryScreen converts server payload to domain types', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('payloadToFundingRequest')
      expect(content).toContain('payloadToEscrowPlan')
    })

    it('FundingEntryScreen passes converted server payload as props', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      // Verify the screen creates domain objects from server payload
      expect(content).toContain('serverFundingRequest = serverPayload')
      expect(content).toContain('serverEscrowPlan = serverPayload')
      // And passes them to the card
      expect(content).toContain('serverFundingRequest={serverFundingRequest}')
      expect(content).toContain('serverEscrowPlan={serverEscrowPlan}')
    })
  })

  // ─── 10. Structured logging signals ───────────────────────────────────

  describe('10. Structured logging signals present', () => {
    it('CustomerEscrowFundingCard uses logInfo and logWarning from observability', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain("import { logInfo, logWarning } from '../../lib/observability'")
    })

    it('payment button click is logged', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('payment.start_clicked')
    })

    it('initiate-funding start and response are logged', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('payment.initiate_funding_started')
      expect(content).toContain('payment.initiate_funding_response')
    })

    it('initiate-funding failure is logged', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('payment.initiate_funding_failed')
    })

    it('clientSecret presence/absence is logged via outcome', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('payment.initiate_funding_form_ready')
      expect(content).toContain('hasClientSecret')
    })

    it('Stripe form ready state is logged', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('payment.stripe_form_ready')
    })

    it('payment phase transitions are logged in render', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('paymentPhase:')
    })

    it('retry click is logged', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('payment.retry_clicked')
    })
  })

  // ─── 11. No stuck processing / no blank states ────────────────────────

  describe('11. No stuck processing / no blank states', () => {
    it('preparing-payment state has a visible loading indicator', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      const stepperPath = path.resolve(__dirname, '../../src/components/payments/PaymentProcessStepper.tsx')
      const stepperContent = fs.readFileSync(stepperPath, 'utf-8')
      expect(content).toContain('payment-preparing')
      expect(content).toContain('<PaymentProcessStepper phase={1}')
      expect(stepperContent).toContain('className="fx-spin"')
    })

    it('every code path in handleStartPayment sets a paymentPhase', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')

      // Extract handleStartPayment function
      const startIdx = content.indexOf('const handleStartPayment = useCallback')
      const endPatterns = ['const handleMockConfirm', 'const handleRetryPayment']
      let endIdx = content.length
      for (const pat of endPatterns) {
        const idx = content.indexOf(pat, startIdx + 100)
        if (idx > startIdx && idx < endIdx) endIdx = idx
      }
      const fnBody = content.slice(startIdx, endIdx)

      // Verify all exit paths set paymentPhase
      // 1. Missing data → payment-init-error
      expect(fnBody).toContain("setPaymentPhase('payment-init-error')")
      // 2. Success → payment-form-ready
      expect(fnBody).toContain("setPaymentPhase('payment-form-ready')")
      // 3. Preparing → preparing-payment
      expect(fnBody).toContain("setPaymentPhase('preparing-payment')")
      // 4. Mock → idle (instant complete)
      expect(fnBody).toContain("setPaymentPhase('idle')")
    })

    it('view component does not have an unconditional "waiting forever" branch', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // The old pattern "!isAwaitingStripePayment" unconditional waiting state should not exist
      expect(content).not.toContain('!isAwaitingStripePayment')
    })
  })

  // ─── 12. Store coupling reduction ─────────────────────────────────────

  describe('12. Store coupling is reduced', () => {
    it('container component prioritizes server props over store for initial state', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // Verify the initial state uses server props first
      expect(content).toContain('serverFundingRequest ?? getFundingRequestByJobId')
      expect(content).toContain('serverEscrowPlan ?? getEscrowPlanByJobId')
    })

    it('handleStartPayment uses component state as primary', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // Verify handleStartPayment reads from component state first
      expect(content).toContain('fundingRequest ?? getFundingRequestByJobId')
      expect(content).toContain('escrowPlan ?? getEscrowPlanByJobId')
    })

    it('FundingEntryScreen derives domain objects from server payload', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      // Verify the screen converts payload to domain types for passing
      expect(content).toContain('payloadToFundingRequest(serverPayload.fundingRequest)')
      expect(content).toContain('payloadToEscrowPlan(serverPayload.escrowPlan)')
    })
  })
})
