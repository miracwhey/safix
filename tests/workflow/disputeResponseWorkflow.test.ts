/**
 * Block N3a — submitDisputeResponseWorkflow.
 *
 * Coverage:
 * - Owner can submit at provider_waiting → description-evidence appended,
 *   status transitions to under_review, timeline events emitted, job
 *   disputeStatus mirrors.
 * - Customer can submit at customer_waiting → same.
 * - Worker (assigned and unassigned) is blocked at the workflow layer.
 * - Wrong customer / wrong owner blocked.
 * - Empty / whitespace statement blocked.
 * - Resolved / closed / cancelled / open / under_review states blocked.
 * - Immutability: a second submit after the response is committed is rejected.
 * - No Stripe-decision wording in any error message.
 * - No file/upload behaviour exercised — workflow is text-only.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'

import {
  DisputeResponseError,
  submitDisputeResponseWorkflow,
} from '../../src/lib/workflow/disputeResponseWorkflow'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import { addJob, getJobById } from '../../src/lib/jobs'
import { getDisputeRepository } from '../../src/lib/disputes/repository/registry'
import { hasTimelineEventOfType } from '../../src/lib/timeline'
import { setupCleanRepositories } from '../helpers/setupRepositories'
import {
  installMockSession,
  resetMockSession,
  mockCustomerSession,
  mockOwnerSession,
  mockWorkerSession,
} from '../helpers/mockSession'
import {
  InMemoryTeamMemberRepository,
  setTeamMemberRepository,
} from '../../src/lib/team/repository'
import type { Dispute } from '../../src/lib/disputes/types'
import type { Job, TeamMember } from '../../src/lib/jobs/types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROVIDER_ID = 'prov-n3a'
const OWNER_ID = 'owner-n3a'
const WORKER_ID = 'worker-n3a-assigned'
const UNASSIGNED_WORKER_ID = 'worker-n3a-unassigned'
const CUSTOMER_ID = 'cust-n3a'
const FOREIGN_CUSTOMER_ID = 'cust-n3a-foreign'

const TM_OWNER = 'tm-owner-n3a'
const TM_WORKER_ASSIGNED = 'tm-worker-n3a-assigned'
const TM_WORKER_UNASSIGNED = 'tm-worker-n3a-unassigned'

const ownerMember: TeamMember = {
  id: TM_OWNER,
  userId: OWNER_ID,
  providerId: PROVIDER_ID,
  fullName: 'Owner',
  role: 'owner',
}

const assignedWorkerMember: TeamMember = {
  id: TM_WORKER_ASSIGNED,
  userId: WORKER_ID,
  providerId: PROVIDER_ID,
  fullName: 'Assigned Worker',
  role: 'worker',
}

const unassignedWorkerMember: TeamMember = {
  id: TM_WORKER_UNASSIGNED,
  userId: UNASSIGNED_WORKER_ID,
  providerId: PROVIDER_ID,
  fullName: 'Unassigned Worker',
  role: 'worker',
}

function seedTeamMembers(members: TeamMember[]): void {
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: overrides.id ?? `job-n3a-${Math.random().toString(16).slice(2)}`,
    projectId: 'proj-n3a',
    title: 'Streit-Job',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: '',
    status: 'in_progress',
    amount: '4.000 €',
    description: '',
    paymentState: 'disputed',
    documentationStatus: '',
    assignedMemberIds: [TM_WORKER_ASSIGNED],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: OWNER_ID,
    customerUserId: CUSTOMER_ID,
    providerId: PROVIDER_ID,
    ...overrides,
  } as Job
}

async function seedDispute(jobId: string, status: Dispute['status']): Promise<Dispute> {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    status,
    reason: 'work_quality',
    title: 'Mängel am Werk',
    description: 'Mangelbeschreibung des Kunden.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await getDisputeRepository().add(dispute)
  return dispute
}

beforeEach(async () => {
  setupCleanRepositories()
  seedTeamMembers([ownerMember, assignedWorkerMember, unassignedWorkerMember])
  resetMockSession()
})

afterEach(() => {
  resetMockSession()
})

// ── Owner happy path ─────────────────────────────────────────────────────────

describe('submitDisputeResponseWorkflow — Provider-Owner @ provider_waiting', () => {
  it('appends description-evidence and transitions to under_review', async () => {
    const job = makeJob({ id: 'job-owner-happy' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    const result = await submitDisputeResponseWorkflow({
      jobId: job.id,
      statement: 'Wir haben den Auftrag wie vereinbart ausgeführt; Beweismaterial liegt SaFix vor.',
    })

    expect(result.status).toBe('under_review')
    expect(result.evidence?.length).toBe(1)
    const evidence = result.evidence![0]
    expect(evidence.type).toBe('description')
    expect(evidence.description).toBe(
      'Wir haben den Auftrag wie vereinbart ausgeführt; Beweismaterial liegt SaFix vor.',
    )
    expect(evidence.submittedBy).toBe(OWNER_ID)
    expect(evidence.disputeId).toBe(result.id)
    expect(evidence.url).toBeUndefined()
  })

  it('mirrors under_review onto job.disputeStatus and emits timeline events', async () => {
    const job = makeJob({ id: 'job-owner-mirror' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    await submitDisputeResponseWorkflow({
      jobId: job.id,
      statement: 'Stellungnahme an SaFix.',
    })

    expect(getJobById(job.id)?.disputeStatus).toBe('under_review')
    expect(hasTimelineEventOfType(job.id, 'dispute_evidence_attached')).toBe(true)
    expect(hasTimelineEventOfType(job.id, 'dispute_under_review')).toBe(true)
  })

  it('trims surrounding whitespace from the persisted statement', async () => {
    const job = makeJob({ id: 'job-owner-trim' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    const result = await submitDisputeResponseWorkflow({
      jobId: job.id,
      statement: '   Antwort an SaFix.   \n',
    })
    expect(result.evidence![0].description).toBe('Antwort an SaFix.')
  })
})

// ── Customer happy path ──────────────────────────────────────────────────────

describe('submitDisputeResponseWorkflow — Customer @ customer_waiting', () => {
  it('appends description-evidence and transitions to under_review', async () => {
    const job = makeJob({ id: 'job-cust-happy' })
    await addJob(job)
    await seedDispute(job.id, 'customer_waiting')
    installMockSession(mockCustomerSession(CUSTOMER_ID))

    const result = await submitDisputeResponseWorkflow({
      jobId: job.id,
      statement: 'Mein Standpunkt: die Arbeit ist nicht fertig.',
    })

    expect(result.status).toBe('under_review')
    expect(result.evidence?.length).toBe(1)
    expect(result.evidence![0].type).toBe('description')
    expect(result.evidence![0].submittedBy).toBe(CUSTOMER_ID)
    expect(getJobById(job.id)?.disputeStatus).toBe('under_review')
  })

  it('blocks a foreign customer (wrong customerUserId)', async () => {
    const job = makeJob({ id: 'job-cust-foreign' })
    await addJob(job)
    await seedDispute(job.id, 'customer_waiting')
    installMockSession(mockCustomerSession(FOREIGN_CUSTOMER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: 'Fremde Antwort.' }),
    ).rejects.toBeInstanceOf(RbacError)
  })

  it('blocks the customer when status is provider_waiting', async () => {
    const job = makeJob({ id: 'job-cust-wrong-side' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockCustomerSession(CUSTOMER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: 'Falsche Seite.' }),
    ).rejects.toBeInstanceOf(RbacError)
  })
})

// ── Worker block (Owner-only on provider side) ───────────────────────────────

describe('submitDisputeResponseWorkflow — Worker block on provider side (N3a Owner-only)', () => {
  it('blocks the assigned worker with RbacError(rbac_owner)', async () => {
    const job = makeJob({ id: 'job-assigned-worker' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockWorkerSession(WORKER_ID))

    let captured: unknown = null
    try {
      await submitDisputeResponseWorkflow({
        jobId: job.id,
        statement: 'Worker-Versuch — sollte blockiert werden.',
      })
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(RbacError)
    expect((captured as RbacError).code).toBe('rbac_owner')
  })

  it('blocks the unassigned worker with RbacError(rbac_owner)', async () => {
    const job = makeJob({ id: 'job-unassigned-worker', assignedMemberIds: [TM_WORKER_ASSIGNED] })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockWorkerSession(UNASSIGNED_WORKER_ID))

    let captured: unknown = null
    try {
      await submitDisputeResponseWorkflow({ jobId: job.id, statement: 'Versuch.' })
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(RbacError)
    expect((captured as RbacError).code).toBe('rbac_owner')
  })

  it('keeps the dispute at provider_waiting when a worker submit is rejected', async () => {
    const job = makeJob({ id: 'job-worker-no-side-effect' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockWorkerSession(WORKER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: 'Versuch.' }),
    ).rejects.toBeInstanceOf(RbacError)

    const after = getDisputeRepository().getByJobId(job.id)
    expect(after?.status).toBe('provider_waiting')
    expect(after?.evidence ?? []).toHaveLength(0)
  })
})

// ── Validation ───────────────────────────────────────────────────────────────

describe('submitDisputeResponseWorkflow — input validation', () => {
  it('rejects an empty statement', async () => {
    const job = makeJob({ id: 'job-empty' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: '' }),
    ).rejects.toMatchObject({ code: 'dispute_response_empty' })
  })

  it('rejects a whitespace-only statement', async () => {
    const job = makeJob({ id: 'job-whitespace' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: '   \n\t  ' }),
    ).rejects.toMatchObject({ code: 'dispute_response_empty' })
  })
})

// ── Status guards ────────────────────────────────────────────────────────────

describe('submitDisputeResponseWorkflow — status guards', () => {
  it.each(['resolved', 'closed', 'cancelled'] as const)(
    'rejects %s disputes with dispute_terminal',
    async (status) => {
      const job = makeJob({ id: `job-${status}` })
      await addJob(job)
      await seedDispute(job.id, status)
      installMockSession(mockOwnerSession(OWNER_ID))

      await expect(
        submitDisputeResponseWorkflow({ jobId: job.id, statement: 'späte Antwort' }),
      ).rejects.toMatchObject({ code: 'dispute_terminal' })
    },
  )

  it.each(['open', 'under_review'] as const)(
    'rejects %s disputes with dispute_not_awaiting_response',
    async (status) => {
      const job = makeJob({ id: `job-${status}` })
      await addJob(job)
      await seedDispute(job.id, status)
      installMockSession(mockOwnerSession(OWNER_ID))

      await expect(
        submitDisputeResponseWorkflow({ jobId: job.id, statement: 'unaufgefordert' }),
      ).rejects.toMatchObject({ code: 'dispute_not_awaiting_response' })
    },
  )

  it('rejects a missing dispute with dispute_not_found', async () => {
    const job = makeJob({ id: 'job-no-dispute' })
    await addJob(job)
    installMockSession(mockOwnerSession(OWNER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: 'kein Streit vorhanden' }),
    ).rejects.toMatchObject({ code: 'dispute_not_found' })
  })

  it('rejects a missing job with job_not_found', async () => {
    // dispute exists for a job that was never added — guard catches it.
    await seedDispute('job-orphan', 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    await expect(
      submitDisputeResponseWorkflow({ jobId: 'job-orphan', statement: 'Antwort' }),
    ).rejects.toMatchObject({ code: 'job_not_found' })
  })
})

// ── Immutability (no edit-after-submit) ──────────────────────────────────────

describe('submitDisputeResponseWorkflow — immutability', () => {
  it('rejects a second submit because the dispute is now under_review', async () => {
    const job = makeJob({ id: 'job-immutable' })
    await addJob(job)
    await seedDispute(job.id, 'provider_waiting')
    installMockSession(mockOwnerSession(OWNER_ID))

    const first = await submitDisputeResponseWorkflow({
      jobId: job.id,
      statement: 'Erste Stellungnahme.',
    })
    expect(first.status).toBe('under_review')

    await expect(
      submitDisputeResponseWorkflow({ jobId: job.id, statement: 'Zweiter Versuch.' }),
    ).rejects.toMatchObject({ code: 'dispute_not_awaiting_response' })

    const persisted = getDisputeRepository().getByJobId(job.id)
    expect(persisted?.evidence?.length).toBe(1)
    expect(persisted?.evidence?.[0]?.description).toBe('Erste Stellungnahme.')
  })
})

// ── Wording contract ─────────────────────────────────────────────────────────

describe('submitDisputeResponseWorkflow — wording contract', () => {
  // Word-boundary regex avoids false positives from fixture slugs that contain
  // the substring "stripe" by accident.
  const STRIPE_WORD = /\bstripe\b/i

  it('never mentions Stripe in any thrown error message', async () => {
    const job = makeJob({ id: 'job-no-payment-rail-wording' })
    await addJob(job)
    await seedDispute(job.id, 'resolved')
    installMockSession(mockOwnerSession(OWNER_ID))

    let captured: unknown = null
    try {
      await submitDisputeResponseWorkflow({ jobId: job.id, statement: 'late' })
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(DisputeResponseError)
    expect((captured as Error).message).not.toMatch(STRIPE_WORD)
  })

  it('error messages reference SaFix/operator (not Stripe) for not-awaiting-response', async () => {
    const job = makeJob({ id: 'job-fixup-wording' })
    await addJob(job)
    await seedDispute(job.id, 'under_review')
    installMockSession(mockOwnerSession(OWNER_ID))

    let captured: unknown = null
    try {
      await submitDisputeResponseWorkflow({ jobId: job.id, statement: 'früh' })
    } catch (err) {
      captured = err
    }
    expect((captured as Error).message).not.toMatch(STRIPE_WORD)
    expect((captured as Error).message.toLowerCase()).toContain('safix')
  })
})

// ── H24 regression pin: RPC path, never a direct status UPDATE ──────────────

describe('submitDisputeResponseWorkflow — H24 RPC gate pin', () => {
  it('routes through partySubmitStatement exactly once and never through update()', async () => {
    const job = makeJob({ id: 'job-h24-rpc-pin' })
    await addJob(job)
    await seedDispute(job.id, 'customer_waiting')
    installMockSession(mockCustomerSession(CUSTOMER_ID))

    const repo = getDisputeRepository()
    const { vi } = await import('vitest')
    const partySpy = vi.spyOn(repo, 'partySubmitStatement')
    const updateSpy = vi.spyOn(repo, 'update')

    try {
      const result = await submitDisputeResponseWorkflow({
        jobId: job.id,
        statement: 'Meine Stellungnahme an SaFix.',
      })

      expect(result.status).toBe('under_review')
      // The trigger guard in prod rejects a direct disputes UPDATE with a
      // status change (42501) — the workflow MUST use the SECDEF RPC path.
      expect(partySpy).toHaveBeenCalledTimes(1)
      expect(updateSpy).not.toHaveBeenCalled()
    } finally {
      partySpy.mockRestore()
      updateSpy.mockRestore()
    }
  })
})
