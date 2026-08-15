import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  RbacError,
  assertCustomerRole,
  assertJobCustomer,
  assertJobProviderOwner,
  assertJobWorkerOrOwner,
  assertOwnerRole,
} from '../../src/lib/auth/rbacGuards'
import {
  installMockSession,
  mockCustomerSession,
  mockOwnerSession,
  mockWorkerSession,
  resetMockSession,
} from '../helpers/mockSession'
import {
  setTeamMemberRepository,
} from '../../src/lib/team/repository'
import { InMemoryTeamMemberRepository } from '../../src/lib/team/repository/InMemoryTeamMemberRepository'
import type { TeamMember, Job } from '../../src/lib/jobs/types'

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    projectId: 'proj-1',
    title: 'Test Job',
    customer: 'Customer',
    location: 'Berlin',
    dateLabel: '',
    status: 'in_progress',
    amount: '100 €',
    description: '',
    paymentState: 'in_escrow',
    documentationStatus: '',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    craftsmanUserId: 'owner-1',
    customerUserId: 'cust-1',
    providerId: 'prov-1',
    ...overrides,
  } as Job
}

function seedTeamMembers(members: TeamMember[]): void {
  // The default in-memory repo preloads `teamMembersMock`, which would
  // pollute the small RBAC test surface here. Construct one and then
  // overwrite its private array so only the explicit members are visible.
  const repo = new InMemoryTeamMemberRepository()
  ;(repo as unknown as { members: TeamMember[] }).members = [...members]
  setTeamMemberRepository(repo)
}

beforeEach(() => {
  resetMockSession()
  seedTeamMembers([])
})

afterEach(() => {
  resetMockSession()
})

describe('RbacError', () => {
  it('carries the code passed to the constructor', () => {
    const err = new RbacError('rbac_customer', 'msg')
    expect(err.code).toBe('rbac_customer')
    expect(err.name).toBe('RbacError')
    expect(err.message).toBe('msg')
  })
})

describe('assertCustomerRole', () => {
  it('throws when caller is craftsman', () => {
    installMockSession(mockOwnerSession('owner-1'))
    expect(() => assertCustomerRole()).toThrow(RbacError)
  })
  it('passes when caller is customer', () => {
    installMockSession(mockCustomerSession('cust-1'))
    expect(() => assertCustomerRole()).not.toThrow()
  })
  it('respects an explicit session arg over the global store', () => {
    installMockSession(mockOwnerSession('owner-1'))
    expect(() => assertCustomerRole(mockCustomerSession('cust-9'))).not.toThrow()
  })
})

describe('assertOwnerRole', () => {
  it('throws when caller is worker', () => {
    installMockSession(mockWorkerSession('w-1'))
    expect(() => assertOwnerRole()).toThrow(RbacError)
  })
  it('throws when caller is customer', () => {
    installMockSession(mockCustomerSession('cust-1'))
    expect(() => assertOwnerRole()).toThrow(RbacError)
  })
  it('passes when caller is owner', () => {
    installMockSession(mockOwnerSession('owner-1'))
    expect(() => assertOwnerRole()).not.toThrow()
  })
})

describe('assertJobCustomer', () => {
  it('throws when caller is a worker session', () => {
    installMockSession(mockWorkerSession('w-1'))
    expect(() => assertJobCustomer(makeJob({}))).toThrow(RbacError)
  })
  it('throws when caller is a different customer', () => {
    installMockSession(mockCustomerSession('cust-other'))
    expect(() => assertJobCustomer(makeJob({}))).toThrow(RbacError)
  })
  it('passes when caller is the matching customer', () => {
    installMockSession(mockCustomerSession('cust-1'))
    expect(() => assertJobCustomer(makeJob({}))).not.toThrow()
  })
})

describe('assertJobProviderOwner', () => {
  it('throws when caller is worker', () => {
    installMockSession(mockWorkerSession('w-1'))
    expect(() => assertJobProviderOwner(makeJob({}))).toThrow(RbacError)
  })
  it('throws when caller is owner of a different job', () => {
    installMockSession(mockOwnerSession('owner-other'))
    expect(() => assertJobProviderOwner(makeJob({}))).toThrow(RbacError)
  })
  it('passes when caller is the matching owner', () => {
    installMockSession(mockOwnerSession('owner-1'))
    expect(() => assertJobProviderOwner(makeJob({}))).not.toThrow()
  })
})

describe('assertJobWorkerOrOwner', () => {
  const seedTeam = seedTeamMembers

  it('passes for the matching owner', () => {
    installMockSession(mockOwnerSession('owner-1'))
    expect(() => assertJobWorkerOrOwner(makeJob({}))).not.toThrow()
  })
  it('passes for an assigned worker', () => {
    seedTeam([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'Worker 1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    const job = makeJob({ assignedMemberIds: ['tm-1'] })
    expect(() => assertJobWorkerOrOwner(job)).not.toThrow()
  })
  it('passes for a worker on a job that has no assignment yet', () => {
    seedTeam([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'Worker 1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    const job = makeJob({ assignedMemberIds: [] })
    expect(() => assertJobWorkerOrOwner(job)).not.toThrow()
  })
  it('throws for an unassigned worker on an assigned job', () => {
    seedTeam([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-1', name: 'Worker 1', role: 'worker' },
      { id: 'tm-2', userId: 'w-2', providerId: 'prov-1', name: 'Worker 2', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-2'))
    const job = makeJob({ assignedMemberIds: ['tm-1'] })
    expect(() => assertJobWorkerOrOwner(job)).toThrow(RbacError)
  })
  it('throws for a worker that belongs to a different provider', () => {
    seedTeam([
      { id: 'tm-1', userId: 'w-1', providerId: 'prov-other', name: 'Worker 1', role: 'worker' },
    ])
    installMockSession(mockWorkerSession('w-1'))
    const job = makeJob({ providerId: 'prov-1' })
    expect(() => assertJobWorkerOrOwner(job)).toThrow(RbacError)
  })
})
