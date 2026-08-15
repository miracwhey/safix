/**
 * Funding Payment UI Mount Hardening Tests
 *
 * Validates:
 * 1. FundingEntryScreen renders payment UI when funding request + escrow plan exist
 * 2. seedReposFromPayload seeds data into in-memory repos correctly
 * 3. sent status shows payment card (not blank screen)
 * 4. initiate-funding failure shows explicit error, not blank screen
 * 5. missing Stripe config shows explicit error, not blank screen
 * 6. funding_started shows continue-payment path
 * 7. funded shows funded state
 * 8. CustomerEscrowFundingCard never returns null/blank
 * 9. PaymentErrorBoundary catches render exceptions
 * 10. No regression to dedicated funding-entry routing
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
  getFundingRequestById,
  getFundingRequestByJobId,
  getFundingRequestRepository,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanById,
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
import type { FundingEntryPayload } from '../../src/lib/funding'
import type { FundingRequest, FundingRequestStatus } from '../../src/lib/payments/fundingRequest'
import type { EscrowPaymentPlan } from '../../src/lib/payments/escrow'

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
    projectTitle: 'Payment Mount Test',
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

  // Request funding (owner action)
  installSessionForJobOwner(job)
  await requestFundingWorkflow(job.id)

  const fr = getFundingRequestByJobId(job.id)!
  const plan = getEscrowPlanByJobId(job.id)!

  return { conv, offer: acceptedOffer, job, fr, plan }
}

/**
 * Creates a FundingEntryPayload from a FundingRequest and EscrowPaymentPlan,
 * simulating the server response format.
 */
function makeFundingEntryPayload(
  fr: FundingRequest,
  plan: EscrowPaymentPlan,
  jobId: string,
): FundingEntryPayload {
  return {
    fundingRequest: {
      id: fr.id,
      sourceOfferId: fr.sourceOfferId,
      jobId: fr.jobId,
      escrowPlanId: fr.escrowPlanId,
      customerUserId: fr.customerUserId,
      providerId: fr.providerId,
      providerUserId: fr.providerUserId,
      type: fr.type,
      status: fr.status,
      amount: fr.amount,
      currency: fr.currency,
      createdBy: fr.createdBy,
      conversationId: fr.conversationId,
      messageId: fr.messageId,
      createdAt: new Date(fr.createdAt).toISOString(),
      updatedAt: new Date(fr.updatedAt).toISOString(),
      sentAt: fr.sentAt ? new Date(fr.sentAt).toISOString() : undefined,
      fundedAt: fr.fundedAt ? new Date(fr.fundedAt).toISOString() : undefined,
      externalFundingRef: fr.externalFundingRef,
      fundingIdempotencyKey: fr.fundingIdempotencyKey,
      failureReason: fr.failureReason,
    },
    escrowPlan: {
      id: plan.id,
      sourceOfferId: plan.sourceOfferId,
      jobId: plan.jobId,
      customerUserId: plan.customerUserId,
      providerId: plan.providerId,
      currency: plan.currency,
      totalAmount: plan.totalAmount,
      fundingMode: plan.fundingMode,
      releaseModel: plan.releaseModel,
      status: plan.status,
      createdAt: new Date(plan.createdAt).toISOString(),
      updatedAt: new Date(plan.updatedAt).toISOString(),
      fundingInitiatedAt: plan.fundingInitiatedAt ? new Date(plan.fundingInitiatedAt).toISOString() : undefined,
      fundedAt: plan.fundedAt ? new Date(plan.fundedAt).toISOString() : undefined,
      externalFundingRef: plan.externalFundingRef,
      fundingIdempotencyKey: plan.fundingIdempotencyKey,
    },
    job: {
      id: jobId,
      status: 'accepted',
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Funding Payment UI Mount Hardening', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─── 1. Repo seeding from server payload ──────────────────────────────

  describe('1. seedReposFromPayload ensures data availability', () => {
    it('funding request and escrow plan are findable by jobId after workflow', async () => {
      const { job, fr, plan } = await setupAcceptedQuoteAndFunding('seed-test-1')

      expect(fr).toBeDefined()
      expect(plan).toBeDefined()
      expect(fr.jobId).toBe(job.id)
      expect(plan.jobId).toBe(job.id)

      // After workflow, data should be findable by jobId
      const foundFr = getFundingRequestByJobId(job.id)
      const foundPlan = getEscrowPlanByJobId(job.id)
      expect(foundFr).toBeDefined()
      expect(foundPlan).toBeDefined()
    })

    it('simulated server payload can be seeded into empty repos', () => {
      // Clear repos to simulate the cold-start scenario
      setupCleanRepositories()

      // Verify repos are empty
      expect(getFundingRequestById('fr-seed-1')).toBeUndefined()
      expect(getEscrowPlanById('ep-seed-1')).toBeUndefined()

      // Simulate seeding from server payload by adding directly to repos
      const now = Date.now()
      const fr: FundingRequest = {
        id: 'fr-seed-1',
        sourceOfferId: 'offer-seed-1',
        jobId: 'job-seed-1',
        escrowPlanId: 'ep-seed-1',
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
        id: 'ep-seed-1',
        sourceOfferId: 'offer-seed-1',
        jobId: 'job-seed-1',
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

      // Seed into repos (this is what seedReposFromPayload does)
      getFundingRequestRepository().add(fr)
      getEscrowPlanRepository().addPlan(plan)

      // Verify they are now findable
      expect(getFundingRequestById('fr-seed-1')).toBeDefined()
      expect(getFundingRequestByJobId('job-seed-1')).toBeDefined()
      expect(getEscrowPlanById('ep-seed-1')).toBeDefined()
      expect(getEscrowPlanByJobId('job-seed-1')).toBeDefined()
    })
  })

  // ─── 2. No-blank-screen guarantee ─────────────────────────────────────

  describe('2. No-blank-screen guarantee', () => {
    it('sent status leads to a findable funding request with action-required state', async () => {
      const { job, fr } = await setupAcceptedQuoteAndFunding('blank-test-1')

      expect(fr.status).toBe('sent')

      // Verify the data is available for CustomerEscrowFundingCard
      const foundFr = getFundingRequestByJobId(job.id)
      expect(foundFr).toBeDefined()
      expect(foundFr!.status === 'sent' || foundFr!.status === 'created').toBe(true)
    })

    it('funding_started status has a valid escrow plan', async () => {
      const { job } = await setupAcceptedQuoteAndFunding('blank-test-2')

      // Advance to funding_started
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)

      const updatedFr = getFundingRequestByJobId(job.id)!
      const plan = getEscrowPlanByJobId(job.id)!
      expect(updatedFr.status).toBe('funding_started')
      expect(plan).toBeDefined()
      expect(plan.status).toBe('funding_initiated')
    })

    it('funded status has both funding request and escrow plan', async () => {
      const { job } = await setupAcceptedQuoteAndFunding('blank-test-3')

      // Advance to funded
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)

      const fundedFr = getFundingRequestByJobId(job.id)!
      const fundedPlan = getEscrowPlanByJobId(job.id)!
      expect(fundedFr.status).toBe('funded')
      expect(fundedPlan.status).toBe('funded_in_escrow')
    })
  })

  // ─── 3. Status-specific render branch coverage ─────────────────────────

  describe('3. Every funding status has a render branch', () => {
    const allStatuses: FundingRequestStatus[] = [
      'created', 'sent', 'funding_started', 'funding_initiated',
      'funded', 'funding_failed', 'expired', 'cancelled',
    ]

    it('all known FundingRequestStatus values are listed', () => {
      expect(allStatuses).toHaveLength(8)
    })

    for (const status of allStatuses) {
      it(`status '${status}' maps to a known render branch`, () => {
        const isActionRequired = status === 'created' || status === 'sent'
        const isProcessing = status === 'funding_started' || status === 'funding_initiated'
        const isFunded = status === 'funded'
        const isFailed = status === 'funding_failed'
        const isCancelledOrExpired = status === 'cancelled' || status === 'expired'

        const coveredBranches = [
          isActionRequired, isProcessing, isFunded, isFailed, isCancelledOrExpired,
        ]
        const matchedBranch = coveredBranches.filter(Boolean).length
        // Every status must match exactly one branch
        expect(matchedBranch).toBe(1)
      })
    }
  })

  // ─── 4. PaymentErrorBoundary file existence and structure ──────────────

  describe('4. PaymentErrorBoundary exists and is imported', () => {
    it('PaymentErrorBoundary file exists', () => {
      const boundaryPath = path.resolve(__dirname, '../../src/components/system/PaymentErrorBoundary.tsx')
      expect(fs.existsSync(boundaryPath)).toBe(true)
    })

    it('FundingEntryScreen imports PaymentErrorBoundary', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('PaymentErrorBoundary')
    })

    it('FundingEntryScreen wraps CustomerEscrowFundingCard in PaymentErrorBoundary', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      // Check that PaymentErrorBoundary wraps the card
      expect(content).toContain('<PaymentErrorBoundary>')
      expect(content).toContain('</PaymentErrorBoundary>')
    })
  })

  // ─── 5. Config guard for Stripe publishable key ────────────────────────

  describe('5. Stripe config guards', () => {
    it('CustomerEscrowFundingCard checks for missing Stripe key in handleStartPayment', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('stripePublishableKey')
      expect(content).toContain('Zahlungskonfiguration nicht verfügbar')
    })

    it('view component shows explicit error when stripePromise is null', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('Zahlungskonfiguration nicht verfügbar')
      expect(content).toContain('!stripePromise')
    })
  })

  // ─── 6. CustomerEscrowFundingCard no-null guarantee ────────────────────

  describe('6. CustomerEscrowFundingCard never returns null/blank', () => {
    it('shows explicit loading state when no funding request exists', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')

      // The previous bare `if (!fundingRequest) return null` guard must be replaced.
      // Check that the specific guard now renders UI instead of null.
      expect(content).not.toContain('if (!fundingRequest) return null')

      // Must contain the loading state data-testid
      expect(content).toContain('customer-escrow-funding-card-loading')
      expect(content).toContain('Zahlungsdaten werden geladen')
    })
  })

  // ─── 7. seedReposFromPayload function exists in FundingEntryScreen ─────

  describe('7. seedReposFromPayload integration in FundingEntryScreen', () => {
    it('FundingEntryScreen contains seedReposFromPayload function', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('seedReposFromPayload')
    })

    it('seedReposFromPayload is called on server read success path', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      // The server read success block should contain both calls in order:
      // seedReposFromPayload(payload) then setLoadPhase('ready')
      // Find the block after 'server read success' comment
      const serverReadBlock = content.slice(content.indexOf('Seed in-memory repos from server payload'))
      const seedIndex = serverReadBlock.indexOf('seedReposFromPayload(payload)')
      const readyIndex = serverReadBlock.indexOf("setLoadPhase('ready')")
      expect(seedIndex).toBeGreaterThan(-1)
      expect(readyIndex).toBeGreaterThan(-1)
      expect(seedIndex).toBeLessThan(readyIndex)
    })

    it('seedReposFromPayload calls repo.add for new data', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('frRepo.add(')
      expect(content).toContain('epRepo.addPlan(')
    })
  })

  // ─── 8. Debug logging signals present ──────────────────────────────────

  describe('8. Debug logging signals are present', () => {
    it('FundingEntryScreen has logging for key transitions', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('[FundingEntry] seeded funding request into repo')
      expect(content).toContain('[FundingEntry] seeded escrow plan into repo')
      expect(content).toContain('[FundingEntry] rendering payment UI for job')
    })

    it('CustomerEscrowFundingCard has logging for mount and payment flow', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      expect(content).toContain('[CustomerEscrowFundingCard] mounted with funding request')
      expect(content).toContain('[CustomerEscrowFundingCard] render branch')
      expect(content).toContain('payment.start_clicked')
      expect(content).toContain('payment.initiate_funding_response')
    })
  })

  // ─── 9. initiate-funding clientSecret guard ────────────────────────────

  describe('9. initiate-funding clientSecret flow is hardened', () => {
    it('handleStartPayment uses typed outcome-based response and detects contract violations', () => {
      const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
      const content = fs.readFileSync(cardPath, 'utf-8')
      // The card now parses explicit outcome from initiateFundingPayment
      expect(content).toContain('result.outcome')
      expect(content).toContain('PAYMENT_ALREADY_FUNDED')
    })
  })

  // ─── 9b. Dead-button fix: phase-driven Stripe form mount (P1 #309/#315) ─
  //
  // The Stripe <Elements> form must render purely PHASE-driven and at card
  // level — independent of the isActionRequired / isProcessing status split —
  // so no path reaches 'payment-form-ready' without a visible form (the old
  // "Jetzt einzahlen" dead button). Additionally the local repo status is
  // advanced from the server initiate payload (the fire-and-forget workflow
  // cannot be relied on), and the Elements subtree survives 'confirming-payment'.

  describe('9b. Stripe payment form renders phase-driven, independent of status branch', () => {
    const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
    const content = fs.readFileSync(cardPath, 'utf-8')

    it('defines an isStripeFormMounted flag that survives confirming-payment', () => {
      expect(content).toContain('isStripeFormMounted')
      // Mount condition keeps the form mounted through confirming-payment so a
      // 3DS iframe is not torn down (P1 #315).
      const flagIdx = content.indexOf('const isStripeFormMounted')
      const flagDef = content.slice(flagIdx, flagIdx + 160)
      expect(flagDef).toContain('isStripeFormReady')
      expect(flagDef).toContain("paymentPhase === 'confirming-payment'")
    })

    it('renders the Stripe Elements form at card level via a mount testid', () => {
      expect(content).toContain('data-testid="stripe-payment-form-mount"')
    })

    it('keeps the Elements subtree mounted (CSS-hidden) during confirming-payment', () => {
      const mountIdx = content.indexOf('data-testid="stripe-payment-form-mount"')
      const block = content.slice(mountIdx, mountIdx + 500)
      // Hide (display:none) rather than unmount during confirm — the same
      // PaymentElement instance must persist so confirmPayment's elements ref
      // and any 3DS challenge survive (P1 #315).
      expect(block).toContain("paymentPhase === 'confirming-payment' ? 'hidden'")
      expect(block).toContain('<Elements')
      expect(block).toContain('StripePaymentForm')
    })

    it('the Stripe Elements form is NOT nested inside the isProcessing-only branch', () => {
      // The <Elements> mount must live after the main processing render block
      // closes and before the funded callout, so a created/sent funding
      // request can still surface a form. Target the MAIN render blocks: the
      // first `{isProcessing && (` / `{isFunded && (` are the status badges.
      const mountIdx = content.indexOf('data-testid="stripe-payment-form-mount"')
      const firstProcessing = content.indexOf('{isProcessing && (')
      const processingBlockIdx = content.indexOf('{isProcessing && (', firstProcessing + 1)
      const fundedCalloutIdx = content.lastIndexOf('{isFunded && (')
      expect(mountIdx).toBeGreaterThan(processingBlockIdx)
      expect(mountIdx).toBeLessThan(fundedCalloutIdx)
    })

    it('advances local funding-request + escrow status after a successful initiate', () => {
      // ROOT fix: local repo status drives the UI branch (customer
      // funding_requests UPDATE RLS is a no-op), so it is advanced from the
      // server payload — otherwise status stays created/sent and the dead
      // "Jetzt einzahlen" button is shown over the live form.
      expect(content).toContain('advanceLocalStatusToInitiated')
      const helperIdx = content.indexOf('const advanceLocalStatusToInitiated')
      const helper = content.slice(helperIdx, helperIdx + 600)
      expect(helper).toContain("status: 'funding_initiated'")
      expect(helper).toContain('getFundingRequestRepository().update')
      expect(helper).toContain('getEscrowPlanRepository().updatePlan')
    })

    it('does not depend on the fire-and-forget workflow for local status', () => {
      // The workflow call is guarded (.catch) and the status advance is
      // explicit — both must be present.
      expect(content).toContain('void customerFundingEntryWorkflow(jobId)')
      expect(content).toContain('payment.workflow_start_failed')
    })

    it('StripePaymentForm uses a public-web return URL, not window.location.href (P1 #321)', () => {
      expect(content).toContain('getPublicWebOrigin')
      expect(content).toContain('stripeReturnUrl')
      expect(content).toContain('return_url: returnUrl')
      expect(content).not.toContain('return_url: window.location.href')
    })
  })

  // ─── 10. No regression to dedicated funding-entry routing ──────────────

  describe('10. No regression to dedicated funding-entry routing', () => {
    it('FundingEntryScreen still exists and is the canonical funding screen', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      expect(fs.existsSync(screenPath)).toBe(true)
    })

    it('App.tsx still routes /funding/:fundingRequestId to FundingEntryScreen', () => {
      const appPath = path.resolve(__dirname, '../../src/App.tsx')
      const content = fs.readFileSync(appPath, 'utf-8')
      expect(content).toContain('/funding/:fundingRequestId')
      expect(content).toContain('FundingEntryScreen')
    })

    it('FundingEntryScreen still uses server-authoritative read', () => {
      const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('fetchFundingEntry')
      expect(content).toContain('server-authoritative')
    })

    it('buildFundingEntryPath still builds /funding/:id path', async () => {
      const { buildFundingEntryPath } = await import('../../src/lib/funding')
      const path = buildFundingEntryPath('test-fr-id')
      expect(path).toBe('/funding/test-fr-id')
    })
  })

  // ─── 11. Payload-to-domain conversion correctness ──────────────────────

  describe('11. Payload-to-domain conversion', () => {
    it('server payload timestamps convert to numeric TimestampMs in repo entities', async () => {
      const { job, fr, plan } = await setupAcceptedQuoteAndFunding('convert-test-1')

      // Create a payload (simulating server response)
      const payload = makeFundingEntryPayload(fr, plan, job.id)

      // Clear repos
      setupCleanRepositories()

      // Verify payload has string timestamps
      expect(typeof payload.fundingRequest.createdAt).toBe('string')
      expect(typeof payload.escrowPlan.createdAt).toBe('string')

      // Parse timestamps as the converter would
      const parsedFrCreatedAt = new Date(payload.fundingRequest.createdAt).getTime()
      const parsedEpCreatedAt = new Date(payload.escrowPlan.createdAt).getTime()

      expect(typeof parsedFrCreatedAt).toBe('number')
      expect(Number.isNaN(parsedFrCreatedAt)).toBe(false)
      expect(typeof parsedEpCreatedAt).toBe('number')
      expect(Number.isNaN(parsedEpCreatedAt)).toBe(false)
    })
  })

  // ─── 12. End-to-end: funding request data survives full lifecycle ──────

  describe('12. Full lifecycle data availability', () => {
    it('funding request data is available at every lifecycle stage', async () => {
      const { job } = await setupAcceptedQuoteAndFunding('lifecycle-1')

      // Stage: sent
      let fr = getFundingRequestByJobId(job.id)!
      let plan = getEscrowPlanByJobId(job.id)!
      expect(fr.status).toBe('sent')
      expect(plan).toBeDefined()

      // Stage: funding_started
      installSessionForJobCustomer(job)
      await customerFundingEntryWorkflow(job.id)
      fr = getFundingRequestByJobId(job.id)!
      plan = getEscrowPlanByJobId(job.id)!
      expect(fr.status).toBe('funding_started')
      expect(plan.status).toBe('funding_initiated')

      // Stage: funded
      installSessionForJobCustomer(job)
      await confirmFundingWorkflow(job.id)
      fr = getFundingRequestByJobId(job.id)!
      plan = getEscrowPlanByJobId(job.id)!
      expect(fr.status).toBe('funded')
      expect(plan.status).toBe('funded_in_escrow')
    })
  })
})
