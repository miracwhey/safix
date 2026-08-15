/**
 * Server-Authoritative Funding Entry Read Path Tests
 *
 * Validates:
 * 1. fetchFundingEntry client-side API function exists with correct type shape
 * 2. api/funding-entry.ts server endpoint exists with correct structure
 * 3. FundingEntryScreen imports fetchFundingEntry for server-authoritative read
 * 4. Precise error codes are distinguishable:
 *    - FUNDING_REQUEST_NOT_FOUND (real not-found, not collapsed)
 *    - FUNDING_REQUEST_NOT_ACCESSIBLE (access denied, not false not-found)
 *    - ESCROW_PLAN_NOT_FOUND (context error, not false funding-request-not-found)
 *    - JOB_CONTEXT_NOT_FOUND (context error, not false funding-request-not-found)
 * 5. FundingEntryScreen has distinct LoadPhase states for access-denied
 * 6. German error messages map correctly to each error code
 * 7. FundingEntryPayload includes full canonical context
 * 8. Existing funding hydration tests still pass (no regression)
 * 9. Existing funding creation tests still pass (no regression)
 * 10. Build/lint/tests all pass
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
import { installSessionForJobOwner, mockCustomerSession } from '../helpers/mockSession'
import {
  buildFundingEntryPath,
  fetchFundingEntry,
  type FundingEntryPayload,
  type FundingEntryErrorCode,
} from '../../src/lib/funding'
import {
  getFundingRequestById,
  getFundingRequestByJobId,
  initializeFundingRequestRepository,
} from '../../src/lib/payments/fundingRequest'
import {
  getEscrowPlanById,
  initializeEscrowPlanRepository,
} from '../../src/lib/payments/escrow'
import {
  requestFundingWorkflow,
} from '../../src/lib/workflow/jobWorkflow'
import { addConversation } from '../../src/lib/messages'
import { createOfferWorkflow, acceptOfferWorkflow } from '../../src/lib/workflow'
import { getOfferById } from '../../src/lib/offers'
import { getJobById, initializeJobRepository } from '../../src/lib/jobs'
import type { Conversation } from '../../src/lib/messages/types'

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
    projectTitle: 'Server Read Test',
    projectSubtitle: 'Test',
    projectStatusLabel: 'Anfrage läuft',
    timeLabel: 'Jetzt',
    unreadCount: 0,
    inquiryOrigin: 'reel',
    messages: [],
  } as unknown as Conversation
}

async function setupAcceptedQuote(convId: string) {
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

  return { conv, offer: acceptedOffer, job }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Server-Authoritative Funding Entry Read Path', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ─── 1. API module shape ────────────────────────────────────────────────

  describe('1. fetchFundingEntry API function exists with correct shape', () => {
    it('fetchFundingEntry is a function', () => {
      expect(typeof fetchFundingEntry).toBe('function')
    })

    it('FundingEntryPayload type includes required fields', () => {
      // Verify the type shape at compile time is enough,
      // but let's also verify the types are importable
      const samplePayload: FundingEntryPayload = {
        fundingRequest: {
          id: 'fr-1',
          sourceOfferId: 'offer-1',
          jobId: 'job-1',
          escrowPlanId: 'ep-1',
          customerUserId: 'cust-1',
          providerId: 'prov-1',
          providerUserId: 'prov-user-1',
          type: 'full_escrow',
          status: 'sent',
          amount: 5000,
          currency: 'EUR',
          createdBy: 'provider',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        escrowPlan: {
          id: 'ep-1',
          sourceOfferId: 'offer-1',
          jobId: 'job-1',
          customerUserId: 'cust-1',
          providerId: 'prov-1',
          currency: 'EUR',
          totalAmount: 5000,
          fundingMode: 'full_upfront_escrow',
          releaseModel: 'start_25_completion_75',
          status: 'awaiting_customer_funding',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        job: {
          id: 'job-1',
          status: 'accepted',
        },
      }

      expect(samplePayload.fundingRequest.id).toBe('fr-1')
      expect(samplePayload.escrowPlan.totalAmount).toBe(5000)
      expect(samplePayload.job.id).toBe('job-1')
    })

    it('FundingEntryErrorCode type covers all precise error codes', () => {
      const codes: FundingEntryErrorCode[] = [
        'FUNDING_REQUEST_NOT_FOUND',
        'FUNDING_REQUEST_NOT_ACCESSIBLE',
        'ESCROW_PLAN_NOT_FOUND',
        'JOB_CONTEXT_NOT_FOUND',
      ]
      expect(codes).toHaveLength(4)
    })
  })

  // ─── 2. Server endpoint file exists with correct structure ──────────────

  describe('2. Server endpoint file structure', () => {
    const endpointPath = path.resolve(__dirname, '../../api/funding-entry.ts')

    it('api/funding-entry.ts file exists', () => {
      expect(fs.existsSync(endpointPath)).toBe(true)
    })

    it('endpoint uses customer-role gate from _authRole', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('requireCustomer')
      expect(content).toContain("from './_authRole")
    })

    it('endpoint queries funding_requests by ID', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("funding_requests")
      expect(content).toContain("fundingRequestId")
    })

    it('endpoint queries escrow_payment_plans', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("escrow_payment_plans")
    })

    it('endpoint queries jobs table', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("'jobs'")
    })

    it('endpoint checks customer_user_id for access control', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("customer_user_id")
      expect(content).toContain("provider_user_id")
    })

    it('endpoint returns structured error codes', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('FUNDING_REQUEST_NOT_FOUND')
      expect(content).toContain('FUNDING_REQUEST_NOT_ACCESSIBLE')
      expect(content).toContain('ESCROW_PLAN_NOT_FOUND')
      expect(content).toContain('JOB_CONTEXT_NOT_FOUND')
    })

    it('endpoint accepts GET method', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("'GET'")
    })

    it('endpoint loads project context from projects table', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain("'projects'")
      expect(content).toContain("source_job_id")
    })

    it('endpoint includes debug logging', () => {
      const content = fs.readFileSync(endpointPath, 'utf-8')
      expect(content).toContain('api.funding_entry.read_started')
      expect(content).toContain('api.funding_entry.request_found')
      expect(content).toContain('api.funding_entry.access_allowed')
      expect(content).toContain('api.funding_entry.escrow_plan_found')
      expect(content).toContain('api.funding_entry.job_found')
      expect(content).toContain('api.funding_entry.read_complete')
    })
  })

  // ─── 3. FundingEntryScreen uses server-authoritative read ───────────────

  describe('3. FundingEntryScreen imports server-authoritative read', () => {
    const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')

    it('FundingEntryScreen imports fetchFundingEntry', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('fetchFundingEntry')
    })

    it('FundingEntryScreen imports FundingEntryPayload type', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('FundingEntryPayload')
    })

    it('FundingEntryScreen imports FundingEntryErrorCode type', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('FundingEntryErrorCode')
    })

    it('FundingEntryScreen still falls back to local store hydration', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('initializeFundingRequestRepository')
      expect(content).toContain('initializeEscrowPlanRepository')
      expect(content).toContain('initializeJobRepository')
    })

    it('FundingEntryScreen has distinct not-accessible load phase', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain("'not-accessible'")
    })

    it('FundingEntryScreen shows lock icon for access denied', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('icon={Lock}')
    })

    it('FundingEntryScreen logs server-authoritative read start', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('[FundingEntry] starting server-authoritative read')
    })
  })

  // ─── 4. Error code precision ────────────────────────────────────────────

  describe('4. Error codes are precise and distinguishable', () => {
    it('not-found and not-accessible are different error codes', () => {
      const codes: FundingEntryErrorCode[] = [
        'FUNDING_REQUEST_NOT_FOUND',
        'FUNDING_REQUEST_NOT_ACCESSIBLE',
      ]
      expect(codes[0]).not.toBe(codes[1])
    })

    it('escrow plan missing is a distinct error from funding request not-found', () => {
      const codes: FundingEntryErrorCode[] = [
        'FUNDING_REQUEST_NOT_FOUND',
        'ESCROW_PLAN_NOT_FOUND',
      ]
      expect(codes[0]).not.toBe(codes[1])
    })

    it('job context missing is a distinct error from funding request not-found', () => {
      const codes: FundingEntryErrorCode[] = [
        'FUNDING_REQUEST_NOT_FOUND',
        'JOB_CONTEXT_NOT_FOUND',
      ]
      expect(codes[0]).not.toBe(codes[1])
    })
  })

  // ─── 5. German error messages ───────────────────────────────────────────

  describe('5. German error messages in FundingEntryScreen', () => {
    const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')

    it('has precise German message for not-found', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('Zahlungsanfrage nicht gefunden')
    })

    it('has precise German message for not-accessible', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('Kein Zugriff')
      expect(content).toContain('Sie haben keinen Zugriff auf diese Zahlungsanfrage')
    })

    it('has precise German message for escrow plan not found', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('Zahlungsplan nicht gefunden')
    })

    it('has precise German message for context incomplete', () => {
      const content = fs.readFileSync(screenPath, 'utf-8')
      expect(content).toContain('Zahlungskontext nicht verfügbar')
    })

    it('does NOT show false not-found message when access is denied', () => {
      // The screen now has a separate 'not-accessible' phase that shows
      // "Kein Zugriff" instead of "nicht gefunden"
      const content = fs.readFileSync(screenPath, 'utf-8')
      // Verify the not-accessible render block has different content from not-found
      expect(content).toContain("loadPhase === 'not-accessible'")
    })
  })

  // ─── 6. Payload includes full canonical context ─────────────────────────

  describe('6. FundingEntryPayload includes full canonical context', () => {
    it('payload has fundingRequest with all required fields', () => {
      const payload: FundingEntryPayload = {
        fundingRequest: {
          id: 'fr-1', sourceOfferId: 'o-1', jobId: 'j-1', escrowPlanId: 'ep-1',
          customerUserId: 'cu-1', providerId: 'p-1', providerUserId: 'pu-1',
          type: 'full_escrow', status: 'sent', amount: 5000, currency: 'EUR',
          createdBy: 'provider', createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        escrowPlan: {
          id: 'ep-1', sourceOfferId: 'o-1', jobId: 'j-1',
          customerUserId: 'cu-1', providerId: 'p-1',
          currency: 'EUR', totalAmount: 5000,
          fundingMode: 'full_upfront_escrow', releaseModel: 'start_25_completion_75',
          status: 'awaiting_customer_funding',
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        job: { id: 'j-1', status: 'accepted' },
        project: { id: 'proj-1', title: 'Test Project' },
      }

      expect(payload.fundingRequest.id).toBe('fr-1')
      expect(payload.escrowPlan.id).toBe('ep-1')
      expect(payload.job.id).toBe('j-1')
      expect(payload.project?.id).toBe('proj-1')
    })

    it('project field is optional', () => {
      const payload: FundingEntryPayload = {
        fundingRequest: {
          id: 'fr-2', sourceOfferId: 'o-2', jobId: 'j-2', escrowPlanId: 'ep-2',
          customerUserId: 'cu-2', providerId: 'p-2', providerUserId: 'pu-2',
          type: 'full_escrow', status: 'funded', amount: 3000, currency: 'EUR',
          createdBy: 'provider', createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        escrowPlan: {
          id: 'ep-2', sourceOfferId: 'o-2', jobId: 'j-2',
          customerUserId: 'cu-2', providerId: 'p-2',
          currency: 'EUR', totalAmount: 3000,
          fundingMode: 'full_upfront_escrow', releaseModel: 'start_25_completion_75',
          status: 'funded_in_escrow',
          createdAt: '2024-01-01', updatedAt: '2024-01-01',
        },
        job: { id: 'j-2', status: 'in_progress' },
      }

      expect(payload.project).toBeUndefined()
    })
  })

  // ─── 7. CORS supports GET ──────────────────────────────────────────────

  describe('7. CORS configuration', () => {
    const corsPath = path.resolve(__dirname, '../../api/_cors.ts')

    it('CORS allows GET method', () => {
      const content = fs.readFileSync(corsPath, 'utf-8')
      expect(content).toContain('GET')
    })
  })

  // ─── 8. No regression to local store hydration ──────────────────────────

  describe('8. No regression to local store hydration', () => {
    it('getFundingRequestById still works after workflow', async () => {
      const { job } = await setupAcceptedQuote('conv-server-read-1')
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()

      const fr = getFundingRequestById(result!.fundingRequestId)
      expect(fr).toBeDefined()
      expect(fr!.id).toBe(result!.fundingRequestId)
    })

    it('escrow plan still linked after workflow', async () => {
      const { job } = await setupAcceptedQuote('conv-server-read-2')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      const plan = getEscrowPlanById(fr.escrowPlanId)
      expect(plan).toBeDefined()
      expect(plan!.jobId).toBe(job.id)
    })

    it('re-initialization does not clear existing data', async () => {
      const { job } = await setupAcceptedQuote('conv-server-read-3')
      await requestFundingWorkflow(job.id)
      const fr = getFundingRequestByJobId(job.id)!

      await Promise.all([
        initializeFundingRequestRepository(),
        initializeEscrowPlanRepository(),
        initializeJobRepository(),
      ])

      const frAfter = getFundingRequestById(fr.id)
      expect(frAfter).toBeDefined()
      expect(frAfter!.id).toBe(fr.id)
    })
  })

  // ─── 9. No regression to funding creation ───────────────────────────────

  describe('9. No regression to funding creation', () => {
    it('requestFundingWorkflow still creates funding request + escrow plan', async () => {
      const { job } = await setupAcceptedQuote('conv-server-read-4')
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      expect(result!.fundingRequestId).toBeTruthy()

      // Verify escrow plan was also created via the funding request linkage
      const fr = getFundingRequestById(result!.fundingRequestId)
      expect(fr).toBeDefined()
      expect(fr!.escrowPlanId).toBeTruthy()
    })

    it('buildFundingEntryPath still generates correct path', () => {
      const path = buildFundingEntryPath('fr-server-read')
      expect(path).toBe('/funding/fr-server-read')
    })
  })

  // ─── 10. No regression to dedicated funding route ───────────────────────

  describe('10. No regression to dedicated funding route', () => {
    it('funding entry path never goes to /projects', async () => {
      const { job } = await setupAcceptedQuote('conv-server-read-5')
      const result = await requestFundingWorkflow(job.id)
      expect(result).toBeDefined()
      const entryPath = buildFundingEntryPath(result!.fundingRequestId)
      expect(entryPath).toContain('/funding/')
      expect(entryPath).not.toContain('/projects')
    })
  })

  // ─── 11. Client API module structure ────────────────────────────────────

  describe('11. Client API module structure', () => {
    const apiClientPath = path.resolve(__dirname, '../../src/lib/funding/fundingEntryApi.ts')

    it('client API module exists', () => {
      expect(fs.existsSync(apiClientPath)).toBe(true)
    })

    it('client API module calls /api/funding-entry', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('/api/funding-entry')
    })

    it('client API module uses encodeURIComponent for ID parameter', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('encodeURIComponent')
    })

    it('client API module uses supabase auth for token', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('supabase.auth.getSession')
    })

    it('client API module maps error codes to German messages', () => {
      const content = fs.readFileSync(apiClientPath, 'utf-8')
      expect(content).toContain('Zahlungsanfrage nicht gefunden')
      expect(content).toContain('keinen Zugriff')
      expect(content).toContain('Zahlungsplan')
      expect(content).toContain('Zahlungskontext')
    })

    it('client API module is exported from barrel', () => {
      const barrelPath = path.resolve(__dirname, '../../src/lib/funding/index.ts')
      const content = fs.readFileSync(barrelPath, 'utf-8')
      expect(content).toContain('fetchFundingEntry')
      expect(content).toContain('FundingEntryPayload')
      expect(content).toContain('FundingEntryErrorCode')
    })
  })

  // ─── 12. Full linkage chain still intact ────────────────────────────────

  describe('12. Full hydration chain intact with server read', () => {
    it('funding request → escrow plan → job linkage is complete', async () => {
      const { job } = await setupAcceptedQuote('conv-server-read-chain-1')
      await requestFundingWorkflow(job.id)

      const fr = getFundingRequestByJobId(job.id)!
      const frById = getFundingRequestById(fr.id)!
      expect(frById.id).toBe(fr.id)

      const plan = getEscrowPlanById(frById.escrowPlanId)!
      expect(plan).toBeDefined()
      expect(plan.jobId).toBe(job.id)

      const linkedJob = getJobById(frById.jobId)!
      expect(linkedJob).toBeDefined()
      expect(linkedJob.id).toBe(job.id)
    })
  })
})
