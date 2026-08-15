import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installMockSession,
  mockOwnerSession,
  mockWorkerSession,
  resetMockSession,
} from '../helpers/mockSession'
import { setJobRepository } from '../../src/lib/jobs/repository/registry'
import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import {
  reassignSpringerWorkflow,
  selectJobsForSpringer,
} from '../../src/lib/workflow/springerReassignmentWorkflow'
import { RbacError } from '../../src/lib/auth/rbacGuards'
import type { Job } from '../../src/lib/jobs/types'

const OWNER_USER_ID = 'u-owner'
const FROM_MEMBER = 'm-anna'
const TO_MEMBER = 'm-bert'

function makeJob(id: string, assignedMemberIds: string[], status: Job['status'] = 'in_progress'): Job {
  return {
    id,
    projectId: 'p-1',
    title: id,
    customer: 'Müller',
    location: 'Bahnhofstr. 1',
    dateLabel: 'heute',
    status,
    amount: '0',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds,
    notes: [],
    photoCount: 0,
    activities: [],
    proposalAcceptedAt: Date.now(),
  } as Job
}

let repo: InMemoryJobRepository

beforeEach(() => {
  repo = new InMemoryJobRepository([
    makeJob('j-1', [FROM_MEMBER]),
    makeJob('j-2', [FROM_MEMBER, 'm-other']),
    makeJob('j-3', ['m-other'], 'in_progress'),
    makeJob('j-4', [FROM_MEMBER], 'completed'),
  ])
  setJobRepository(repo)
})

afterEach(() => {
  resetMockSession()
  vi.restoreAllMocks()
})

describe('reassignSpringerWorkflow', () => {
  it('owner can reassign all jobs in one call', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const results = await reassignSpringerWorkflow(['j-1', 'j-2'], FROM_MEMBER, TO_MEMBER)
    expect(results.every((r) => r.status === 'reassigned')).toBe(true)
    expect(repo.getById('j-1')!.assignedMemberIds).toEqual([TO_MEMBER])
    expect(repo.getById('j-2')!.assignedMemberIds.sort()).toEqual([TO_MEMBER, 'm-other'])
  })

  it('rejects when caller is not owner', async () => {
    installMockSession(mockWorkerSession('u-anna'))
    await expect(reassignSpringerWorkflow(['j-1'], FROM_MEMBER, TO_MEMBER)).rejects.toBeInstanceOf(
      RbacError,
    )
  })

  it('rejects when fromMemberId equals toMemberId', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    await expect(reassignSpringerWorkflow(['j-1'], FROM_MEMBER, FROM_MEMBER)).rejects.toThrow(
      'must differ',
    )
  })

  it('continues across jobs when one fails (idempotent recovery)', async () => {
    installMockSession(mockOwnerSession(OWNER_USER_ID))
    const original = repo.reassignAssignedMember.bind(repo)
    let calls = 0
    vi.spyOn(repo, 'reassignAssignedMember').mockImplementation(async (jobId, from, to) => {
      calls++
      if (calls === 1) throw new Error('rpc-down')
      return original(jobId, from, to)
    })
    const results = await reassignSpringerWorkflow(['j-1', 'j-2'], FROM_MEMBER, TO_MEMBER)
    expect(results[0]!.status).toBe('failed')
    expect(results[1]!.status).toBe('reassigned')
  })
})

describe('selectJobsForSpringer', () => {
  it('returns operational jobs assigned to the from-member', () => {
    const jobs = [
      makeJob('j-1', [FROM_MEMBER]),
      makeJob('j-2', [FROM_MEMBER, 'm-other']),
      makeJob('j-3', ['m-other']),
      makeJob('j-4', [FROM_MEMBER], 'completed'),
    ]
    const result = selectJobsForSpringer(jobs, FROM_MEMBER)
    expect(result.map((j) => j.id).sort()).toEqual(['j-1', 'j-2'])
  })
})
