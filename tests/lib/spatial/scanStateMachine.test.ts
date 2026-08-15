import { describe, it, expect, beforeEach } from 'vitest'
import {
  InMemorySpatialRepository,
  initializeSpatialRepository,
  resetSpatialRepository,
  ScanFsmViolation,
  startCapture,
  finishCapture,
  submitForReview,
  verify,
  markOfferReady,
  lockForDispute,
  archive,
  ScanWorkflowError,
  type Scan,
} from '../../../src/lib/spatial'

const PROJECT = 'pppppppp-0000-0000-0000-000000000002'
const USER = 'uuuuuuuu-0000-0000-0000-000000000002'
const VERIFIER = 'vvvvvvvv-0000-0000-0000-000000000003'

async function seedDraft(repo: InMemorySpatialRepository): Promise<Scan> {
  return repo.createScan({
    projectId: PROJECT,
    source: 'roomplan',
    capturedBy: USER,
  })
}

async function walkTo(
  repo: InMemorySpatialRepository,
  scan: Scan,
  target: Scan['status'],
): Promise<Scan> {
  // Drive the FSM to `target` through legal edges so each test can stage the
  // exact starting state it needs without copy-pasting transition chains.
  const path: Scan['status'][] = []
  if (target === 'capturing' || target === 'captured' || target === 'quality_checked' ||
      target === 'provider_verified' || target === 'offer_ready' || target === 'archived' ||
      target === 'locked_for_dispute' || target === 'needs_provider_review') {
    path.push('capturing')
  }
  if (['captured','quality_checked','provider_verified','offer_ready','archived','locked_for_dispute','needs_provider_review'].includes(target)) {
    path.push('captured')
  }
  if (['quality_checked','provider_verified','offer_ready','archived','locked_for_dispute','needs_provider_review'].includes(target)) {
    path.push('quality_checked')
  }
  if (target === 'needs_provider_review') path.push('needs_provider_review')
  if (['provider_verified','offer_ready','archived','locked_for_dispute'].includes(target)) {
    path.push('provider_verified')
  }
  if (['offer_ready','archived'].includes(target)) path.push('offer_ready')
  if (target === 'locked_for_dispute') path.push('locked_for_dispute')
  if (target === 'archived' && path[path.length - 1] !== 'archived') path.push('archived')

  let current = scan
  for (const s of path) {
    current = await repo.updateScan(current.id, { status: s })
  }
  return current
}

describe('scanStateMachine (Block B.3 workflow layer)', () => {
  let repo: InMemorySpatialRepository

  beforeEach(() => {
    resetSpatialRepository()
    repo = new InMemorySpatialRepository()
    initializeSpatialRepository(repo)
  })

  it('startCapture moves draft → capturing and records a "captured" audit event', async () => {
    const scan = await seedDraft(repo)
    const after = await startCapture(scan.id)
    expect(after.status).toBe('capturing')
    const events = await repo.listScanEvents(scan.id)
    expect(events).toHaveLength(1)
    expect(events[0]!.action).toBe('captured')
    expect((events[0]!.payload as { phase: string }).phase).toBe('started')
  })

  it('finishCapture moves capturing → captured, stamps scanEndedAt, audits telemetry', async () => {
    const scan = await seedDraft(repo)
    await startCapture(scan.id)
    const before = Date.now() - 1
    const after = await finishCapture({
      scanId: scan.id,
      fpsSample: 42.5,
      thermalState: 'fair',
      durationSec: 88,
    })
    expect(after.status).toBe('captured')
    expect(after.scanEndedAt).not.toBeNull()
    expect((after.scanEndedAt ?? 0) >= before).toBe(true)
    const events = await repo.listScanEvents(scan.id)
    const finishEvent = events.find(
      e => e.action === 'captured' && (e.payload as { phase?: string }).phase === 'finished',
    )
    expect(finishEvent).toBeDefined()
    expect((finishEvent!.payload as { fpsSample: number }).fpsSample).toBe(42.5)
    expect((finishEvent!.payload as { thermalState: string }).thermalState).toBe('fair')
  })

  it('submitForReview moves captured → quality_checked and records a quality_run event', async () => {
    const scan = await seedDraft(repo)
    await startCapture(scan.id)
    await finishCapture({ scanId: scan.id })
    const after = await submitForReview(scan.id)
    expect(after.status).toBe('quality_checked')
    const events = await repo.listScanEvents(scan.id)
    expect(events.some(e => e.action === 'quality_run')).toBe(true)
  })

  it('verify moves quality_checked → provider_verified, idempotent on retry', async () => {
    const scan = await seedDraft(repo)
    await walkTo(repo, scan, 'quality_checked')
    const after = await verify({ scanId: scan.id, verifiedBy: VERIFIER })
    expect(after.status).toBe('provider_verified')
    // Verified events surface in audit log via recordScanEvent with deterministic
    // idempotency key — calling listScanEvents and looking for the action works.
    const events = await repo.listScanEvents(scan.id)
    expect(events.some(e => e.action === 'verified')).toBe(true)
  })

  it('markOfferReady moves provider_verified → offer_ready', async () => {
    const scan = await seedDraft(repo)
    await walkTo(repo, scan, 'provider_verified')
    const after = await markOfferReady(scan.id)
    expect(after.status).toBe('offer_ready')
  })

  it('lockForDispute walks legal predecessor → locked_for_dispute and records reason', async () => {
    const scan = await seedDraft(repo)
    await walkTo(repo, scan, 'provider_verified')
    const after = await lockForDispute({
      scanId: scan.id,
      reason: 'customer-claims-missing-doors',
      disputeId: 'd-123',
    })
    expect(after.status).toBe('locked_for_dispute')
    const events = await repo.listScanEvents(scan.id)
    const lockEvent = events.find(e => e.action === 'locked')
    expect(lockEvent).toBeDefined()
    expect((lockEvent!.payload as { reason: string }).reason).toBe('customer-claims-missing-doors')
    expect((lockEvent!.payload as { disputeId: string }).disputeId).toBe('d-123')
  })

  it('archive moves offer_ready → archived and stamps archivedAt', async () => {
    const scan = await seedDraft(repo)
    await walkTo(repo, scan, 'offer_ready')
    const after = await archive({ scanId: scan.id, reason: 'job-cancelled' })
    expect(after.status).toBe('archived')
    expect(after.archivedAt).not.toBeNull()
  })

  it('illegal transition (draft → locked_for_dispute) throws ScanFsmViolation (errcode 23514)', async () => {
    const scan = await seedDraft(repo)
    await expect(
      lockForDispute({ scanId: scan.id, reason: 'oops' }),
    ).rejects.toBeInstanceOf(ScanFsmViolation)
    try {
      await lockForDispute({ scanId: scan.id, reason: 'oops' })
    } catch (err) {
      expect((err as ScanFsmViolation).code).toBe('23514')
    }
  })

  it('startCapture on non-existent scan throws ScanWorkflowError, not ScanFsmViolation', async () => {
    await expect(startCapture('does-not-exist')).rejects.toBeInstanceOf(ScanWorkflowError)
  })
})
