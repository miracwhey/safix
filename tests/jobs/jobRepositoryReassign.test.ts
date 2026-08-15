import { describe, expect, it } from 'vitest'

import { InMemoryJobRepository } from '../../src/lib/jobs/repository/InMemoryJobRepository'
import type { Job } from '../../src/lib/jobs/types'

function makeJob(assignedMemberIds: string[], id = 'j-1'): Job {
  return {
    id,
    projectId: 'p-1',
    title: 'Bad',
    customer: 'Müller',
    location: 'Müllerstr. 14',
    dateLabel: 'heute',
    status: 'in_progress',
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

describe('InMemoryJobRepository.reassignAssignedMember', () => {
  it('swaps from-member for to-member when from is present and to is missing', async () => {
    const repo = new InMemoryJobRepository([makeJob(['m-1', 'm-3'])])
    const result = await repo.reassignAssignedMember('j-1', 'm-1', 'm-2')
    expect(result.assignedMemberIds.sort()).toEqual(['m-2', 'm-3'])
    expect(repo.getById('j-1')!.assignedMemberIds.sort()).toEqual(['m-2', 'm-3'])
  })

  it('removes from-member without duplicating when to-member already present', async () => {
    const repo = new InMemoryJobRepository([makeJob(['m-1', 'm-2'])])
    const result = await repo.reassignAssignedMember('j-1', 'm-1', 'm-2')
    expect(result.assignedMemberIds).toEqual(['m-2'])
  })

  it('appends to-member when from-member is missing (idempotent recovery path)', async () => {
    const repo = new InMemoryJobRepository([makeJob(['m-3'])])
    const result = await repo.reassignAssignedMember('j-1', 'm-1', 'm-2')
    expect(result.assignedMemberIds.sort()).toEqual(['m-2', 'm-3'])
  })

  it('is no-op when both from missing and to already present', async () => {
    const repo = new InMemoryJobRepository([makeJob(['m-2'])])
    const result = await repo.reassignAssignedMember('j-1', 'm-1', 'm-2')
    expect(result.assignedMemberIds).toEqual(['m-2'])
  })

  it('throws when job is not found', async () => {
    const repo = new InMemoryJobRepository([])
    await expect(repo.reassignAssignedMember('j-missing', 'm-1', 'm-2')).rejects.toThrow(
      'Job not found',
    )
  })

  it('notifies subscribers after the reassign', async () => {
    const repo = new InMemoryJobRepository([makeJob(['m-1'])])
    let callCount = 0
    repo.subscribe(() => {
      callCount++
    })
    await repo.reassignAssignedMember('j-1', 'm-1', 'm-2')
    expect(callCount).toBeGreaterThan(0)
  })
})
