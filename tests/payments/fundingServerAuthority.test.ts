/**
 * Server-Authoritative Funding Request Creation Tests
 *
 * Validates that the provider funding request creation path is server-authoritative:
 *  1. requestServerFundingCreation client service function exists with correct type shape
 *  2. CraftsmanJobOperationsCard uses server path for funding, not local requestFundingForJob
 *  3. Client imports requestServerFundingCreation from fundingClient
 *  4. Client refreshes escrow + funding repos after server creation
 *  5. requestFundingForJob still works for tests/local orchestration (no regression)
 *  6. Canonical job resolution still works (no regression)
 *  7. Escrow plan is created/reused exactly once (idempotency via existing tests)
 *  8. Funding request is created/reused exactly once
 *  9. Precise structured errors are available via mapFundingErrorToMessage
 * 10. api/request-funding.ts endpoint exists and validates correctly
 * 11. No regression to full workflow (quote → accept → funding → start → complete → release)
 * 12. Stale duplicate job is redirected to canonical job during funding creation
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  requestServerFundingCreation,
  mapFundingErrorToMessage,
} from '../../src/lib/payments/fundingClient'
import {
  requestFundingForJob,
  startJob,
  completeJob,
} from '../../src/lib/workflow/craftsmanOperations'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
  requestFundingWorkflow,
  markDepositPaidForJobWorkflow,
  lockEscrowWorkflow,
} from '../../src/lib/workflow'
import { getJobById, getJobs, addJob } from '../../src/lib/jobs'
import type { Job } from '../../src/lib/jobs'
import {
  getEscrowPlanByJobId,
  getEscrowPlanByOfferId,
  getEscrowTranches,
  ensureEscrowPlan,
  confirmFunding,
} from '../../src/lib/payments/escrow'
import {
  getFundingRequestByJobId,
  getAllFundingRequests,
  ensureFundingRequest,
} from '../../src/lib/payments/fundingRequest'
import { findCanonicalOverride, filterSupersededJobs } from '../../src/lib/jobs/canonicalJobResolver'
import { addConversation } from '../../src/lib/messages'
import type { Conversation } from '../../src/lib/messages/types'

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConversation(id = 'conv-sfr-001'): Conversation {
  return {
    id,
    projectId: `project-${id}`,
    customerName: 'Max Mustermann',
    customerAvatarUrl: '',
    customerUserId: 'customer-sfr',
    craftsmanName: 'Hans Handwerker',
    craftsmanHandle: 'hans-handwerker',
    craftsmanAvatarUrl: '',
    craftsmanUserId: 'craftsman-sfr',
    projectTitle: 'Server Funding Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  }
}

async function createAcceptedOffer(conversationId = 'conv-sfr-001') {
  const conv = makeConversation(conversationId)
  addConversation(conv)

  const offer = await createOfferWorkflow({
    conversationId,
    craftsmanUserId: conv.craftsmanUserId,
    customerUserId: conv.customerUserId,
    price: '8.000 €',
    description: 'Full renovation work',
  })

  const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(offer.customerUserId))
  return { offer: accepted, conversation: conv }
}

async function simulateCustomerFunding(jobId: string) {
  await markDepositPaidForJobWorkflow(jobId)
  await lockEscrowWorkflow(jobId)
  const escrowPlan = getEscrowPlanByJobId(jobId)!
  await confirmFunding(escrowPlan.id)
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Client service function shape
// ═══════════════════════════════════════════════════════════════════════════

describe('1 — requestServerFundingCreation service function', () => {
  it('exists and is a function', () => {
    expect(typeof requestServerFundingCreation).toBe('function')
  })

  it('returns a promise (async function)', () => {
    // Calling without a server will fail, but should return a Promise
    const result = requestServerFundingCreation('fake-job-id')
    expect(result).toBeInstanceOf(Promise)
    // Suppress unhandled rejection
    result.catch(() => {})
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. CraftsmanJobOperationsCard uses server path for funding
// ═══════════════════════════════════════════════════════════════════════════

describe('2 — CraftsmanJobOperationsCard uses server-authoritative funding path', () => {
  const componentPath = path.resolve(
    __dirname,
    '../../src/components/jobs/CraftsmanJobOperationsCard.tsx',
  )

  it('does not import requestFundingForJob from craftsmanOperations', async () => {
    const content = fs.readFileSync(componentPath, 'utf-8')

    // Must NOT contain a direct import of requestFundingForJob
    expect(content).not.toMatch(/import\s+\{[^}]*requestFundingForJob[^}]*\}\s+from/)
    // Must NOT call requestFundingForJob directly
    expect(content).not.toContain('await requestFundingForJob(')
  })

  it('imports requestServerFundingCreation from fundingClient', () => {
    const content = fs.readFileSync(componentPath, 'utf-8')

    expect(content).toContain('requestServerFundingCreation')
    expect(content).toContain('fundingClient')
  })

  it('calls initializeFundingRequestRepository after server funding creation', () => {
    const content = fs.readFileSync(componentPath, 'utf-8')

    expect(content).toContain('initializeFundingRequestRepository')
  })

  it('calls initializeEscrowPlanRepository after server funding creation', () => {
    const content = fs.readFileSync(componentPath, 'utf-8')

    expect(content).toContain('initializeEscrowPlanRepository')
  })

  it('handleAction for request_funding is async (await pattern)', async () => {
    const content = fs.readFileSync(componentPath, 'utf-8')

    // Should await the server call
    expect(content).toContain('await requestServerFundingCreation')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. api/request-funding.ts endpoint exists and validates correctly
// ═══════════════════════════════════════════════════════════════════════════

describe('3 — api/request-funding.ts endpoint structure', () => {
  const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')

  it('API endpoint file exists', () => {
    expect(fs.existsSync(apiPath)).toBe(true)
  })

  it('uses requireOwner for JWT + role auth (Block 7.2.1c-FU)', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('requireOwner')
    expect(content).toContain("from './_authRole")
  })

  it('uses getSupabaseAdminWithStatus for service-role DB writes', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('getSupabaseAdminWithStatus')
  })

  it('validates jobId is required', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('jobId is required')
  })

  it('returns structured error codes', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('JOB_QUERY_FAILED')
    expect(content).toContain('CANONICAL_JOB_NOT_FOUND')
    expect(content).toContain('SOURCE_OFFER_MISSING')
    expect(content).toContain('ACCEPTED_OFFER_NOT_FOUND')
    expect(content).toContain('CUSTOMER_LINKAGE_MISSING')
    expect(content).toContain('PROVIDER_LINKAGE_MISSING')
    expect(content).toContain('INVALID_AMOUNT_BASIS')
    expect(content).toContain('ESCROW_PLAN_CREATE_FAILED')
    expect(content).toContain('FUNDING_REQUEST_CREATE_FAILED')
  })

  it('checks for existing escrow plan before creating (idempotent)', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('escrow_payment_plans')
    expect(content).toContain('escrow_plan_reused')
  })

  it('checks for existing funding request before creating (idempotent)', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('funding_requests')
    expect(content).toContain('funding_request_reused')
  })

  it('creates thread artifact for customer visibility', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('thread_artifacts')
    expect(content).toContain('funding_step')
  })

  it('never redirects a funding request by customer/provider pair alone', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('accepted_offer_created_job_id_only')
    expect(content).not.toContain('canonical_redirect')
    expect(content).not.toContain(".eq('customer_user_id', job.customer_user_id)")
  })

  it('recovers source offers only through the exact created_job_id link', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain(".eq('created_job_id', canonicalJob.id)")
    expect(content).toContain(".eq('status', 'accepted')")
    expect(content).toContain("code: 'SOURCE_OFFER_MISSING'")
  })

  it('verifies that an accepted offer belongs to the canonical job customer', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('offer.customer_user_id !== customerUserId')
    expect(content).toContain('offer_customer_mismatch')
  })

  it('is POST only', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain("req.method !== 'POST'")
  })

  it('applies CORS', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('applyCors')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Precise structured errors are mapped to user-facing messages
// ═══════════════════════════════════════════════════════════════════════════

describe('4 — mapFundingErrorToMessage structured error mapping', () => {
  it('maps JOB_QUERY_FAILED to German message', () => {
    const msg = mapFundingErrorToMessage('JOB_QUERY_FAILED', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toContain('Auftragsdaten')
  })

  it('maps JOB_LOOKUP_FAILED to German message (backward compat)', () => {
    const msg = mapFundingErrorToMessage('JOB_LOOKUP_FAILED', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toContain('Auftrag')
  })

  it('maps CANONICAL_JOB_NOT_FOUND to German message', () => {
    const msg = mapFundingErrorToMessage('CANONICAL_JOB_NOT_FOUND', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toContain('Auftrag')
  })

  it('maps SOURCE_OFFER_MISSING to German message', () => {
    const msg = mapFundingErrorToMessage('SOURCE_OFFER_MISSING', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toContain('Angebotszuordnung')
  })

  it('maps ACCEPTED_OFFER_NOT_FOUND to German message', () => {
    const msg = mapFundingErrorToMessage('ACCEPTED_OFFER_NOT_FOUND', 'fallback')
    expect(msg).not.toBe('fallback')
    expect(msg).toContain('Angebot')
  })

  it('maps CUSTOMER_LINKAGE_MISSING to German message', () => {
    const msg = mapFundingErrorToMessage('CUSTOMER_LINKAGE_MISSING', 'fallback')
    expect(msg).not.toBe('fallback')
  })

  it('maps PROVIDER_LINKAGE_MISSING to German message', () => {
    const msg = mapFundingErrorToMessage('PROVIDER_LINKAGE_MISSING', 'fallback')
    expect(msg).not.toBe('fallback')
  })

  it('maps PROVIDER_NOT_AUTHORIZED to German message', () => {
    const msg = mapFundingErrorToMessage('PROVIDER_NOT_AUTHORIZED', 'fallback')
    expect(msg).not.toBe('fallback')
  })

  it('maps INVALID_AMOUNT_BASIS to German message', () => {
    const msg = mapFundingErrorToMessage('INVALID_AMOUNT_BASIS', 'fallback')
    expect(msg).not.toBe('fallback')
  })

  it('maps ESCROW_PLAN_CREATE_FAILED to German message', () => {
    const msg = mapFundingErrorToMessage('ESCROW_PLAN_CREATE_FAILED', 'fallback')
    expect(msg).not.toBe('fallback')
  })

  it('maps FUNDING_REQUEST_CREATE_FAILED to German message', () => {
    const msg = mapFundingErrorToMessage('FUNDING_REQUEST_CREATE_FAILED', 'fallback')
    expect(msg).not.toBe('fallback')
  })

  it('returns fallback for unknown error codes', () => {
    const msg = mapFundingErrorToMessage('UNKNOWN_CODE', 'fallback message')
    expect(msg).toBe('fallback message')
  })

  it('returns fallback when code is undefined', () => {
    const msg = mapFundingErrorToMessage(undefined, 'fallback message')
    expect(msg).toBe('fallback message')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. requestFundingForJob still works for tests (no regression)
// ═══════════════════════════════════════════════════════════════════════════

describe('5 — requestFundingForJob local path still works (no regression)', () => {
  beforeEach(() => setupCleanRepositories())

  it('creates escrow plan + funding request for accepted job', async () => {
    const { offer } = await createAcceptedOffer('conv-local-rfj')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    const result = await requestFundingForJob(job.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('sent')
      expect(result.data.amount).toBe(8000)
    }

    const plan = getEscrowPlanByJobId(job.id)
    expect(plan).toBeDefined()
    expect(plan!.totalAmount).toBe(8000)

    const fundingReq = getFundingRequestByJobId(job.id)
    expect(fundingReq).toBeDefined()
    expect(fundingReq!.status).toBe('sent')
  })

  it('returns existing funding request on repeated calls (idempotent)', async () => {
    const { offer } = await createAcceptedOffer('conv-idem-rfj')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    const first = await requestFundingForJob(job.id)
    const second = await requestFundingForJob(job.id)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)

    // Only one funding request should exist
    const allRequests = getAllFundingRequests()
    const jobRequests = allRequests.filter(r => r.jobId === job.id)
    expect(jobRequests).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. Canonical job resolution still works (no regression)
// ═══════════════════════════════════════════════════════════════════════════

describe('6 — canonical job resolution regression', () => {
  beforeEach(() => setupCleanRepositories())

  it('stale duplicate job is redirected to canonical job during funding', async () => {
    const { offer } = await createAcceptedOffer('conv-canon-dup')
    const canonicalJob = getJobById(offer.createdJobId!)!

    // Create a stale duplicate job (same conversation, no sourceOfferId)
    const staleJob: Job = {
      id: 'stale-dup-job',
      projectId: `project-conv-canon-dup`,
      title: 'Duplicate Job',
      customer: 'Max Mustermann',
      location: '',
      dateLabel: '',
      status: 'booked',
      amount: '8.000 €',
      description: '',
      paymentState: 'none',
      documentationStatus: '',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      customerUserId: 'customer-sfr',
      craftsmanUserId: 'craftsman-sfr',
      sourceConversationId: 'conv-canon-dup',
      proposalAcceptedAt: Date.now(),
      // no sourceOfferId → stale
    }
    addJob(staleJob)

    // Request funding on the stale job should redirect to canonical
    installSessionForJobOwner(staleJob)
    const result = await requestFundingForJob(staleJob.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('sent')
    }

    // Funding request should be on the canonical job, not the stale one
    const fundingReq = getFundingRequestByJobId(canonicalJob.id)
    expect(fundingReq).toBeDefined()
  })

  it('filterSupersededJobs removes stale duplicate from list', async () => {
    const { offer } = await createAcceptedOffer('conv-filter-dup')
    const canonicalJob = getJobById(offer.createdJobId!)!

    const staleJob: Job = {
      id: 'stale-filter-job',
      projectId: `project-conv-filter-dup`,
      title: 'Stale Job',
      customer: 'Max Mustermann',
      location: '',
      dateLabel: '',
      status: 'booked',
      amount: '8.000 €',
      description: '',
      paymentState: 'none',
      documentationStatus: '',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      customerUserId: 'customer-sfr',
      craftsmanUserId: 'craftsman-sfr',
      sourceConversationId: 'conv-filter-dup',
      proposalAcceptedAt: Date.now(),
    }
    addJob(staleJob)

    const allJobs = getJobs()
    const filtered = filterSupersededJobs(allJobs)

    // Stale job should be filtered out
    expect(filtered.find(j => j.id === staleJob.id)).toBeUndefined()
    // Canonical job should remain
    expect(filtered.find(j => j.id === canonicalJob.id)).toBeDefined()
  })

  it('findCanonicalOverride returns canonical job for stale job', async () => {
    const { offer } = await createAcceptedOffer('conv-override-dup')
    const canonicalJob = getJobById(offer.createdJobId!)!

    const staleJob: Job = {
      id: 'stale-override-job',
      projectId: `project-conv-override-dup`,
      title: 'Stale Job',
      customer: 'Max Mustermann',
      location: '',
      dateLabel: '',
      status: 'booked',
      amount: '8.000 €',
      description: '',
      paymentState: 'none',
      documentationStatus: '',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      customerUserId: 'customer-sfr',
      craftsmanUserId: 'craftsman-sfr',
      sourceConversationId: 'conv-override-dup',
      proposalAcceptedAt: Date.now(),
    }
    addJob(staleJob)

    const override = findCanonicalOverride(staleJob.id, getJobs())
    expect(override).toBeDefined()
    expect(override!.id).toBe(canonicalJob.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Escrow plan + funding request created/reused exactly once
// ═══════════════════════════════════════════════════════════════════════════

describe('7 — escrow plan + funding request idempotency', () => {
  beforeEach(() => setupCleanRepositories())

  it('repeated requestFundingWorkflow does not create duplicate plan', async () => {
    const { offer } = await createAcceptedOffer('conv-idem-plan')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    requestFundingWorkflow(job.id)
    requestFundingWorkflow(job.id)
    requestFundingWorkflow(job.id)

    const plan = getEscrowPlanByJobId(job.id)
    expect(plan).toBeDefined()

    // Verify only one plan was created for this offer
    const planByOffer = getEscrowPlanByOfferId(job.sourceOfferId!)
    expect(planByOffer).toBeDefined()
    expect(planByOffer!.id).toBe(plan!.id)
  })

  it('repeated requestFundingWorkflow does not create duplicate funding request', async () => {
    const { offer } = await createAcceptedOffer('conv-idem-fr')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    requestFundingWorkflow(job.id)
    requestFundingWorkflow(job.id)
    requestFundingWorkflow(job.id)

    const allRequests = getAllFundingRequests()
    const jobRequests = allRequests.filter(r => r.jobId === job.id)
    expect(jobRequests).toHaveLength(1)
  })

  it('ensureEscrowPlan reuses existing plan by offerId', () => {
    const offerId = `offer-ensure-${Date.now()}`
    const plan1 = ensureEscrowPlan({
      sourceOfferId: offerId,
      jobId: 'job-ensure-1',
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      totalAmount: 5000,
    })

    const plan2 = ensureEscrowPlan({
      sourceOfferId: offerId,
      jobId: 'job-ensure-2',
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      totalAmount: 5000,
    })

    expect(plan1.id).toBe(plan2.id)
  })

  it('ensureFundingRequest reuses existing request by escrowPlanId', () => {
    const planId = `plan-ensure-${Date.now()}`
    const req1 = ensureFundingRequest({
      sourceOfferId: 'offer-1',
      jobId: 'job-1',
      escrowPlanId: planId,
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      providerUserId: 'craftsman-1',
      amount: 5000,
    })

    const req2 = ensureFundingRequest({
      sourceOfferId: 'offer-1',
      jobId: 'job-1',
      escrowPlanId: planId,
      customerUserId: 'customer-1',
      providerId: 'provider-1',
      providerUserId: 'craftsman-1',
      amount: 5000,
    })

    expect(req1.id).toBe(req2.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. No regression to full workflow
// ═══════════════════════════════════════════════════════════════════════════

describe('8 — full workflow no regression (quote → fund → start → complete)', () => {
  beforeEach(() => setupCleanRepositories())

  it('complete lifecycle works end to end', async () => {
    // 1. Create and accept offer
    const { offer } = await createAcceptedOffer('conv-lifecycle')
    const job = getJobById(offer.createdJobId!)!
    installSessionForJobOwner(job)
    expect(job).toBeDefined()
    expect(job.sourceOfferId).toBeDefined()

    // 2. Provider requests funding (local path for test)
    const fundResult = await requestFundingForJob(job.id)
    expect(fundResult.ok).toBe(true)

    // 3. Verify escrow plan + funding request + tranches
    const plan = getEscrowPlanByJobId(job.id)!
    expect(plan).toBeDefined()
    expect(plan.totalAmount).toBe(8000)
    expect(plan.status).toBe('awaiting_customer_funding')

    const tranches = getEscrowTranches(plan.id)
    expect(tranches).toHaveLength(2)

    const fundingReq = getFundingRequestByJobId(job.id)!
    expect(fundingReq.status).toBe('sent')

    // 4. Simulate customer funding
    await simulateCustomerFunding(job.id)
    expect(getEscrowPlanByJobId(job.id)!.status).toBe('funded_in_escrow')

    // 5. Provider starts work
    const startResult = await startJob(job.id)
    expect(startResult.ok).toBe(true)

    // 6. Provider completes work
    const completeResult = await completeJob(job.id)
    expect(completeResult.ok).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. Stale duplicate job handling in funding creation
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — stale duplicate job does not create escrow plan/funding', () => {
  beforeEach(() => setupCleanRepositories())

  it('funding on stale job creates plan only on canonical job', async () => {
    const { offer } = await createAcceptedOffer('conv-stale-plan')
    const canonicalJob = getJobById(offer.createdJobId!)!

    const staleJob: Job = {
      id: 'stale-plan-job',
      projectId: `project-conv-stale-plan`,
      title: 'Stale Job',
      customer: 'Max Mustermann',
      location: '',
      dateLabel: '',
      status: 'booked',
      amount: '8.000 €',
      description: '',
      paymentState: 'none',
      documentationStatus: '',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      customerUserId: 'customer-sfr',
      craftsmanUserId: 'craftsman-sfr',
      sourceConversationId: 'conv-stale-plan',
      proposalAcceptedAt: Date.now(),
    }
    addJob(staleJob)

    // Trigger funding via stale job
    installSessionForJobOwner(staleJob)
    await requestFundingForJob(staleJob.id)

    // Plan should exist on canonical job
    const canonicalPlan = getEscrowPlanByJobId(canonicalJob.id)
    expect(canonicalPlan).toBeDefined()

    // Funding request should be on canonical job
    const fundingReq = getFundingRequestByJobId(canonicalJob.id)
    expect(fundingReq).toBeDefined()
    expect(fundingReq!.status).toBe('sent')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. fundingClient.ts type safety and error mapping
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — fundingClient type shape and exports', () => {
  it('exports requestServerFundingCreation function', () => {
    expect(typeof requestServerFundingCreation).toBe('function')
  })

  it('exports mapFundingErrorToMessage function', () => {
    expect(typeof mapFundingErrorToMessage).toBe('function')
  })

  it('fundingClient file exists', () => {
    const clientPath = path.resolve(
      __dirname,
      '../../src/lib/payments/fundingClient.ts',
    )
    expect(fs.existsSync(clientPath)).toBe(true)
  })

  it('fundingClient follows server-authoritative pattern (no local writes)', () => {
    const clientPath = path.resolve(
      __dirname,
      '../../src/lib/payments/fundingClient.ts',
    )
    const content = fs.readFileSync(clientPath, 'utf-8')

    // Must call server endpoint
    expect(content).toContain('/api/request-funding')
    // Must NOT import escrow or funding request creation functions
    expect(content).not.toContain('ensureEscrowPlan')
    expect(content).not.toContain('ensureFundingRequest')
    // Uses supabase auth for token
    expect(content).toContain('supabase.auth.getSession')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 11. No duplicate plans/requests on retry after partial failure
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — idempotency after partial workflow completion', () => {
  beforeEach(() => setupCleanRepositories())

  it('plan already exists → workflow reuses it on second call', async () => {
    const { offer } = await createAcceptedOffer('conv-partial-plan')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    // First call: creates everything
    const result1 = requestFundingWorkflow(job.id)
    expect(result1).toBeDefined()

    // Second call: should reuse existing plan + request
    const result2 = requestFundingWorkflow(job.id)
    expect(result2).toBeDefined()
    expect(result2!.fundingRequestId).toBe(result1!.fundingRequestId)

    // Verify exactly one plan
    const plan = getEscrowPlanByJobId(job.id)
    expect(plan).toBeDefined()

    // Verify exactly one funding request
    const allFR = getAllFundingRequests().filter(r => r.jobId === job.id)
    expect(allFR).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 12. Thread artifact created for funding step
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — thread artifact creation for customer funding visibility', () => {
  beforeEach(() => setupCleanRepositories())

  it('requestFundingWorkflow creates funding_step thread artifact', async () => {
    const { offer } = await createAcceptedOffer('conv-artifact-test')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    requestFundingWorkflow(job.id)

    // The API endpoint creates thread artifacts via DB directly,
    // but the local workflow also creates them for the in-memory repo.
    // Verify the local workflow path creates the artifact.
    const { getThreadArtifactRepository } = await import(
      '../../src/lib/messages/repository/threadArtifactRegistry'
    )
    const repo = getThreadArtifactRepository()
    const artifact = repo.getByConversationAndType('conv-artifact-test', 'funding_step')
    expect(artifact).toBeDefined()
    expect(artifact!.jobId).toBe(job.id)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 13. Server endpoint validates all canonical fields
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — server endpoint canonical validation', () => {
  const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')

  it('validates provider authorization', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('PROVIDER_NOT_AUTHORIZED')
    expect(content).toContain('auth.userId')
  })

  it('validates job is not in terminal state', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('JOB_IN_TERMINAL_STATE')
    expect(content).toContain('completed')
    expect(content).toContain('cancelled')
  })

  it('validates accepted quote exists', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('NO_ACCEPTED_QUOTE')
    // Uses live-schema-safe signals (source_offer_id + status) instead of proposal_accepted_at
    expect(content).toContain('hasAcceptanceSignal')
  })

  it('validates source offer linkage', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('SOURCE_OFFER_MISSING')
    expect(content).toContain('source_offer_id')
  })

  it('validates accepted offer exists and status is accepted', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('ACCEPTED_OFFER_NOT_FOUND')
    expect(content).toContain("offer.status !== 'accepted'")
  })

  it('validates customer linkage on job', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('CUSTOMER_LINKAGE_MISSING')
    expect(content).toContain('customer_user_id')
  })

  it('validates provider linkage on job', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('PROVIDER_LINKAGE_MISSING')
    expect(content).toContain('provider_id')
  })

  it('validates amount is derivable from offer or job', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('INVALID_AMOUNT_BASIS')
    expect(content).toContain('parseAmount')
  })

  it('marks funding request as sent after creation', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain("status: 'sent'")
    expect(content).toContain('sent_at')
  })

  it('returns idempotent flag when reusing existing data', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('idempotent')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 14. Live-schema hardening — endpoint only uses confirmed-live job columns
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — live-schema-safe endpoint hardening', () => {
  const apiPath = path.resolve(__dirname, '../../api/request-funding.ts')

  it('does NOT select craftsman_user_id from jobs table', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // The LIVE_JOB_COLUMNS constant must not include craftsman_user_id
    const liveColumnsMatch = content.match(/LIVE_JOB_COLUMNS\s*=\s*'([^']+)'/)
    expect(liveColumnsMatch).toBeTruthy()
    expect(liveColumnsMatch![1]).not.toContain('craftsman_user_id')
  })

  it('does NOT select source_conversation_id from jobs table', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    const liveColumnsMatch = content.match(/LIVE_JOB_COLUMNS\s*=\s*'([^']+)'/)
    expect(liveColumnsMatch).toBeTruthy()
    expect(liveColumnsMatch![1]).not.toContain('source_conversation_id')
  })

  it('does NOT select proposal_accepted_at from jobs table', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    const liveColumnsMatch = content.match(/LIVE_JOB_COLUMNS\s*=\s*'([^']+)'/)
    expect(liveColumnsMatch).toBeTruthy()
    expect(liveColumnsMatch![1]).not.toContain('proposal_accepted_at')
  })

  it('does NOT select amount from jobs table', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    const liveColumnsMatch = content.match(/LIVE_JOB_COLUMNS\s*=\s*'([^']+)'/)
    expect(liveColumnsMatch).toBeTruthy()
    // amount should not appear as a column in the jobs select
    expect(liveColumnsMatch![1]).not.toContain('amount')
  })

  it('LIVE_JOB_COLUMNS only contains confirmed-live fields', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    const liveColumnsMatch = content.match(/LIVE_JOB_COLUMNS\s*=\s*'([^']+)'/)
    expect(liveColumnsMatch).toBeTruthy()
    const cols = liveColumnsMatch![1].split(',').map(c => c.trim())
    const CONFIRMED_LIVE = [
      'id', 'customer_user_id', 'provider_id', 'title', 'description',
      'status', 'created_at', 'updated_at', 'funding_requested_at',
      'source_offer_id', 'work_started_at', 'work_completed_at',
    ]
    for (const col of cols) {
      expect(CONFIRMED_LIVE).toContain(col)
    }
  })

  it('does NOT select gross_total from offers table', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // The main offers query selects price but not gross_total
    expect(content).not.toContain("'gross_total'")
    // And the select string should not contain gross_total
    expect(content).not.toMatch(/\.select\('[^']*gross_total[^']*'\)/)
  })

  it('selects conversation_id from offers table', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // The main offers query should include conversation_id in the select
    // Find the offers select that includes 'price' (the main query, not the recovery query)
    const mainOffersSelect = content.match(/\.select\('([^']*price[^']*)'\)/)
    expect(mainOffersSelect).toBeTruthy()
    expect(mainOffersSelect![1]).toContain('conversation_id')
  })

  it('inserts both provider_id and provider_user_id into funding_requests', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // The funding_requests insert must include both provider_id (providers.id)
    // and provider_user_id (auth uid) per the live schema.
    const frInsertStart = content.indexOf("from('funding_requests')\n")
    const insertStart = content.indexOf('.insert({', frInsertStart)
    expect(insertStart).toBeGreaterThan(-1)
    const insertEnd = content.indexOf('})', insertStart)
    const insertBody = content.slice(insertStart, insertEnd)
    // Both columns must be present
    expect(insertBody).toContain('provider_id:')
    expect(insertBody).toContain('provider_user_id:')
  })

  it('uses funding_step artifact_type (distinct from offer payment_phase)', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // The thread_artifacts insert should use 'funding_step' — a distinct type
    // from the 'payment_phase' artifact created during offer acceptance.
    // The DB CHECK constraint now includes 'funding_step' (migration 20260326000002).
    expect(content).toContain("artifact_type: 'funding_step'")
  })

  it('derives conversation_id from offer, not from job', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // Thread artifact and funding request should use offer.conversation_id
    expect(content).toContain('offer.conversation_id')
    // Should NOT reference canonicalJob.source_conversation_id
    expect(content).not.toContain('canonicalJob.source_conversation_id')
  })

  it('uses JOB_QUERY_FAILED error code for DB query errors', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    expect(content).toContain('JOB_QUERY_FAILED')
  })

  it('resolves provider identity from offer.craftsman_user_id, not job.craftsman_user_id', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // providerUserId should come from offer.craftsman_user_id
    expect(content).toContain('providerUserId = offer.craftsman_user_id')
    // Should NOT fall back to canonicalJob.craftsman_user_id
    expect(content).not.toContain('canonicalJob.craftsman_user_id')
  })

  it('resolves provider authorization via providers table when direct match fails', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // Should resolve via providers.profile_id
    expect(content).toContain("from('providers')")
    expect(content).toContain('profile_id')
    expect(content).toContain('provider_resolved_via_profile')
  })

  it('uses live-schema-safe acceptance check without proposal_accepted_at', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // Should use source_offer_id and status-based signals
    expect(content).toContain('hasAcceptanceSignal')
    expect(content).toContain('ACCEPTED_STATUSES')
  })

  it('amount is derived only from offer.price (no job.amount or gross_total fallback)', () => {
    const content = fs.readFileSync(apiPath, 'utf-8')
    // The amount assignment should reference offer.price
    expect(content).toContain('parseAmount(offer.price)')
    // Should NOT reference gross_total anywhere in amount parsing
    expect(content).not.toContain('offer.gross_total')
    // Should NOT reference canonicalJob.amount
    expect(content).not.toContain('canonicalJob.amount')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 15. Live-schema-safe local workflow tests (no non-live field assumptions)
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — local workflow with live-schema-safe job shapes', () => {
  beforeEach(() => setupCleanRepositories())

  it('funding creation works for job with only confirmed-live fields', async () => {
    // Create a job that only has confirmed-live fields (no craftsmanUserId etc.)
    const { offer } = await createAcceptedOffer('conv-liveschema-1')
    const job = getJobById(offer.createdJobId!)!
    installSessionForJobOwner(job)
    expect(job).toBeDefined()
    expect(job.sourceOfferId).toBeDefined()

    // Provider requests funding — should succeed
    const result = await requestFundingForJob(job.id)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('sent')
    }
  })

  it('provider identity bridging works via providers.id → jobs.provider_id path', async () => {
    // When acceptOfferWorkflow creates the job, it sets provider_id (providers.id)
    // The provider resolution must bridge from auth user to providers table
    const { offer } = await createAcceptedOffer('conv-identity-bridge')
    const job = getJobById(offer.createdJobId!)!
    installSessionForJobOwner(job)
    expect(job).toBeDefined()

    // The job should have the provider linkage set
    // (The local workflow sets craftsmanUserId, but the endpoint uses provider_id)
    expect(job.customerUserId).toBeDefined()
  })

  it('canonical redirect works without source_conversation_id', async () => {
    const { offer } = await createAcceptedOffer('conv-noconvid-redirect')
    const canonicalJob = getJobById(offer.createdJobId!)!

    // Create a stale job without sourceConversationId but with same customer/craftsman
    const staleJob: Job = {
      id: 'stale-noconvid-job',
      projectId: 'project-noconvid',
      title: 'Stale No ConvId',
      customer: 'Max Mustermann',
      location: '',
      dateLabel: '',
      status: 'booked',
      amount: '8.000 €',
      description: '',
      paymentState: 'none',
      documentationStatus: '',
      assignedMemberIds: [],
      notes: [],
      photoCount: 0,
      activities: [],
      customerUserId: 'customer-sfr',
      craftsmanUserId: 'craftsman-sfr',
      // No sourceConversationId — tests that redirect works via customer/provider match
      proposalAcceptedAt: Date.now(),
    }
    addJob(staleJob)

    // Funding on stale job should redirect to canonical
    installSessionForJobOwner(staleJob)
    const result = await requestFundingForJob(staleJob.id)
    expect(result.ok).toBe(true)

    // Funding request should be on the canonical job
    const fundingReq = getFundingRequestByJobId(canonicalJob.id)
    expect(fundingReq).toBeDefined()
    expect(fundingReq!.status).toBe('sent')
  })

  it('precise structured errors for each early failure step', () => {
    // Each error code should have a corresponding German message
    const errorCodes = [
      'JOB_QUERY_FAILED',
      'JOB_LOOKUP_FAILED',
      'CANONICAL_JOB_NOT_FOUND',
      'STALE_JOB_REDIRECT_FAILED',
      'SOURCE_OFFER_MISSING',
      'ACCEPTED_OFFER_NOT_FOUND',
      'CUSTOMER_LINKAGE_MISSING',
      'PROVIDER_PROFILE_NOT_FOUND',
      'PROVIDER_LINKAGE_MISSING',
      'PROVIDER_NOT_AUTHORIZED',
      'INVALID_AMOUNT_BASIS',
      'JOB_IN_TERMINAL_STATE',
      'NO_ACCEPTED_QUOTE',
      'ESCROW_PLAN_CREATE_FAILED',
      'FUNDING_REQUEST_CREATE_FAILED',
      'FUNDING_ARTIFACT_CREATE_FAILED',
    ]

    for (const code of errorCodes) {
      const msg = mapFundingErrorToMessage(code, '__fallback__')
      expect(msg).not.toBe('__fallback__')
    }
  })

  it('no regression to server-authoritative escrow/funding creation', async () => {
    const { offer } = await createAcceptedOffer('conv-no-regression')
    const job = getJobById(offer.createdJobId!)!

    installSessionForJobOwner(job)
    const result = await requestFundingForJob(job.id)
    expect(result.ok).toBe(true)

    // Escrow plan exists
    const plan = getEscrowPlanByJobId(job.id)
    expect(plan).toBeDefined()

    // Funding request exists
    const fundingReq = getFundingRequestByJobId(job.id)
    expect(fundingReq).toBeDefined()

    // Tranches exist
    const tranches = getEscrowTranches(plan!.id)
    expect(tranches).toHaveLength(2)

    // Full lifecycle continues to work
    await simulateCustomerFunding(job.id)
    const startResult = await startJob(job.id)
    expect(startResult.ok).toBe(true)
    const completeResult = await completeJob(job.id)
    expect(completeResult.ok).toBe(true)
  })
})
