import type { Job } from './types'
import type { Payment } from '../payments/types'
import type { Dispute } from '../disputes/types'
import { isTerminalDisputeStatus } from '../disputes/stateMachine'

export type OperatorPriorityCaseType = 'dispute' | 'stale_payment' | 'stuck_job'
export type OperatorPrioritySeverity = 'high' | 'medium' | 'low'

/**
 * A single case requiring operator attention.
 */
export type OperatorPriorityCase = {
  jobId: string
  type: OperatorPriorityCaseType
  label: string
  severity: OperatorPrioritySeverity
  actionRoute: string
}

const MS_PER_DAY = 1000 * 60 * 60 * 24

const SEVERITY_ORDER: Record<OperatorPrioritySeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

/**
 * Derives a prioritised list of cases the platform operator should act on.
 *
 * Priority rules (highest → lowest):
 * 1. Any job with an active (non-resolved) dispute              → dispute / high
 * 2. Payment stuck in 'in_escrow' for >7 days on a completed job → stale_payment / high
 * 3. Job stuck in 'scheduled' for >3 days since proposal accept  → stuck_job / medium
 * 4. Payment stuck in 'release_pending' for >2 days             → stale_payment / medium
 *
 * Pure function — no mutations, no side effects.
 *
 * @param jobs      Full job list (from `getJobs()`)
 * @param payments  Full payment list (from `getAllPayments()`)
 * @param disputes  Full dispute list (from `getDisputes()`)
 * @param nowMs     Current timestamp in ms (injectable for testing; defaults to Date.now())
 */
export function deriveOperatorPriorityCases(
  jobs: Job[],
  payments: Payment[],
  disputes: Dispute[],
  nowMs = Date.now()
): OperatorPriorityCase[] {
  const cases: OperatorPriorityCase[] = []

  const jobById = new Map(jobs.map((j) => [j.id, j]))

  // 1. Active (unresolved) disputes → high severity
  for (const dispute of disputes) {
    if (!isTerminalDisputeStatus(dispute.status)) {
      const job = jobById.get(dispute.jobId)
      cases.push({
        jobId: dispute.jobId,
        type: 'dispute',
        label: `Dispute: ${job?.title ?? dispute.jobId}`,
        severity: 'high',
        actionRoute: '/craftsman/disputes',
      })
    }
  }

  // 2 & 4. Payment-based cases
  for (const payment of payments) {
    const job = jobById.get(payment.jobId)

    // 2. Escrow payment on completed job stuck >7 days → high
    if (payment.state === 'in_escrow') {
      // Operator-Triage: Worker-Mark ist das früheste Completion-Signal —
      // wenn Worker fertig gemeldet hat aber der Admin nicht bestätigt, ist
      // das genau der Stuck-State, den der Operator sehen muss. Vorher fiel
      // dieser Fall durchs Raster (job.status blieb 'in_progress', kein
      // workCompletedAt → fallback auf payment.updatedAt deckte ihn nicht ab).
      const completionTs =
        job?.workMarkedCompleteAt ??
        job?.workConfirmedCompleteAt ??
        job?.workCompletedAt ??
        payment.updatedAt
      const ageMs = nowMs - completionTs

      const isPostCompletion =
        job?.status === 'waiting_payment' ||
        job?.status === 'completed' ||
        (job?.status === 'in_progress' && !!job?.workMarkedCompleteAt)

      if (ageMs > 7 * MS_PER_DAY && isPostCompletion) {
        cases.push({
          jobId: payment.jobId,
          type: 'stale_payment',
          label: `Stale Payment: ${job?.title ?? payment.jobId}`,
          severity: 'high',
          actionRoute: `/craftsman/jobs/${payment.jobId}`,
        })
      }
    }

    // 4. release_pending stuck >2 days → medium
    if (payment.state === 'release_pending') {
      // release_pending impliziert customer-release post-Admin-Confirm —
      // workMarkedCompleteAt liegt davor und ist hier irrelevant. Confirmed-
      // Stamp ist der natürliche Bezugspunkt; payment.updatedAt fängt
      // legacy-Daten ohne Confirmed-Stamp ab.
      const releaseRequestTs =
        job?.workConfirmedCompleteAt ??
        job?.workCompletedAt ??
        payment.updatedAt
      const ageMs = nowMs - releaseRequestTs

      if (ageMs > 2 * MS_PER_DAY) {
        cases.push({
          jobId: payment.jobId,
          type: 'stale_payment',
          label: `Release Pending: ${job?.title ?? payment.jobId}`,
          severity: 'medium',
          actionRoute: `/craftsman/jobs/${payment.jobId}`,
        })
      }
    }
  }

  // 3. Job stuck in 'scheduled' for >3 days since proposal acceptance → medium
  for (const job of jobs) {
    if (job.status === 'scheduled' && job.proposalAcceptedAt) {
      const ageMs = nowMs - job.proposalAcceptedAt
      if (ageMs > 3 * MS_PER_DAY) {
        cases.push({
          jobId: job.id,
          type: 'stuck_job',
          label: `Stuck in Scheduling: ${job.title}`,
          severity: 'medium',
          actionRoute: `/craftsman/jobs/${job.id}`,
        })
      }
    }
  }

  return cases.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )
}
