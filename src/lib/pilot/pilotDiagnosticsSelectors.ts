import type { Job } from '../jobs/types'
import type { Payment } from '../payments/types'
import type { Dispute } from '../disputes/types'
import type { ProviderProfile } from '../providers/providerProfileService'
import {
  isProposalStuck,
  isSchedulingStuck,
  isExecutionSilent,
  isPaymentReleasePending,
} from '../jobs/customerStuckStateSelectors'
import { getDisputeAgeDays } from '../disputes/disputeSelectors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PilotSignalSeverity = 'critical' | 'warning' | 'info'

export type PilotSignal = {
  id: string
  severity: PilotSignalSeverity
  category:
    | 'stuck_job'
    | 'stuck_payment'
    | 'open_dispute'
    | 'incomplete_provider'
    | 'ownership_gap'
    | 'empty_state'
  title: string
  detail: string
  jobId?: string
  paymentId?: string
  disputeId?: string
  ageLabel?: string
}

export type PilotDiagnosticsSummary = {
  signals: PilotSignal[]
  criticalCount: number
  warningCount: number
  infoCount: number
  totalCount: number
  hasIssues: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000

function pluralizeTage(n: number): string {
  return n === 1 ? 'Tag' : 'Tagen'
}

/**
 * Formats an age in hours into a human-readable German age label.
 * - < 24h  → "seit Xh"
 * - < 48h  → "seit 1 Tag"
 * - else   → "seit X Tagen"
 */
export function formatAgeHours(ageHours: number): string {
  const hours = Math.floor(ageHours)
  if (hours < 24) return `seit ${hours}h`
  if (hours < 48) return 'seit 1 Tag'
  return `seit ${Math.floor(hours / 24)} Tagen`
}

// ---------------------------------------------------------------------------
// deriveStuckJobSignals
// ---------------------------------------------------------------------------

/**
 * Detects jobs that are stuck: proposal not sent, scheduling not advancing,
 * execution silent, or payment release pending.
 */
export function deriveStuckJobSignals(
  jobs: Job[],
  payments: Payment[]
): PilotSignal[] {
  const signals: PilotSignal[] = []

  for (const job of jobs) {
    const payment = payments.find((p) => p.jobId === job.id)

    if (isProposalStuck(job)) {
      signals.push({
        id: `stuck_proposal_${job.id}`,
        severity: 'warning',
        category: 'stuck_job',
        title: `Kein Angebot: ${job.title}`,
        detail: 'Kein Angebot gesendet seit mehr als 48 Stunden.',
        jobId: job.id,
      })
    }

    if (isSchedulingStuck(job)) {
      signals.push({
        id: `stuck_scheduling_${job.id}`,
        severity: 'warning',
        category: 'stuck_job',
        title: `Termin ausstehend: ${job.title}`,
        detail: 'Angebot angenommen, aber Termin seit mehr als 72 Stunden nicht festgelegt.',
        jobId: job.id,
      })
    }

    if (isExecutionSilent(job)) {
      signals.push({
        id: `stuck_execution_${job.id}`,
        severity: 'warning',
        category: 'stuck_job',
        title: `Keine Ausführungsaktivität: ${job.title}`,
        detail: 'Auftrag in Bearbeitung, aber seit mehr als 72 Stunden keine Aktivität.',
        jobId: job.id,
      })
    }

    if (isPaymentReleasePending(payment)) {
      signals.push({
        id: `stuck_payment_release_${job.id}`,
        severity: 'info',
        category: 'stuck_job',
        title: `Zahlung ausstehend: ${job.title}`,
        detail: 'Zahlung wartet auf Freigabe durch den Kunden.',
        jobId: job.id,
        paymentId: payment?.id,
      })
    }
  }

  return signals
}

// ---------------------------------------------------------------------------
// derivePaymentRiskSignals
// ---------------------------------------------------------------------------

/**
 * Detects payments in risky or blocked states: disputed, frozen, or
 * long-pending release.
 */
export function derivePaymentRiskSignals(
  payments: Payment[],
  jobs: Job[]
): PilotSignal[] {
  const signals: PilotSignal[] = []

  for (const payment of payments) {
    const job = jobs.find((j) => j.id === payment.jobId)
    const jobTitle = job?.title ?? payment.jobId

    if (payment.state === 'disputed') {
      signals.push({
        id: `payment_disputed_${payment.id}`,
        severity: 'critical',
        category: 'stuck_payment',
        title: `Zahlung in Streitfall: ${jobTitle}`,
        detail: 'Diese Zahlung ist aktuell Gegenstand eines Streitfalls.',
        jobId: payment.jobId,
        paymentId: payment.id,
      })
      continue
    }

    if (payment.state === 'release_pending') {
      const agingMs = Date.now() - payment.updatedAt
      if (agingMs > 7 * MS_PER_DAY) {
        const ageDays = Math.floor(agingMs / MS_PER_DAY)
        signals.push({
          id: `payment_release_aging_${payment.id}`,
          severity: 'warning',
          category: 'stuck_payment',
          title: `Freigabe überfällig: ${jobTitle}`,
          detail: 'Zahlung wartet seit mehr als 7 Tagen auf Freigabe.',
          jobId: payment.jobId,
          paymentId: payment.id,
          ageLabel: `seit ${ageDays} ${pluralizeTage(ageDays)}`,
        })
      }
      continue
    }

    if (payment.state === 'deposit_required') {
      signals.push({
        id: `payment_deposit_required_${payment.id}`,
        severity: 'info',
        category: 'stuck_payment',
        title: `Zahlung ausstehend: ${jobTitle}`,
        detail: 'Die Zahlung für diesen Auftrag wurde noch nicht geleistet.',
        jobId: payment.jobId,
        paymentId: payment.id,
      })
    }
  }

  return signals
}

// ---------------------------------------------------------------------------
// deriveDisputeSignals
// ---------------------------------------------------------------------------

/**
 * Detects open disputes that may be aging or escalating.
 */
export function deriveDisputeSignals(
  disputes: Dispute[],
  jobs: Job[]
): PilotSignal[] {
  const signals: PilotSignal[] = []

  for (const dispute of disputes) {
    if (dispute.status !== 'open' && dispute.status !== 'under_review') {
      continue
    }

    const job = jobs.find((j) => j.id === dispute.jobId)
    const jobTitle = job?.title ?? dispute.jobId
    const ageDays = getDisputeAgeDays(dispute.createdAt)
    const severity: PilotSignalSeverity = ageDays > 7 ? 'critical' : 'warning'

    const statusLabel =
      dispute.status === 'open' ? 'Offen' : 'In Prüfung'

    signals.push({
      id: `dispute_active_${dispute.id}`,
      severity,
      category: 'open_dispute',
      title: `Streitfall (${statusLabel}): ${jobTitle}`,
      detail:
        ageDays > 7
          ? `Streitfall ist seit ${ageDays} ${pluralizeTage(ageDays)} offen und erfordert sofortige Aufmerksamkeit.`
          : `Streitfall seit ${ageDays} ${pluralizeTage(ageDays)} offen.`,
      jobId: dispute.jobId,
      disputeId: dispute.id,
      ageLabel: `seit ${ageDays} ${pluralizeTage(ageDays)}`,
    })
  }

  return signals
}

// ---------------------------------------------------------------------------
// deriveProviderGapSignals
// ---------------------------------------------------------------------------

/**
 * Detects provider profiles that are incomplete or not ready for discovery.
 */
export function deriveProviderGapSignals(
  providers: ProviderProfile[]
): PilotSignal[] {
  const signals: PilotSignal[] = []

  for (const provider of providers) {
    const isIncomplete =
      !provider.isPublic ||
      !provider.companyName ||
      !provider.city ||
      !provider.tradeCategories?.length

    if (isIncomplete) {
      const missingFields: string[] = []
      if (!provider.companyName) missingFields.push('Firmenname')
      if (!provider.city) missingFields.push('Stadt')
      if (!provider.tradeCategories?.length) missingFields.push('Gewerke')
      if (!provider.isPublic) missingFields.push('Sichtbarkeit')

      signals.push({
        id: `provider_incomplete_${provider.id}`,
        severity: 'warning',
        category: 'incomplete_provider',
        title: `Unvollständiges Profil: ${provider.companyName || provider.id}`,
        detail:
          missingFields.length > 0
            ? `Fehlende Felder: ${missingFields.join(', ')}.`
            : 'Profil ist nicht für die Entdeckung freigegeben.',
      })
    }
  }

  return signals
}

// ---------------------------------------------------------------------------
// deriveOwnershipGapSignals
// ---------------------------------------------------------------------------

/**
 * Detects ownership propagation gaps: jobs without a customer_user_id.
 */
export function deriveOwnershipGapSignals(jobs: Job[]): PilotSignal[] {
  const signals: PilotSignal[] = []

  for (const job of jobs) {
    if (!job.customerUserId) {
      signals.push({
        id: `ownership_gap_${job.id}`,
        severity: 'critical',
        category: 'ownership_gap',
        title: `Fehlende Kundenzuordnung: ${job.title}`,
        detail:
          'Dieser Auftrag hat keinen verknüpften Kunden-Account. Dies kann Zugriffsprobleme verursachen.',
        jobId: job.id,
      })
    }
  }

  return signals
}

// ---------------------------------------------------------------------------
// derivePilotDiagnosticsSummary — master aggregator
// ---------------------------------------------------------------------------

/**
 * Runs all diagnostic functions and returns a consolidated summary.
 */
export function derivePilotDiagnosticsSummary(
  jobs: Job[],
  payments: Payment[],
  disputes: Dispute[],
  providers: ProviderProfile[]
): PilotDiagnosticsSummary {
  const signals: PilotSignal[] = [
    ...deriveStuckJobSignals(jobs, payments),
    ...derivePaymentRiskSignals(payments, jobs),
    ...deriveDisputeSignals(disputes, jobs),
    ...deriveProviderGapSignals(providers),
    ...deriveOwnershipGapSignals(jobs),
  ]

  const criticalCount = signals.filter((s) => s.severity === 'critical').length
  const warningCount = signals.filter((s) => s.severity === 'warning').length
  const infoCount = signals.filter((s) => s.severity === 'info').length
  const totalCount = signals.length

  return {
    signals,
    criticalCount,
    warningCount,
    infoCount,
    totalCount,
    hasIssues: totalCount > 0,
  }
}
