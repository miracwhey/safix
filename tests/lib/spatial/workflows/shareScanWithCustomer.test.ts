/**
 * shareScanWithCustomer workflow tests (Block 2)
 *
 * Uses deps-injection seams (`spatialRepo`, `session`, `jobsLookup`,
 * `emitTimelineEvent`) so the suite stays free of `vi.mock` boot-order
 * gymnastics and the spatial barrel's `session` carve-out (see
 * `lib/spatial/workflow/index.ts` note).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  InMemorySpatialRepository,
  type Scan,
} from '../../../../src/lib/spatial'
import type { Job } from '../../../../src/lib/jobs/types'
import type { SessionState } from '../../../../src/lib/session'
import { shareScanWithCustomer } from '../../../../src/lib/spatial/workflow/shareScanWithCustomer'

const HW_OWNER_ID = 'hw_owner_42'
const OTHER_HW_ID = 'hw_owner_other'
const CUSTOMER_ID = 'customer_77'
const JOB_ID = 'job_share_target'

function ownerSession(userId: string = HW_OWNER_ID): SessionState {
  return {
    user: { id: userId, email: `${userId}@example.com` },
    role: 'craftsman',
    craftsmanRole: 'owner',
  } as unknown as SessionState
}

function customerSession(userId: string = CUSTOMER_ID): SessionState {
  return {
    user: { id: userId, email: `${userId}@example.com` },
    role: 'customer',
  } as unknown as SessionState
}

function emptySession(): SessionState {
  return { user: undefined } as unknown as SessionState
}

function fakeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    title: 'Test Job',
    description: '',
    customer: 'Kundin Test',
    customerUserId: CUSTOMER_ID,
    craftsmanUserId: HW_OWNER_ID,
    status: 'new',
    assignedMemberIds: [],
    ...overrides,
  } as unknown as Job
}

async function seedHwScan(
  repo: InMemorySpatialRepository,
  jobId: string | null = JOB_ID,
): Promise<Scan> {
  return repo.createScan({
    jobId: jobId ?? undefined,
    source: 'roomplan',
    capturedBy: HW_OWNER_ID,
    ownerType: 'craftsman',
  })
}

async function seedSelfScan(repo: InMemorySpatialRepository): Promise<Scan> {
  return repo.createScan({
    source: 'roomplan',
    capturedBy: CUSTOMER_ID,
    ownerType: 'customer',
  })
}

describe('shareScanWithCustomer (Block 2 workflow)', () => {
  let repo: InMemorySpatialRepository
  let emitter: ReturnType<typeof vi.fn>

  beforeEach(() => {
    repo = new InMemorySpatialRepository()
    emitter = vi.fn()
  })

  it('rejects when there is no authenticated session', async () => {
    const scan = await seedHwScan(repo)
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: repo,
        session: emptySession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('rbac_owner_required')
    expect(emitter).not.toHaveBeenCalled()
  })

  it('rejects a customer-session caller', async () => {
    const scan = await seedHwScan(repo)
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: repo,
        session: customerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('rbac_owner_required')
  })

  it('rejects when the caller is not the job owner', async () => {
    const scan = await seedHwScan(repo)
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: repo,
        session: ownerSession(OTHER_HW_ID),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('rbac_owner_required')
  })

  it('rejects sharing of a customer-owned Self-Scan', async () => {
    const selfScan = await seedSelfScan(repo)
    const result = await shareScanWithCustomer(
      { scanId: selfScan.id, value: true },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('scan_owned_by_customer')
    expect(emitter).not.toHaveBeenCalled()
  })

  it('rejects sharing on a jobless craftsman scan with scan_missing_job', async () => {
    const orphanScan = await repo.createScan({
      projectId: 'proj_legacy',
      source: 'roomplan',
      capturedBy: HW_OWNER_ID,
    })
    const result = await shareScanWithCustomer(
      { scanId: orphanScan.id, value: true },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('scan_missing_job')
    expect(emitter).not.toHaveBeenCalled()
  })

  it('rejects when the job row is missing', async () => {
    const scan = await seedHwScan(repo)
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => undefined,
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('job_not_found')
  })

  it('rejects when the scan id is unknown', async () => {
    const result = await shareScanWithCustomer(
      { scanId: 'does_not_exist', value: true },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('scan_not_found')
  })

  it('happy share — flips the row + emits the timeline event ONCE', async () => {
    const scan = await seedHwScan(repo)
    expect(scan.sharedWithCustomer).toBe(false)
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.scan.sharedWithCustomer).toBe(true)
    expect(result.scan.sharedAt).not.toBeNull()
    expect(result.changed).toBe(true)
    expect(emitter).toHaveBeenCalledTimes(1)
    expect(emitter).toHaveBeenCalledWith({
      jobId: JOB_ID,
      type: 'spatial_shared_with_customer',
      entityId: result.scan.id,
    })
  })

  it('happy unshare — flips the row but does NOT emit any timeline event (D4: silent)', async () => {
    const scan = await seedHwScan(repo)
    // Pre-share so unshare has something to flip.
    await repo.updateScanSharing(scan.id, true)
    emitter.mockReset()
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: false },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.scan.sharedWithCustomer).toBe(false)
    expect(result.scan.sharedAt).toBeNull()
    expect(result.changed).toBe(true)
    expect(emitter).not.toHaveBeenCalled()
  })

  it('idempotent re-share — same value flips nothing + emits no event', async () => {
    const scan = await seedHwScan(repo)
    await repo.updateScanSharing(scan.id, true)
    emitter.mockReset()
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: repo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.changed).toBe(false)
    expect(emitter).not.toHaveBeenCalled()
  })

  it('persistence failure is surfaced as persistence_failed', async () => {
    const scan = await seedHwScan(repo)
    const failingRepo = {
      ...repo,
      getScan: repo.getScan.bind(repo),
      updateScanSharing: vi
        .fn()
        .mockRejectedValue(new Error('supabase 500')),
    } as unknown as InMemorySpatialRepository
    const result = await shareScanWithCustomer(
      { scanId: scan.id, value: true },
      {
        spatialRepo: failingRepo,
        session: ownerSession(),
        jobsLookup: () => fakeJob(),
        emitTimelineEvent: emitter,
      },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('persistence_failed')
    expect(result.message).toMatch(/supabase 500/)
    expect(emitter).not.toHaveBeenCalled()
  })
})
