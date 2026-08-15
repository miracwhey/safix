import { describe, beforeEach, it, expect } from 'vitest'

import { setupCleanRepositories } from '../helpers/setupRepositories'
import { addJob, getJobs } from '../../src/lib/jobs'
import { getBackofficeKPIs } from '../../src/lib/backoffice'
import { getUnassignedJobs } from '../../src/lib/jobs/teamWorkloadSelectors'

function seedJob(overrides: Partial<Parameters<typeof addJob>[0]> = {}) {
  return addJob({
    id: `job-dash-${Math.random().toString(36).slice(2, 8)}`,
    projectId: 'project-dash',
    title: 'Dashboard Job',
    customer: 'Kunde',
    location: 'Berlin',
    dateLabel: 'Offen',
    status: 'new',
    amount: '1.000 €',
    description: 'Dashboard semantics',
    paymentState: 'deposit_required',
    documentationStatus: 'Noch keine Dokumentation',
    assignedMemberIds: [],
    notes: [],
    photoCount: 0,
    activities: [],
    ...overrides,
  })
}

describe('Dashboard semantics', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  it('does not treat inquiry-only jobs as active or unassigned workloads', async () => {
    await seedJob({ status: 'new', proposalAcceptedAt: undefined })

    const jobs = getJobs()
    const kpis = getBackofficeKPIs(jobs, [])
    const unassigned = getUnassignedJobs(jobs)

    expect(kpis.activeJobs).toBe(0)
    expect(kpis.jobsInProgress).toBe(0)
    expect(unassigned).toHaveLength(0)
  })

  it('includes accepted or scheduled jobs in staffing and active counts', async () => {
    await seedJob({
      id: 'job-accepted',
      status: 'scheduled',
      proposalAcceptedAt: Date.now(),
    })

    const jobs = getJobs()
    const unassigned = getUnassignedJobs(jobs)
    const kpis = getBackofficeKPIs(jobs, [])

    expect(unassigned.find((job) => job.id === 'job-accepted')).toBeDefined()
    expect(kpis.activeJobs).toBe(1)
    expect(kpis.jobsInProgress).toBe(0)
  })
})
