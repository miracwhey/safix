/**
 * Operational Health Selectors
 *
 * Pure functions that derive risk flags and integrity warnings from the
 * current state of payments, disputes, and jobs. These signals are used by
 * the Finance screen to surface critical situations early during pilot
 * operations.
 *
 * Domain → Selector layer. No side-effects, no store mutations.
 */

import type { Payment } from '../payments/types'
import type { Job } from '../jobs/types'
import type { Dispute } from '../disputes/types'
import {
  getDisputeAgeDays,
  getDisputeUrgencyLevel,
  getDisputeReasonLabel,
  getDisputeStatusLabelFor,
} from '../disputes/disputeSelectors'
import { isTerminalDisputeStatus } from '../disputes/stateMachine'
import { getPaymentStateLabel } from '../payments/selectors'
import { formatEuro } from '../payments/selectors'
import type { RiskFlag, OperationalHealthSummary } from './types'
import { resolveCanonicalAmount } from '../shared/canonicalAmountResolver'

// ---------------------------------------------------------------------------
// Payment risk flags
// ---------------------------------------------------------------------------

/**
 * Detects payments in problematic states that may indicate blocked or
 * inconsistent escrow flows.
 */
function derivePaymentRiskFlags(payments: Payment[], jobs: Job[]): RiskFlag[] {
  const flags: RiskFlag[] = []
  const jobById = new Map(jobs.map((j) => [j.id, j]))

  for (const payment of payments) {
    const job = jobById.get(payment.jobId)
    const jobTitle = job?.title ?? payment.jobId

    // Frozen escrow: payment disputed
    if (payment.state === 'disputed') {
      flags.push({
        id: `payment-disputed-${payment.id}`,
        severity: 'critical',
        category: 'payment',
        label: 'Zahlung eingefroren',
        detail: `${jobTitle} – ${formatEuro(resolveCanonicalAmount(payment.jobId).amount ?? 0)} blockiert`,
        jobId: payment.jobId,
        actionHint: 'Im Dispute Center prüfen und Entscheidung treffen',
      })
    }

    // Release pending: customer has not confirmed yet
    if (payment.state === 'release_pending') {
      flags.push({
        id: `payment-release-pending-${payment.id}`,
        severity: 'elevated',
        category: 'payment',
        label: 'Freigabe ausstehend',
        detail: `${jobTitle} – ${formatEuro(resolveCanonicalAmount(payment.jobId).amount ?? 0)} warten auf Kundenfreigabe`,
        jobId: payment.jobId,
        actionHint: 'Kunde hat Freigabe noch nicht bestätigt',
      })
    }

    // Integrity: job completed but payment not released/refunded
    if (
      job?.status === 'completed' &&
      payment.state !== 'released' &&
      payment.state !== 'refunded'
    ) {
      flags.push({
        id: `integrity-completed-not-released-${payment.id}`,
        severity: 'warning',
        category: 'integrity',
        label: 'Inkonsistenter Abschlussstatus',
        detail: `${jobTitle} – Job abgeschlossen, Zahlung ist noch „${getPaymentStateLabel(payment.state)}"`,
        jobId: payment.jobId,
        actionHint: 'Zahlungsstatus manuell prüfen und bereinigen',
      })
    }

    // Integrity: job in_progress but payment is still deposit_required
    if (
      job?.status === 'in_progress' &&
      payment.state === 'deposit_required'
    ) {
      flags.push({
        id: `integrity-in-progress-no-deposit-${payment.id}`,
        severity: 'warning',
        category: 'integrity',
        label: 'Zahlung nicht gesichert',
        detail: `${jobTitle} – Auftrag läuft, aber Zahlung noch nicht bestätigt`,
        jobId: payment.jobId,
        actionHint: 'Zahlungsfluss prüfen – Zahlung sollte aktiv sein',
      })
    }
  }

  return flags
}

// ---------------------------------------------------------------------------
// Dispute risk flags
// ---------------------------------------------------------------------------

/**
 * Detects high-priority disputes that need operator attention.
 */
function deriveDisputeRiskFlags(disputes: Dispute[], payments: Payment[]): RiskFlag[] {
  const flags: RiskFlag[] = []
  const paymentByJobId = new Map(payments.map((p) => [p.jobId, p]))

  for (const dispute of disputes) {
    if (isTerminalDisputeStatus(dispute.status)) continue

    const ageDays = getDisputeAgeDays(dispute.createdAt)
    const urgency = getDisputeUrgencyLevel(dispute.status, ageDays)
    const payment = paymentByJobId.get(dispute.jobId)
    const amountNote = payment
      ? ` (${formatEuro(resolveCanonicalAmount(payment.jobId).amount ?? 0)} eingefroren)`
      : ''

    if (urgency === 'critical') {
      flags.push({
        id: `dispute-critical-${dispute.id}`,
        severity: 'critical',
        category: 'dispute',
        label: 'Konflikt: Sofortiger Handlungsbedarf',
        detail: `${dispute.title} – ${getDisputeStatusLabelFor(dispute)}${amountNote}`,
        jobId: dispute.jobId,
        actionHint: 'Belege angefordert – warten auf Einreichung',
        linkTo: '/craftsman/disputes',
      })
    } else if (urgency === 'elevated') {
      flags.push({
        id: `dispute-elevated-${dispute.id}`,
        severity: 'elevated',
        category: 'dispute',
        label: 'Konflikt: Priorisieren',
        detail: `${dispute.title} – ${getDisputeReasonLabel(dispute.reason)}, ${ageDays} Tage offen${amountNote}`,
        jobId: dispute.jobId,
        actionHint: 'Offener Fall seit mehr als 3 Tagen – Status aktualisieren',
        linkTo: '/craftsman/disputes',
      })
    } else if (dispute.status === 'open') {
      flags.push({
        id: `dispute-open-${dispute.id}`,
        severity: 'warning',
        category: 'dispute',
        label: 'Konflikt offen',
        detail: `${dispute.title} – ${getDisputeStatusLabelFor(dispute)}`,
        jobId: dispute.jobId,
        actionHint: 'Im Dispute Center weiterbearbeiten',
        linkTo: '/craftsman/disputes',
      })
    }
  }

  return flags
}

// ---------------------------------------------------------------------------
// Job execution risk flags
// ---------------------------------------------------------------------------

/**
 * Detects jobs with missing assignment or risky execution states.
 */
function deriveJobRiskFlags(jobs: Job[], payments: Payment[]): RiskFlag[] {
  const flags: RiskFlag[] = []
  const paymentByJobId = new Map(payments.map((p) => [p.jobId, p]))

  for (const job of jobs) {
    if (job.status === 'completed' || job.status === 'cancelled') continue

    // Active job with no assigned team member
    if (
      (job.status === 'scheduled' || job.status === 'in_progress') &&
      job.assignedMemberIds.length === 0
    ) {
      flags.push({
        id: `job-unassigned-${job.id}`,
        severity: 'warning',
        category: 'job',
        label: 'Kein Mitarbeiter zugewiesen',
        detail: `${job.title} – Status: ${job.status === 'in_progress' ? 'In Arbeit' : 'Geplant'}, niemand zugewiesen`,
        jobId: job.id,
        actionHint: 'Mitarbeiter zuweisen bevor Ausführung beginnt',
      })
    }

    // Waiting payment without escrow-protected payment
    if (job.status === 'waiting_payment') {
      const payment = paymentByJobId.get(job.id)
      if (!payment || payment.state === 'deposit_required' || payment.state === 'deposit_paid') {
        flags.push({
          id: `job-waiting-payment-no-escrow-${job.id}`,
          severity: 'elevated',
          category: 'job',
          label: 'Freigabe ohne Zahlungsschutz',
          detail: `${job.title} – Arbeit abgeschlossen, aber Zahlung nicht in Zahlung`,
          jobId: job.id,
          actionHint: 'Zahlungsfluss prüfen – Zahlung muss aktiv sein',
        })
      }
    }
  }

  return flags
}

// ---------------------------------------------------------------------------
// Public selector
// ---------------------------------------------------------------------------

/**
 * Derives a complete operational health summary from the current state of
 * payments, disputes, and jobs.
 *
 * Pure function — does not read from any store.
 */
export function deriveOperationalHealthSummary(
  payments: Payment[],
  jobs: Job[],
  disputes: Dispute[]
): OperationalHealthSummary {
  const paymentFlags = derivePaymentRiskFlags(payments, jobs)
  const disputeFlags = deriveDisputeRiskFlags(disputes, payments)
  const jobFlags = deriveJobRiskFlags(jobs, payments)

  const allFlags: RiskFlag[] = [
    ...paymentFlags,
    ...disputeFlags,
    ...jobFlags,
  ].sort((a, b) => {
    const order: Record<RiskFlag['severity'], number> = { critical: 0, elevated: 1, warning: 2 }
    return order[a.severity] - order[b.severity]
  })

  const criticalCount = allFlags.filter((f) => f.severity === 'critical').length
  const elevatedCount = allFlags.filter((f) => f.severity === 'elevated').length
  const warningCount = allFlags.filter((f) => f.severity === 'warning').length
  const totalIssueCount = allFlags.length

  let overallStatus: OperationalHealthSummary['overallStatus']
  if (criticalCount > 0) {
    overallStatus = 'critical'
  } else if (elevatedCount > 0 || warningCount > 0) {
    overallStatus = 'warning'
  } else {
    overallStatus = 'healthy'
  }

  return {
    overallStatus,
    criticalCount,
    elevatedCount,
    warningCount,
    totalIssueCount,
    flags: allFlags,
  }
}
