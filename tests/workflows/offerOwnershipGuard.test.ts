/**
 * H13 — acceptOfferWorkflow ownership guard (workflow-layer RBAC, third
 * defense layer).
 *
 * RLS blocks a foreign accept at the jobs-INSERT ("Jobs: insert own
 * customer" WITH CHECK customer_user_id = auth.uid()) — but it does NOT
 * block a craftsman self-accepting his own offer when a job already exists
 * (inquiry-conversion path): the remaining writes are jobs-UPDATEs and an
 * offers-UPDATE, both of which prod RLS permits the provider. The workflow
 * guard fails closed on an identified caller mismatch and delegates the
 * no-session case to RLS (without a JWT every Supabase write fails anyway).
 *
 * Pattern: tests/jobs/workflowRbac.test.ts + tests/helpers/mockSession.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  createOfferWorkflow,
  acceptOfferWorkflow,
} from '../../src/lib/workflow/offerWorkflow'
import { getOfferRepository } from '../../src/lib/offers/repository/registry'
import { getJobRepository } from '../../src/lib/jobs/repository/registry'
import { updateOffer } from '../../src/lib/offers/service'
import { addJob } from '../../src/lib/jobs'
import { getPaymentForJob } from '../../src/lib/payments'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import {
  installMockSession,
  mockCustomerSession,
  mockOwnerSession,
  resetMockSession,
} from '../helpers/mockSession'
import type { Job } from '../../src/lib/jobs/types'

const CUSTOMER_ID = 'cust-h13'
const CRAFTSMAN_ID = 'craft-h13'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-h13',
    projectId: 'proj-h13',
    title: 'Bestandsjob',
    customer: 'Customer',
    location: 'Hannover',
    dateLabel: 'Termin offen',
    status: 'booked',
    amount: '1.000 €',
    description: '',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: CRAFTSMAN_ID,
    customerUserId: CUSTOMER_ID,
    providerId: 'prov-h13',
    ...overrides,
  } as Job
}

async function createPendingOffer(conversationId = 'conv-h13') {
  return createOfferWorkflow({
    conversationId,
    customerUserId: CUSTOMER_ID,
    craftsmanUserId: CRAFTSMAN_ID,
    price: '1.000 €',
  })
}

beforeEach(() => {
  setupCleanRepositories()
  resetMockSession()
})

afterEach(() => {
  resetMockSession()
})

describe('H13 — acceptOfferWorkflow ownership guard (session arg)', () => {
  it('blocks the craftsman from self-accepting his own offer (no write happens)', async () => {
    const offer = await createPendingOffer()

    const err: unknown = await acceptOfferWorkflow(
      offer.id,
      mockOwnerSession(CRAFTSMAN_ID),
    ).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(RbacError)
    expect((err as RbacError).code).toBe('rbac_customer')

    // No write happened: offer untouched, no job created.
    const fromRepo = getOfferRepository().getById(offer.id)
    expect(fromRepo!.status).toBe('pending')
    expect(fromRepo!.createdJobId).toBeUndefined()
    expect(getJobRepository().getAll()).toHaveLength(0)
  })

  it('blocks a foreign customer from accepting', async () => {
    const offer = await createPendingOffer()

    await expect(
      acceptOfferWorkflow(offer.id, mockCustomerSession('cust-intruder')),
    ).rejects.toThrow(RbacError)

    const fromRepo = getOfferRepository().getById(offer.id)
    expect(fromRepo!.status).toBe('pending')
    expect(getJobRepository().getAll()).toHaveLength(0)
  })

  it('lets the matching customer accept (job created, status accepted)', async () => {
    const offer = await createPendingOffer()

    const accepted = await acceptOfferWorkflow(offer.id, mockCustomerSession(CUSTOMER_ID))

    expect(accepted).toBeDefined()
    expect(accepted!.status).toBe('accepted')
    expect(accepted!.createdJobId).toBeDefined()
    expect(getJobRepository().getById(accepted!.createdJobId!)).toBeDefined()
  })

  it('guards the idempotent already-accepted branch (throw BEFORE payment/escrow writes)', async () => {
    // The idempotent branch performs writes (markProposalSent,
    // ensurePaymentForJob, ensureEscrowPlan) for an already-accepted offer
    // with a linked job — the guard must run before it. This is the
    // sharpest variant of the craftsman-self-accept exploit: a job already
    // exists, so the jobs-INSERT RLS check never fires.
    const job = makeJob()
    await addJob(job)
    const offer = await createPendingOffer()
    await updateOffer(offer.id, (o) => ({
      ...o,
      status: 'accepted' as const,
      acceptedAt: Date.now(),
      createdJobId: job.id,
    }))

    await expect(
      acceptOfferWorkflow(offer.id, mockOwnerSession(CRAFTSMAN_ID)),
    ).rejects.toThrow(RbacError)

    // No write from the idempotent branch happened.
    expect(getPaymentForJob(job.id)).toBeUndefined()
    expect(getJobRepository().getById(job.id)!.proposalSentAt).toBeUndefined()
  })

  it('returns undefined for unknown offers before consulting the guard', async () => {
    await expect(
      acceptOfferWorkflow('offer-does-not-exist', mockOwnerSession(CRAFTSMAN_ID)),
    ).resolves.toBeUndefined()
  })
})

describe('H13 — getSession() default path (installMockSession)', () => {
  it('blocks a mismatching installed session without explicit session arg', async () => {
    const offer = await createPendingOffer()
    installMockSession(mockCustomerSession('cust-intruder'))

    await expect(acceptOfferWorkflow(offer.id)).rejects.toThrow(RbacError)

    const fromRepo = getOfferRepository().getById(offer.id)
    expect(fromRepo!.status).toBe('pending')
  })

  it('lets the matching installed customer session accept', async () => {
    const offer = await createPendingOffer()
    installMockSession(mockCustomerSession(CUSTOMER_ID))

    const accepted = await acceptOfferWorkflow(offer.id)

    expect(accepted!.status).toBe('accepted')
    expect(accepted!.createdJobId).toBeDefined()
  })
})

describe('H13 — RLS delegation when no validated user exists', () => {
  it('does not throw for a session-less caller (documented behavior: RLS is the gate)', async () => {
    // Without a validated user the guard intentionally passes through:
    // against Supabase every write would fail under the caller's own JWT
    // anyway, and the existing in-memory suites call this workflow
    // session-less by design. The default test session has user = null.
    const offer = await createPendingOffer()

    const accepted = await acceptOfferWorkflow(offer.id)

    expect(accepted!.status).toBe('accepted')
    expect(accepted!.createdJobId).toBeDefined()
  })
})
