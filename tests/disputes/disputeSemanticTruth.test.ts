/**
 * Block 2 — Dispute Semantic Truth Tests
 *
 * Proves that the dispute domain correctly separates decision truth from
 * execution truth via the settlementStatus field.
 *
 * Tests proving:
 * 1. Terminal transitions set settlementStatus = 'pending' (decision only)
 * 2. settleDispute() transitions to 'settled' (execution confirmed)
 * 3. isDisputeFullySettled() correctly identifies settled vs unsettled
 * 4. Resolution workflows set 'settled' after successful money action
 * 5. Post-failure state (decided-but-unsettled) is semantically truthful
 * 6. Retry path: re-calling resolution on unsettled dispute completes settlement
 * 7. Downstream selectors produce truthful labels for unsettled vs settled
 * 8. Reload preserves settlementStatus
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setupCleanRepositories } from '../helpers/setupRepositories'

import { InMemoryDisputeRepository } from '../../src/lib/disputes/repository/InMemoryDisputeRepository'
import { setDisputeRepository, getDisputeRepository } from '../../src/lib/disputes/repository/registry'

import {
  getDisputeByJobId,
  resolveDisputeWithRelease,
  resolveDisputeWithRefund,
  resolveDisputeWithSplit,
  rejectDispute,
  settleDispute,
  isDisputeFullySettled,
} from '../../src/lib/disputes/disputesService'

import {
  resolveDisputeReleaseWorkflow,
  resolveDisputeRefundWorkflow,
  rejectDisputeWorkflow,
  resolveDisputeWorkflow,
} from '../../src/lib/workflow/disputeWorkflow'

import { getPaymentForJobWorkflow } from '../../src/lib/workflow/paymentWorkflow'
import { getPaymentRepository } from '../../src/lib/payments/repository/registry'
import {
  getDisputeStatusLabel,
  getDisputeNextStep,
  getDisputeNextStepForRole,
  mapToDisputeCenterItem,
} from '../../src/lib/disputes/disputeSelectors'

import type { Dispute } from '../../src/lib/disputes/types'
import type { Payment } from '../../src/lib/payments/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedPayment(jobId: string, state: Payment['state']): Payment {
  const payment: Payment = {
    id: `pay-${jobId}`,
    jobId,
    state,
    amounts: { totalAmount: 1000, depositAmount: 250, finalAmount: 750 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  void getPaymentRepository().add(payment)
  return payment
}

async function seedDispute(jobId: string, status: Dispute['status'], extra?: Partial<Dispute>): Promise<Dispute> {
  const dispute: Dispute = {
    id: `dispute-${jobId}`,
    jobId,
    paymentId: `pay-${jobId}`,
    status,
    reason: 'work_quality',
    title: 'Test dispute',
    description: 'Test dispute description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  }
  await getDisputeRepository().add(dispute)
  return dispute
}

/**
 * Creates a dispute repo where the *settlement* step fails.
 *
 * Block 5.3 split the old single-update flow into two distinct repository
 * surfaces:
 *   1. Decision persist  → operator-* methods (open → resolved_*, rejected, …)
 *   2. Settlement persist → update() (settlement_status: pending → settled)
 *
 * For this fixture we let operator transitions succeed and fail every
 * subsequent update(), so the workflow believes the decision was persisted
 * but the settlement flip throws.
 */
function makeFailOnSecondUpdateRepo(): InMemoryDisputeRepository {
  const repo = new InMemoryDisputeRepository([])
  repo.update = async (_id: string, _updater: (d: Dispute) => Dispute): Promise<void> => {
    throw new Error('Simulated settlement update failure')
  }
  return repo
}

/**
 * Creates a dispute repo whose update() *and* operator-* methods always fail
 * with the same error. Simulates a complete dispute-persistence outage so the
 * workflow refuses to move money under any of its persistence paths.
 */
function makeFailingUpdateRepo(): InMemoryDisputeRepository {
  const repo = new InMemoryDisputeRepository([])
  const originalAdd = repo.add.bind(repo)
  repo.add = originalAdd
  repo.update = async (_id: string, _updater: (d: Dispute) => Dispute): Promise<void> => {
    throw new Error('Simulated update failure')
  }
  const fail = async (): Promise<never> => {
    throw new Error('Simulated update failure')
  }
  repo.operatorRequestCustomerEvidence = fail
  repo.operatorRequestProviderEvidence = fail
  repo.operatorMarkUnderReview         = fail
  repo.operatorResolveRelease          = fail
  repo.operatorResolveRefund           = fail
  repo.operatorResolveSplit            = fail
  repo.operatorReject                  = fail
  return repo
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Block 2 — Dispute Semantic Truth', () => {
  beforeEach(() => {
    setupCleanRepositories()
  })

  // ── 1. Terminal transitions set settlementStatus = 'pending' ────────
  describe('decision persistence sets settlementStatus to pending', () => {
    it('resolveDisputeWithRelease sets settlementStatus = pending', async () => {
      await seedDispute('job-st1', 'under_review')
      const resolved = await resolveDisputeWithRelease('job-st1')
      expect(resolved).toBeDefined()
      expect(resolved!.status).toBe('resolved')
      expect(resolved!.decision).toBe('release')
      expect(resolved!.resolutionType).toBe('release_full')
      expect(resolved!.settlementStatus).toBe('pending')
    })

    it('resolveDisputeWithRefund sets settlementStatus = pending', async () => {
      await seedDispute('job-st2', 'under_review')
      const resolved = await resolveDisputeWithRefund('job-st2')
      expect(resolved).toBeDefined()
      expect(resolved!.status).toBe('resolved')
      expect(resolved!.decision).toBe('refund')
      expect(resolved!.resolutionType).toBe('refund_full')
      expect(resolved!.settlementStatus).toBe('pending')
    })

    it('resolveDisputeWithSplit sets settlementStatus = pending', async () => {
      await seedDispute('job-st3', 'under_review')
      const resolved = await resolveDisputeWithSplit('job-st3', 0.6)
      expect(resolved).toBeDefined()
      expect(resolved!.status).toBe('resolved')
      expect(resolved!.decision).toBe('split')
      expect(resolved!.resolutionType).toBe('split')
      expect(resolved!.settlementStatus).toBe('pending')
    })

    it('rejectDispute sets settlementStatus = pending', async () => {
      await seedDispute('job-st4', 'under_review')
      const rejected = await rejectDispute('job-st4')
      expect(rejected).toBeDefined()
      expect(rejected!.status).toBe('resolved')
      expect(rejected!.decision).toBe('reject')
      expect(rejected!.resolutionType).toBe('rejected')
      expect(rejected!.settlementStatus).toBe('pending')
    })
  })

  // ── 2. settleDispute transitions to settled ─────────────────────────
  describe('settleDispute marks execution complete', () => {
    it('transitions settlementStatus from pending to settled', async () => {
      await seedDispute('job-settle1', 'under_review')
      await resolveDisputeWithRelease('job-settle1')

      const settled = await settleDispute('job-settle1')
      expect(settled).toBeDefined()
      expect(settled!.settlementStatus).toBe('settled')
    })

    it('is idempotent — already-settled dispute returns as-is', async () => {
      await seedDispute('job-settle2', 'under_review')
      await resolveDisputeWithRelease('job-settle2')
      await settleDispute('job-settle2')

      const again = await settleDispute('job-settle2')
      expect(again).toBeDefined()
      expect(again!.settlementStatus).toBe('settled')
    })

    it('returns undefined when dispute not found', async () => {
      const result = await settleDispute('nonexistent')
      expect(result).toBeUndefined()
    })
  })

  // ── 3. isDisputeFullySettled correctly identifies state ─────────────
  describe('isDisputeFullySettled', () => {
    it('returns false for undefined dispute', () => {
      expect(isDisputeFullySettled(undefined)).toBe(false)
    })

    it('returns false for non-terminal dispute', async () => {
      const dispute = await seedDispute('job-ifs1', 'under_review')
      expect(isDisputeFullySettled(dispute)).toBe(false)
    })

    it('returns false for terminal dispute with pending settlement', async () => {
      await seedDispute('job-ifs2', 'under_review')
      const resolved = await resolveDisputeWithRelease('job-ifs2')
      expect(isDisputeFullySettled(resolved!)).toBe(false)
    })

    it('returns true for terminal dispute with settled status', async () => {
      await seedDispute('job-ifs3', 'under_review')
      await resolveDisputeWithRelease('job-ifs3')
      const settled = await settleDispute('job-ifs3')
      expect(isDisputeFullySettled(settled!)).toBe(true)
    })
  })

  // ── 4. Resolution workflows produce settled disputes on success ─────
  describe('full workflow sets settled on successful money action', () => {
    it('resolveDisputeReleaseWorkflow produces settled dispute', async () => {
      seedPayment('job-fw1', 'disputed')
      await seedDispute('job-fw1', 'under_review')

      const result = await resolveDisputeReleaseWorkflow('job-fw1')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('release')
      expect(result!.settlementStatus).toBe('settled')
    })

    it('resolveDisputeRefundWorkflow produces settled dispute', async () => {
      seedPayment('job-fw2', 'disputed')
      await seedDispute('job-fw2', 'under_review')

      const result = await resolveDisputeRefundWorkflow('job-fw2')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('refund')
      expect(result!.settlementStatus).toBe('settled')
    })

    it('rejectDisputeWorkflow produces settled dispute', async () => {
      seedPayment('job-fw3', 'disputed')
      await seedDispute('job-fw3', 'under_review')

      const result = await rejectDisputeWorkflow('job-fw3')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('reject')
      expect(result!.settlementStatus).toBe('settled')
    })

    it('resolveDisputeWorkflow (split) produces settled dispute', async () => {
      seedPayment('job-fw4', 'disputed')
      const seeded = await seedDispute('job-fw4', 'under_review')

      const result = await resolveDisputeWorkflow(seeded.id, 'split', 0.7)
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('split')
      expect(result!.settlementStatus).toBe('settled')
    })
  })

  // ── 5. Post-failure state is semantically truthful ──────────────────
  describe('post-decision money failure leaves truthful unsettled state', () => {
    it('release: dispute write fails → no money moves, no settlement', async () => {
      const repo = makeFailingUpdateRepo()
      setDisputeRepository(repo)

      await repo.add({
        id: 'dispute-pf1', jobId: 'job-pf1', paymentId: 'pay-job-pf1',
        status: 'under_review', reason: 'work_quality', title: 'T', description: 'D',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      seedPayment('job-pf1', 'disputed')

      await expect(resolveDisputeReleaseWorkflow('job-pf1'))
        .rejects.toThrow('Simulated update failure')

      // Payment must NOT have changed
      const payment = getPaymentForJobWorkflow('job-pf1')
      expect(payment?.state).toBe('disputed')
    })

    it('release: decision persists but settlement fails → dispute is pending, not settled', async () => {
      const repo = makeFailOnSecondUpdateRepo()
      setDisputeRepository(repo)

      await repo.add({
        id: 'dispute-pf2', jobId: 'job-pf2', paymentId: 'pay-job-pf2',
        status: 'under_review', reason: 'work_quality', title: 'T', description: 'D',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      seedPayment('job-pf2', 'disputed')

      // The workflow should throw because settleDispute fails
      await expect(resolveDisputeReleaseWorkflow('job-pf2'))
        .rejects.toThrow('Simulated settlement update failure')

      // Decision persisted — status is resolved + decision=release
      const dispute = getDisputeRepository().getByJobId('job-pf2')
      expect(dispute).toBeDefined()
      expect(dispute!.status).toBe('resolved')
      expect(dispute!.decision).toBe('release')
      // But settlement is still pending — truthful about execution
      expect(dispute!.settlementStatus).toBe('pending')
      // isDisputeFullySettled correctly reports not settled
      expect(isDisputeFullySettled(dispute!)).toBe(false)
    })

    it('refund: decision persists but settlement fails → dispute is pending', async () => {
      const repo = makeFailOnSecondUpdateRepo()
      setDisputeRepository(repo)

      await repo.add({
        id: 'dispute-pf3', jobId: 'job-pf3', paymentId: 'pay-job-pf3',
        status: 'under_review', reason: 'work_quality', title: 'T', description: 'D',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      })
      seedPayment('job-pf3', 'disputed')

      await expect(resolveDisputeRefundWorkflow('job-pf3'))
        .rejects.toThrow('Simulated settlement update failure')

      const dispute = getDisputeRepository().getByJobId('job-pf3')
      expect(dispute!.status).toBe('resolved')
      expect(dispute!.decision).toBe('refund')
      expect(dispute!.settlementStatus).toBe('pending')
      expect(isDisputeFullySettled(dispute!)).toBe(false)
    })
  })

  // ── 6. Retry path works for unsettled disputes ──────────────────────
  describe('retry: unsettled disputes allow re-execution', () => {
    it('resolveDisputeReleaseWorkflow retries and settles an unsettled resolved+release', async () => {
      // Simulate: decision persisted, but settlement did not complete
      seedPayment('job-retry1', 'disputed')
      await seedDispute('job-retry1', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'pending',
      })

      const result = await resolveDisputeReleaseWorkflow('job-retry1')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('release')
      expect(result!.settlementStatus).toBe('settled')

      // Payment should now be released
      const payment = getPaymentForJobWorkflow('job-retry1')
      expect(payment?.state).toBe('released')
    })

    it('resolveDisputeRefundWorkflow retries and settles an unsettled resolved+refund', async () => {
      seedPayment('job-retry2', 'disputed')
      await seedDispute('job-retry2', 'resolved', {
        decision: 'refund',
        resolutionType: 'refund_full',
        settlementStatus: 'pending',
      })

      const result = await resolveDisputeRefundWorkflow('job-retry2')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('refund')
      expect(result!.settlementStatus).toBe('settled')

      const payment = getPaymentForJobWorkflow('job-retry2')
      expect(payment?.state).toBe('refunded')
    })

    it('rejectDisputeWorkflow retries and settles an unsettled rejected', async () => {
      seedPayment('job-retry3', 'disputed')
      await seedDispute('job-retry3', 'resolved', {
        decision: 'reject',
        resolutionType: 'rejected',
        settlementStatus: 'pending',
      })

      const result = await rejectDisputeWorkflow('job-retry3')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('reject')
      expect(result!.settlementStatus).toBe('settled')

      const payment = getPaymentForJobWorkflow('job-retry3')
      expect(payment?.state).toBe('released')
    })

    it('resolveDisputeWorkflow (split) retries and settles an unsettled resolved+split', async () => {
      seedPayment('job-retry4', 'disputed')
      const seeded = await seedDispute('job-retry4', 'resolved', {
        settlementStatus: 'pending',
        decision: 'split',
        resolutionType: 'split',
        splitRatio: 0.7,
      })

      const result = await resolveDisputeWorkflow(seeded.id, 'split', 0.7)
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('split')
      expect(result!.settlementStatus).toBe('settled')
    })

    it('already-settled dispute returns idempotently without re-executing', async () => {
      seedPayment('job-retry5', 'released')
      await seedDispute('job-retry5', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'settled',
      })

      const result = await resolveDisputeReleaseWorkflow('job-retry5')
      expect(result).toBeDefined()
      expect(result!.status).toBe('resolved')
      expect(result!.decision).toBe('release')
      expect(result!.settlementStatus).toBe('settled')
    })
  })

  // ── 7. Downstream selectors produce truthful labels ─────────────────
  describe('downstream selectors distinguish decided vs settled', () => {
    it('status label shows "entschieden" for unsettled, "abgeschlossen" for settled', () => {
      expect(getDisputeStatusLabel('resolved', 'release', 'release_full', 'pending')).toContain('entschieden')
      expect(getDisputeStatusLabel('resolved', 'release', 'release_full', 'settled')).toContain('abgeschlossen')
      expect(getDisputeStatusLabel('resolved', 'refund', 'refund_full', 'pending')).toContain('entschieden')
      expect(getDisputeStatusLabel('resolved', 'refund', 'refund_full', 'settled')).toContain('abgeschlossen')
      expect(getDisputeStatusLabel('resolved', 'split', 'split', 'pending')).toContain('entschieden')
      expect(getDisputeStatusLabel('resolved', 'split', 'split', 'settled')).toContain('abgeschlossen')
    })

    it('γ-specific decision labels are exact strings', () => {
      // Split decision wording is "Teilung" (singular) — not "Teilungen" or "Aufteilung"
      expect(getDisputeStatusLabel('resolved', 'split', 'split', 'settled')).toBe('Teilung abgeschlossen')
      expect(getDisputeStatusLabel('resolved', 'split', 'split', 'pending')).toBe('Teilung entschieden')
      // Reject is intentionally "Abgelehnt – abgeschlossen" once settled
      expect(getDisputeStatusLabel('resolved', 'reject', 'rejected', 'settled')).toBe('Abgelehnt – abgeschlossen')
      expect(getDisputeStatusLabel('resolved', 'reject', 'rejected', 'pending')).toBe('Abgelehnt')
      // Active states have stable labels
      expect(getDisputeStatusLabel('customer_waiting')).toBe('Warte auf Kundenbeleg')
      expect(getDisputeStatusLabel('provider_waiting')).toBe('Warte auf Anbieterbeleg')
    })

    it('next-step text does NOT claim completion for unsettled disputes', () => {
      const unsettledStep = getDisputeNextStep('resolved', 'release', 'pending')
      expect(unsettledStep).not.toContain('abgeschlossen')
      expect(unsettledStep).toContain('entschieden')

      const settledStep = getDisputeNextStep('resolved', 'release', 'settled')
      expect(settledStep).toContain('abgeschlossen')
    })

    it('role-aware next step does NOT claim money moved for unsettled', () => {
      const customerUnsettled = getDisputeNextStepForRole('resolved', 'customer', 'refund', 'pending')
      expect(customerUnsettled).not.toContain('zurückerstattet')

      const customerSettled = getDisputeNextStepForRole('resolved', 'customer', 'refund', 'settled')
      expect(customerSettled).toContain('zurückerstattet')
    })

    it('next-step distinguishes a PARTIAL default from a full refund', () => {
      // refund_partial (T+80 default / operator split) must NOT claim the full
      // amount comes back — it states the held share is refunded and the
      // paid-out share stays with the craftsman.
      const partialSettled = getDisputeNextStep('resolved', 'refund', 'settled', 'refund_partial')
      expect(partialSettled).not.toContain('vollständig')
      expect(partialSettled).toContain('einbehaltene Anteil')
      expect(partialSettled).toContain('verbleibt beim Betrieb')

      const partialUnsettled = getDisputeNextStep('resolved', 'refund', 'pending', 'refund_partial')
      expect(partialUnsettled).toContain('Teilrückerstattung')
      expect(partialUnsettled).not.toContain('abgeschlossen')

      // refund_full still gets the genuine full-refund text.
      const fullSettled = getDisputeNextStep('resolved', 'refund', 'settled', 'refund_full')
      expect(fullSettled).toContain('vollständig')
    })

    it('role-aware next step reflects the PARTIAL cut per party', () => {
      // Customer: only the held share is refunded; pointer to the order overview.
      const customerPartial = getDisputeNextStepForRole(
        'resolved', 'customer', 'refund', 'settled', 'refund_partial',
      )
      expect(customerPartial).toContain('einbehaltene Anteil')
      expect(customerPartial).not.toContain('Der Betrag wird auf Ihr Konto zurückerstattet.')

      const customerPartialUnsettled = getDisputeNextStepForRole(
        'resolved', 'customer', 'refund', 'pending', 'refund_partial',
      )
      expect(customerPartialUnsettled).toContain('Teilrückerstattung')

      // Craftsman: the already-paid-out share stays with them.
      const craftsmanPartial = getDisputeNextStepForRole(
        'resolved', 'craftsman', 'refund', 'settled', 'refund_partial',
      )
      expect(craftsmanPartial).toContain('Teilrückerstattung')
      expect(craftsmanPartial).toContain('verbleibt bei Ihnen')

      // refund_full keeps the genuine full-refund wording for the craftsman.
      const craftsmanFull = getDisputeNextStepForRole(
        'resolved', 'craftsman', 'refund', 'settled', 'refund_full',
      )
      expect(craftsmanFull).toContain('Rückerstattung an den Kunden veranlasst')
      expect(craftsmanFull).not.toContain('Teilrückerstattung')
    })

    it('mapToDisputeCenterItem allows retry for unsettled terminal disputes', async () => {
      await seedDispute('job-sel1', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'pending',
      })
      const dispute = getDisputeByJobId('job-sel1')!
      const item = mapToDisputeCenterItem(dispute)

      expect(item.isResolved).toBe(true)
      // Unsettled: actions should still be available for retry
      expect(item.canRelease).toBe(true)
      expect(item.canRefund).toBe(true)
    })

    it('mapToDisputeCenterItem disables actions for fully settled disputes', async () => {
      await seedDispute('job-sel2', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'settled',
      })
      const dispute = getDisputeByJobId('job-sel2')!
      const item = mapToDisputeCenterItem(dispute)

      expect(item.isResolved).toBe(true)
      expect(item.canRelease).toBe(false)
      expect(item.canRefund).toBe(false)
    })
  })

  // ── 8. Reload preserves settlementStatus ────────────────────────────
  describe('reload preserves settlementStatus', () => {
    it('pending settlementStatus survives repo add/read cycle', async () => {
      await seedDispute('job-reload1', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'pending',
      })
      const found = getDisputeRepository().getByJobId('job-reload1')
      expect(found).toBeDefined()
      expect(found!.settlementStatus).toBe('pending')
    })

    it('settled settlementStatus survives repo add/read cycle', async () => {
      await seedDispute('job-reload2', 'resolved', {
        decision: 'release',
        resolutionType: 'release_full',
        settlementStatus: 'settled',
      })
      const found = getDisputeRepository().getByJobId('job-reload2')
      expect(found).toBeDefined()
      expect(found!.settlementStatus).toBe('settled')
    })

    it('legacy disputes without settlementStatus have undefined (backward-compat)', async () => {
      await seedDispute('job-reload3', 'under_review')
      const found = getDisputeRepository().getByJobId('job-reload3')
      expect(found).toBeDefined()
      expect(found!.settlementStatus).toBeUndefined()
    })
  })
})
