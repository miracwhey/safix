import type { Job } from '../jobs/types'
import type { Payment } from '../payments/types'
import type { Dispute } from '../disputes/types'
import { ACTIVE_DISPUTE_STATUSES } from '../disputes/stateMachine'
import type { JobSchedule } from '../operations/types'
import type { ProjectTimelineSignal } from '../timeline/types'

export type OperatorCaseType =
  | 'stuck_inquiry'
  | 'proposal_pending'
  | 'scheduling_stuck'
  | 'execution_stuck'
  | 'execution_overdue'
  | 'payment_release_pending'
  | 'open_dispute'
  | 'payout_error'

export type OperatorCaseSeverity = 'critical' | 'high' | 'medium'

export type OperatorCase = {
  type: OperatorCaseType
  severity: OperatorCaseSeverity
  jobId: string
  title: string
  description: string
  ageHours: number
}

const MS_PER_HOUR = 1000 * 60 * 60

const SEVERITY_ORDER: Record<OperatorCaseSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
}

/**
 * Derives a list of operational cases requiring pilot operator attention.
 *
 * Classification rules (in priority order per job):
 * - execution_overdue:        schedule.scheduledEnd has passed, not completed/cancelled.
 *                             Severity critical if execution never started, high if running over.
 *                             Takes priority over execution_stuck and scheduling_stuck.
 * - stuck_inquiry:            status === 'new', no proposalSentAt
 * - proposal_pending:         proposalSentAt set, no proposalAcceptedAt, age > 48h
 * - scheduling_stuck:         proposalAcceptedAt set, not yet in_progress, age > 72h
 * - execution_stuck:          status === 'in_progress', no progress signal for 72h
 * - payment_release_pending:  payment.state === 'release_pending', age > 24h
 * - open_dispute:             dispute.status ∈ ACTIVE_DISPUTE_STATUSES
 *                             (open, under_review, customer_waiting, provider_waiting)
 *
 * Each non-terminal job produces at most one case — the most specific signal wins.
 * Returns cases sorted by severity DESC then ageHours DESC.
 *
 * Note: The Job type does not carry a createdAt field. For stuck_inquiry the
 * age cannot be computed precisely, so ageHours is reported as 0 and the
 * 24h threshold is not enforced. All other age-based rules use the relevant
 * timestamp fields on Job or Payment.
 *
 * - payout_error:             timeline_signals has payout_failed or transfer_reversed
 *                             for this job. Severity critical. Deduplicated per job —
 *                             at most one payout_error case per job regardless of how
 *                             many error signals exist.
 *
 * Pure function — no mutations, no side effects.
 */
export function deriveOperatorCases(
  jobs: Job[],
  payments: Payment[],
  disputes: Dispute[],
  schedules: JobSchedule[],
  nowMs = Date.now(),
  signals: ProjectTimelineSignal[] = []
): OperatorCase[] {
  const cases: OperatorCase[] = []

  const jobById = new Map(jobs.map((j) => [j.id, j]))

  // payout_error — critical; derived from timeline signals, independent of job lifecycle.
  // Deduplicated per job: first signal per job determines ageHours.
  const payoutErrorJobIds = new Set<string>()
  for (const signal of signals) {
    if (signal.type !== 'payout_failed' && signal.type !== 'transfer_reversed') continue
    if (payoutErrorJobIds.has(signal.jobId)) continue
    payoutErrorJobIds.add(signal.jobId)
    const job = jobById.get(signal.jobId)
    const ageHours = Math.floor((nowMs - signal.occurredAt) / MS_PER_HOUR)
    const label = signal.type === 'transfer_reversed' ? 'Transfer storniert' : 'Auszahlung fehlgeschlagen'
    cases.push({
      type: 'payout_error',
      severity: 'critical',
      jobId: signal.jobId,
      title: job?.title ?? signal.jobId,
      description: `${label} — manuelle Klärung erforderlich`,
      ageHours,
    })
  }

  // Build overdue schedule index: jobs whose scheduled window has passed without
  // confirmed completion or cancellation. Checked first per job to surface the
  // most specific and urgent signal.
  const overdueByJobId = new Map<string, JobSchedule>()
  for (const s of schedules) {
    if (
      s.scheduledEnd < nowMs &&
      s.schedulingStatus !== 'execution_completed' &&
      s.schedulingStatus !== 'cancelled'
    ) {
      overdueByJobId.set(s.jobId, s)
    }
  }

  // open_dispute — critical; independent of job lifecycle
  for (const dispute of disputes) {
    if (ACTIVE_DISPUTE_STATUSES.has(dispute.status)) {
      const job = jobById.get(dispute.jobId)
      const ageHours = Math.floor((nowMs - Date.parse(dispute.createdAt)) / MS_PER_HOUR)
      cases.push({
        type: 'open_dispute',
        severity: 'critical',
        jobId: dispute.jobId,
        title: job?.title ?? dispute.title,
        description: `Streitfall geöffnet: ${dispute.title}`,
        ageHours,
      })
    }
  }

  // payment_release_pending — high, age > 24h; independent of job lifecycle
  for (const payment of payments) {
    if (payment.state !== 'release_pending') continue
    const ageHours = Math.floor((nowMs - payment.updatedAt) / MS_PER_HOUR)
    if (ageHours <= 24) continue
    const job = jobById.get(payment.jobId)
    cases.push({
      type: 'payment_release_pending',
      severity: 'high',
      jobId: payment.jobId,
      title: job?.title ?? payment.jobId,
      description: `Zahlung wartet auf Freigabe seit ${ageHours}h`,
      ageHours,
    })
  }

  for (const job of jobs) {
    // execution_overdue: scheduled window passed, work not confirmed done.
    // Excluded for terminal states and waiting_payment (payment case handles those).
    const overdueSchedule = overdueByJobId.get(job.id)
    if (
      overdueSchedule &&
      job.status !== 'completed' &&
      job.status !== 'cancelled' &&
      job.status !== 'waiting_payment'
    ) {
      const ageHours = Math.floor((nowMs - overdueSchedule.scheduledEnd) / MS_PER_HOUR)
      // critical if execution never started; high if started but running over time
      const severity: OperatorCaseSeverity =
        overdueSchedule.schedulingStatus === 'execution_started' ? 'high' : 'critical'
      cases.push({
        type: 'execution_overdue',
        severity,
        jobId: job.id,
        title: job.title,
        description:
          overdueSchedule.schedulingStatus === 'execution_started'
            ? `Ausführung läuft über Terminrahmen (${ageHours}h überfällig)`
            : `Terminzeitraum abgelaufen, Ausführung nicht gestartet (${ageHours}h überfällig)`,
        ageHours,
      })
      continue
    }

    // stuck_inquiry: status === 'new', no proposalSentAt
    // Job has no createdAt, so ageHours defaults to 0 and the 24h threshold is
    // not enforced. All new jobs without a proposal are surfaced.
    if (job.status === 'new' && !job.proposalSentAt) {
      cases.push({
        type: 'stuck_inquiry',
        severity: 'medium',
        jobId: job.id,
        title: job.title,
        description: `Neue Anfrage ohne Angebot`,
        ageHours: 0,
      })
      continue
    }

    // proposal_pending: proposalSentAt set, no proposalAcceptedAt, age > 48h
    if (job.proposalSentAt && !job.proposalAcceptedAt) {
      const ageHours = Math.floor((nowMs - job.proposalSentAt) / MS_PER_HOUR)
      if (ageHours > 48) {
        cases.push({
          type: 'proposal_pending',
          severity: 'medium',
          jobId: job.id,
          title: job.title,
          description: `Angebot gesendet, keine Annahme seit ${ageHours}h`,
          ageHours,
        })
      }
      continue
    }

    // scheduling_stuck: proposalAcceptedAt set, not yet in execution, age > 72h
    if (
      job.proposalAcceptedAt &&
      job.status !== 'in_progress' &&
      job.status !== 'waiting_payment' &&
      job.status !== 'completed' &&
      job.status !== 'cancelled'
    ) {
      const ageHours = Math.floor((nowMs - job.proposalAcceptedAt) / MS_PER_HOUR)
      if (ageHours > 72) {
        cases.push({
          type: 'scheduling_stuck',
          severity: 'medium',
          jobId: job.id,
          title: job.title,
          description: `Terminplanung läuft seit ${ageHours}h ohne Fortschritt`,
          ageHours,
        })
      }
      continue
    }

    // execution_stuck: status === 'in_progress', no progress signal for 72h
    if (job.status === 'in_progress') {
      const lastSignalMs = job.workCompletedAt ?? job.proposalAcceptedAt
      if (lastSignalMs) {
        const ageHours = Math.floor((nowMs - lastSignalMs) / MS_PER_HOUR)
        if (ageHours > 72) {
          cases.push({
            type: 'execution_stuck',
            severity: 'high',
            jobId: job.id,
            title: job.title,
            description: `Kein Fortschritt bei laufendem Auftrag seit ${ageHours}h`,
            ageHours,
          })
        }
      }
    }
  }

  return cases.sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (severityDiff !== 0) return severityDiff
    return b.ageHours - a.ageHours
  })
}
