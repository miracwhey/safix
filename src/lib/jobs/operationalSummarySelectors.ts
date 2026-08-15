import type { JobStatus, PaymentState } from '../shared/coreTypes'
import type { DisputeStatus } from '../disputes/types'
import type { SchedulingStatus } from '../operations/types'
import type { JobSchedule } from '../operations/types'
import type { ProjectTimelineSignal } from '../timeline/types'
import type { PayoutReadinessStatus } from '../payout/types'
import { getTimelineEventLabel } from '../timeline/timelineSelectors'
import { deriveNextAction, type NextActionViewModel } from './nextActionSelectors'
import { deriveCustomerNextAction } from './customerNextActionSelectors'
import {
  deriveProjectHealth,
  type ProjectHealthSummaryViewModel,
} from './projectHealthSelectors'
import {
  type ScheduleReadiness,
  getScheduleReadiness,
  getScheduleReadinessLabel,
} from '../operations/schedulingSelectors'
import { isFundingRequestTerminalDead } from '../payments/fundingRequest/fundingRequestStatus'

// ---------------------------------------------------------------------------
// Blocker types
// ---------------------------------------------------------------------------

/**
 * Describes the specific reason an operational flow is gated.
 *
 * - `'none'`                      – no blocker, work can continue freely
 * - `'awaiting_deposit'`          – customer must pay the deposit before work starts
 * - `'funding_expired'`           – the funding request is terminal-dead (expired/cancelled); craftsman must send a new request
 * - `'awaiting_customer_approval'`– craftsman requested release; waiting for customer
 * - `'dispute_open'`              – dispute opened; additional evidence can still be submitted
 * - `'dispute_evidence_required'` – SaFix requested evidence; must be submitted
 * - `'dispute_under_review'`      – SaFix is reviewing; no further party action required
 * - `'payment_frozen'`            – funds frozen due to active dispute
 * - `'schedule_overdue'`          – scheduled appointment window has passed without execution start
 * - `'payout_setup_required'`     – payment released but provider payout account not ready
 * - `'workflow_complete'`         – job is fully finished; no remaining actions
 */
export type OperationalBlockerReason =
  | 'none'
  | 'awaiting_deposit'
  | 'funding_expired'
  | 'awaiting_customer_approval'
  | 'dispute_open'
  | 'dispute_evidence_required'
  | 'dispute_under_review'
  | 'payment_frozen'
  | 'schedule_overdue'
  | 'payout_setup_required'
  | 'workflow_complete'

export type OperationalBlocker = {
  /** Structured reason for machine-readable logic */
  reason: OperationalBlockerReason
  /** Short human-readable label for display */
  label: string
  /** Longer explanation for tooltips / detail views */
  description: string
  /**
   * True when the blocker actively prevents the next workflow step.
   * False when informational only (e.g. a review is in progress).
   */
  isBlocking: boolean
  /**
   * True when the blocker should be surfaced in the UI as a badge/pill.
   * False for `'none'` and `'workflow_complete'` which require no visible indicator.
   */
  isDisplayed: boolean
}

// ---------------------------------------------------------------------------
// Phase types
// ---------------------------------------------------------------------------

/**
 * High-level operational phase of a job, derived from job + payment + dispute state.
 * Coarser than `JobStatus` — maps multiple raw states onto a single UI-friendly phase.
 */
export type OperationalPhase =
  | 'intake'           // new job, not yet scheduled
  | 'scheduling'       // scheduled, awaiting start
  | 'active'           // work in progress
  | 'awaiting_release' // work done, waiting for payment release
  | 'in_dispute'       // dispute active, funds frozen
  | 'complete'         // job fully resolved

// ---------------------------------------------------------------------------
// Timeline context
// ---------------------------------------------------------------------------

export type TimelineContextNote = {
  /** The underlying timeline event type */
  eventType: string
  /** Short label derived from the event type */
  label: string
  /** Human-readable description of what recently happened */
  description: string
  /** Unix timestamp (ms) of the event */
  occurredAt: number
  /** Pre-formatted date string for display */
  dateLabel: string
}

// ---------------------------------------------------------------------------
// Unified summary type
// ---------------------------------------------------------------------------

export type JobOperationalSummary = {
  jobId: string

  /** Coarse operational phase */
  phase: OperationalPhase
  /** Display label for the phase */
  phaseLabel: string

  /** Current blocker preventing the next step (reason === 'none' if unblocked) */
  blocker: OperationalBlocker

  /** Craftsman-perspective next action */
  nextAction: NextActionViewModel
  /** Customer-perspective next action */
  customerNextAction: NextActionViewModel

  /** Full project health breakdown */
  health: ProjectHealthSummaryViewModel

  /**
   * Context derived from the most recent timeline event.
   * Explains *why* the job is in its current state.
   * Null when no timeline events exist yet.
   */
  timelineContext: TimelineContextNote | null

  /** True when the job is fully resolved (no further work needed) */
  isComplete: boolean

  /** True when the customer must take an action to unblock progress */
  requiresCustomerAction: boolean
  /** True when the craftsman must take an action to move forward */
  requiresCraftsmanAction: boolean
  /** True when SaFix admin review is the next required step */
  requiresAdminAction: boolean

  /**
   * Operational readiness derived from the job's schedule timing.
   * Null when no schedule has been created for this job yet.
   */
  scheduleReadiness: ScheduleReadiness | null
  /** Human-readable label for the schedule readiness. Empty string when null. */
  scheduleReadinessLabel: string
  /** True when the job has no schedule and one should be created */
  needsScheduling: boolean

  /**
   * The scheduled start timestamp (ms) from the job's schedule.
   * Null when no schedule exists.
   */
  scheduledStart: number | null
  /**
   * The scheduled end timestamp (ms) from the job's schedule.
   * Null when no schedule exists.
   */
  scheduledEnd: number | null
}

// ---------------------------------------------------------------------------
// Internal derivation helpers
// ---------------------------------------------------------------------------

function derivePhase(
  jobStatus: JobStatus,
  paymentState: PaymentState | undefined,
  disputeStatus: DisputeStatus | undefined
): OperationalPhase {
  if (
    disputeStatus === 'open' ||
    disputeStatus === 'under_review' ||
    disputeStatus === 'customer_waiting' ||
    disputeStatus === 'provider_waiting'
  ) {
    return 'in_dispute'
  }

  if (jobStatus === 'completed') return 'complete'
  if (jobStatus === 'cancelled') return 'complete'
  if (jobStatus === 'waiting_payment') return 'awaiting_release'
  if (paymentState === 'release_pending') return 'awaiting_release'
  if (jobStatus === 'in_progress') return 'active'
  if (jobStatus === 'scheduled') return 'scheduling'
  return 'intake'
}

function getPhaseLabel(phase: OperationalPhase): string {
  switch (phase) {
    case 'intake':
      return 'Eingang'
    case 'scheduling':
      return 'Planung'
    case 'active':
      return 'Durchführung'
    case 'awaiting_release':
      return 'Freigabe ausstehend'
    case 'in_dispute':
      return 'Streitfall aktiv'
    case 'complete':
      return 'Abgeschlossen'
  }
}

function deriveBlocker(
  paymentState: PaymentState | undefined,
  disputeStatus: DisputeStatus | undefined,
  jobStatus: JobStatus,
  fundingStatus?: string,
  scheduleReadiness?: ScheduleReadiness | null,
  payoutReadinessStatus?: PayoutReadinessStatus
): OperationalBlocker {
  // Dispute blockers take the highest priority
  if (disputeStatus === 'customer_waiting' || disputeStatus === 'provider_waiting') {
    return {
      reason: 'dispute_evidence_required',
      label: 'Belege erforderlich',
      description:
        disputeStatus === 'customer_waiting'
          ? 'SaFix hat zusätzliche Unterlagen vom Kunden angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.'
          : 'SaFix hat zusätzliche Unterlagen vom Anbieter angefordert. Sobald die Belege vorliegen, geht der Fall in die Prüfung.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  if (disputeStatus === 'under_review') {
    return {
      reason: 'dispute_under_review',
      label: 'Prüfung läuft',
      description:
        'SaFix prüft den Streitfall anhand aller vorliegenden Informationen. Während der Prüfung sind keine weiteren Aktionen der Parteien erforderlich.',
      isBlocking: false,
      isDisplayed: true,
    }
  }

  if (disputeStatus === 'open') {
    return {
      reason: 'dispute_open',
      label: 'Streitfall offen',
      description:
        'Ein Streitfall wurde eröffnet und der Zahlungsbetrag ist eingefroren. Weitere Beweismittel können noch eingereicht werden.',
      isBlocking: false,
      isDisplayed: true,
    }
  }

  if (paymentState === 'disputed') {
    return {
      reason: 'payment_frozen',
      label: 'Zahlung eingefroren',
      description:
        'Der Zahlungsbetrag ist aufgrund eines aktiven Streitfalls eingefroren und kann weder freigegeben noch erstattet werden, bis der Fall gelöst ist.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  if (paymentState === 'release_pending') {
    return {
      reason: 'awaiting_customer_approval',
      label: 'Wartet auf Kundenfreigabe',
      description:
        'Die Freigabe wurde angefordert. Der Kunde muss die abgeschlossene Leistung abnehmen und den bereits über Stripe abgesicherten Betrag freigeben.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  // Terminal-dead funding (expired / cancelled): the existing request can no
  // longer be paid (HTTP 409 FUNDING_REQUEST_EXPIRED). The customer must NOT be
  // told to pay it — the craftsman has to send a new funding request. Checked
  // before the awaiting_deposit branch so the dead request is never presented
  // as a pending customer deposit.
  if (paymentState === 'deposit_required' && isFundingRequestTerminalDead(fundingStatus)) {
    return {
      reason: 'funding_expired',
      label: 'Zahlungsanfrage abgelaufen',
      description:
        'Die Zahlungsanfrage ist abgelaufen. Sende dem Kunden eine neue Zahlungsanfrage, damit der Auftrag finanziert werden kann.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  if (paymentState === 'deposit_required' && fundingStatus !== 'funded') {
    return {
      reason: 'awaiting_deposit',
      label: 'Zahlung ausstehend',
      description:
        'Der Kunde muss den vollständigen Betrag über Stripe absichern, bevor mit dem Auftrag begonnen werden kann.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  // Schedule overdue: the appointment window passed without execution starting.
  // Only relevant when the job is still in scheduling phase — a completed or
  // cancelled job would be caught by the terminal-state checks below.
  if (scheduleReadiness === 'overdue' && jobStatus === 'scheduled') {
    return {
      reason: 'schedule_overdue',
      label: 'Termin überfällig',
      description:
        'Der geplante Ausführungszeitraum ist abgelaufen und die Arbeit wurde noch nicht gestartet. Termin verschieben oder Ausführung manuell starten.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  // Payout setup required: payment released but craftsman cannot receive funds.
  // Must be checked before workflow_complete so completed jobs with blocked
  // payout still surface the blocker instead of showing a silent terminal state.
  if (
    paymentState === 'released' &&
    payoutReadinessStatus != null &&
    payoutReadinessStatus !== 'payout_ready'
  ) {
    return {
      reason: 'payout_setup_required',
      label: 'Auszahlungs-Konto erforderlich',
      description:
        'Die Zahlung wurde freigegeben, aber dein Auszahlungs-Konto ist noch nicht eingerichtet. Schließe das Setup ab, um die Zahlung zu erhalten.',
      isBlocking: true,
      isDisplayed: true,
    }
  }

  if (jobStatus === 'completed' || jobStatus === 'cancelled') {
    return {
      reason: 'workflow_complete',
      label: jobStatus === 'cancelled' ? 'Storniert' : 'Abgeschlossen',
      description:
        jobStatus === 'cancelled'
          ? 'Der Auftrag wurde storniert. Keine weiteren Aktionen erforderlich.'
          : 'Der Auftrag ist vollständig abgeschlossen. Keine weiteren Aktionen erforderlich.',
      isBlocking: false,
      isDisplayed: false,
    }
  }

  return {
    reason: 'none',
    label: 'Keine Blockierung',
    description: 'Der Auftrag kann ohne Einschränkungen weitergeführt werden.',
    isBlocking: false,
    isDisplayed: false,
  }
}

function formatDateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Derives a human-readable context note from the most recent timeline signal.
 * Returns null when no signals exist.
 */
function deriveTimelineContext(
  signals: ReadonlyArray<ProjectTimelineSignal>
): TimelineContextNote | null {
  if (signals.length === 0) return null

  const latest = signals[signals.length - 1]

  return {
    eventType: latest.type,
    label: getTimelineEventLabel(latest.type),
    description: getTimelineEventContextDescription(latest.type),
    occurredAt: latest.occurredAt,
    dateLabel: formatDateLabel(latest.occurredAt),
  }
}

function getTimelineEventContextDescription(
  type: ProjectTimelineSignal['type']
): string {
  switch (type) {
    case 'job_created':
      return 'Auftrag wurde angelegt.'
    case 'scheduled':
      return 'Termin wurde eingeplant.'
    case 'work_started':
      return 'Durchführung wurde gestartet.'
    case 'waiting_payment':
      return 'Auftrag wartet auf Zahlungsfreigabe.'
    case 'photo_added':
      return 'Dokumentationsfoto wurde hinzugefügt.'
    case 'artifact_attached':
      return 'Anhang wurde dem Auftrag beigefügt.'
    case 'dispute_evidence_attached':
      return 'Beweismittel für den Streitfall wurde eingereicht.'
    case 'invoice_created':
      return 'Rechnung wurde erstellt.'
    case 'deposit_paid':
      return 'Zahlung ist bestätigt.'
    case 'escrow_locked':
      return 'Zahlungsbetrag wurde im Zahlung abgesichert.'
    case 'release_requested':
      return 'Freigabe der Zahlung wurde beantragt.'
    case 'payment_released':
      return 'Zahlung wurde freigegeben und ausgezahlt.'
    case 'dispute_opened':
      return 'Streitfall wurde eröffnet.'
    case 'dispute_resolved':
      return 'Streitfall wurde abgeschlossen.'
    case 'dispute_under_review':
      return 'Streitfall wird von SaFix geprüft.'
    case 'dispute_evidence_requested':
      return 'SaFix hat weitere Belege angefordert.'
    case 'payment_refunded':
      return 'Zahlung wurde zurückerstattet.'
    case 'job_scheduled':
      return 'Ausführungsfenster wurde geplant.'
    case 'schedule_updated':
      return 'Zeitplan wurde aktualisiert.'
    case 'schedule_confirmed':
      return 'Termin wurde verbindlich bestätigt.'
    case 'schedule_rescheduled':
      return 'Termin wurde auf einen neuen Zeitpunkt verschoben.'
    case 'schedule_cancelled':
      return 'Geplanter Termin wurde abgesagt.'
    case 'execution_started':
      return 'Planmäßige Ausführung hat begonnen.'
    case 'execution_completed':
      return 'Planmäßige Ausführung wurde abgeschlossen.'
    case 'proposal_sent':
      return 'Angebot wurde an den Kunden übermittelt.'
    case 'proposal_accepted':
      return 'Kunde hat das Angebot angenommen.'
    case 'execution_ready':
      return 'Ausführungsvorbereitung wurde gestartet. Termin kann eingeplant werden.'
    case 'job_completed':
      return 'Auftrag wurde vollständig abgeschlossen.'
    default:
      return 'Zuletzt aktualisiert.'
  }
}

function deriveActionOwnership(
  blocker: OperationalBlocker,
  phase: OperationalPhase,
  proposalSentAt?: number,
  proposalAcceptedAt?: number
): {
  requiresCustomerAction: boolean
  requiresCraftsmanAction: boolean
  requiresAdminAction: boolean
} {
  if (blocker.reason === 'awaiting_deposit') {
    return {
      requiresCustomerAction: true,
      requiresCraftsmanAction: false,
      requiresAdminAction: false,
    }
  }

  // Terminal-dead funding: the customer cannot act on a dead request — the
  // craftsman must send a new funding request.
  if (blocker.reason === 'funding_expired') {
    return {
      requiresCustomerAction: false,
      requiresCraftsmanAction: true,
      requiresAdminAction: false,
    }
  }

  if (blocker.reason === 'awaiting_customer_approval') {
    return {
      requiresCustomerAction: true,
      requiresCraftsmanAction: false,
      requiresAdminAction: false,
    }
  }

  if (blocker.reason === 'dispute_evidence_required') {
    return {
      requiresCustomerAction: true,
      requiresCraftsmanAction: true,
      requiresAdminAction: false,
    }
  }

  if (blocker.reason === 'dispute_under_review') {
    return {
      requiresCustomerAction: false,
      requiresCraftsmanAction: false,
      requiresAdminAction: true,
    }
  }

  if (blocker.reason === 'dispute_open' || blocker.reason === 'payment_frozen') {
    return {
      requiresCustomerAction: false,
      requiresCraftsmanAction: false,
      requiresAdminAction: true,
    }
  }

  // Overdue schedule: craftsman must reschedule or manually start execution
  if (blocker.reason === 'schedule_overdue') {
    return {
      requiresCustomerAction: false,
      requiresCraftsmanAction: true,
      requiresAdminAction: false,
    }
  }

  // Payout setup: craftsman must complete their Connect account setup
  if (blocker.reason === 'payout_setup_required') {
    return {
      requiresCustomerAction: false,
      requiresCraftsmanAction: true,
      requiresAdminAction: false,
    }
  }

  if (phase === 'complete' || blocker.reason === 'workflow_complete') {
    return {
      requiresCustomerAction: false,
      requiresCraftsmanAction: false,
      requiresAdminAction: false,
    }
  }

  // Proposal awaiting customer response: customer must act
  if (phase === 'intake' && proposalSentAt && !proposalAcceptedAt) {
    return {
      requiresCustomerAction: true,
      requiresCraftsmanAction: false,
      requiresAdminAction: false,
    }
  }

  // Work is done; customer must release payment (waiting_payment phase)
  if (phase === 'awaiting_release') {
    return {
      requiresCustomerAction: true,
      requiresCraftsmanAction: false,
      requiresAdminAction: false,
    }
  }

  // Default active phases: craftsman drives the workflow
  return {
    requiresCustomerAction: false,
    requiresCraftsmanAction: true,
    requiresAdminAction: false,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derives a unified operational summary for a job from all relevant lifecycle
 * dimensions: job status, payment state, dispute status, scheduling status,
 * artifact count, and timeline signals.
 *
 * This is a pure read-helper — no transitions or mutations occur here.
 *
 * The returned `JobOperationalSummary` is designed to be the single coherent
 * operational picture that both craftsman-facing and customer-facing screens
 * can consume without re-deriving scattered state from multiple stores.
 */
export function deriveJobOperationalSummary(params: {
  jobId: string
  jobStatus: JobStatus
  paymentState: PaymentState | undefined
  disputeStatus: DisputeStatus | undefined
  schedulingStatus: SchedulingStatus | undefined
  schedule: JobSchedule | undefined
  artifactCount: number
  timelineSignals: ReadonlyArray<ProjectTimelineSignal>
  nowMs?: number
  proposalSentAt?: number
  proposalAcceptedAt?: number
  fundingStatus?: string
  payoutReadinessStatus?: PayoutReadinessStatus
}): JobOperationalSummary {
  const {
    jobId,
    jobStatus,
    paymentState,
    disputeStatus,
    schedulingStatus,
    schedule,
    artifactCount,
    timelineSignals,
    nowMs = Date.now(),
    proposalSentAt,
    proposalAcceptedAt,
    fundingStatus,
    payoutReadinessStatus,
  } = params

  // Compute schedule readiness first — it feeds into both blocker and nextAction.
  const scheduleReadiness = schedule
    ? getScheduleReadiness(schedule, nowMs)
    : null

  const phase = derivePhase(jobStatus, paymentState, disputeStatus)
  const blocker = deriveBlocker(
    paymentState,
    disputeStatus,
    jobStatus,
    fundingStatus,
    scheduleReadiness,
    payoutReadinessStatus
  )
  const nextAction = deriveNextAction(
    jobStatus,
    paymentState,
    disputeStatus,
    proposalSentAt,
    proposalAcceptedAt,
    fundingStatus,
    scheduleReadiness ?? undefined,
    payoutReadinessStatus
  )
  const customerNextAction = deriveCustomerNextAction(
    jobStatus,
    paymentState,
    disputeStatus,
    proposalSentAt,
    proposalAcceptedAt,
    fundingStatus
  )
  const health = deriveProjectHealth(
    jobStatus,
    paymentState,
    disputeStatus,
    schedulingStatus,
    artifactCount
  )
  const timelineContext = deriveTimelineContext(timelineSignals)
  const { requiresCustomerAction, requiresCraftsmanAction, requiresAdminAction } =
    deriveActionOwnership(blocker, phase, proposalSentAt, proposalAcceptedAt)

  const scheduleReadinessLabel = scheduleReadiness
    ? getScheduleReadinessLabel(scheduleReadiness)
    : ''
  const needsScheduling =
    scheduleReadiness === null &&
    jobStatus !== 'completed' &&
    jobStatus !== 'cancelled' &&
    phase !== 'complete'

  return {
    jobId,
    phase,
    phaseLabel: getPhaseLabel(phase),
    blocker,
    nextAction,
    customerNextAction,
    health,
    timelineContext,
    isComplete: phase === 'complete',
    requiresCustomerAction,
    requiresCraftsmanAction,
    requiresAdminAction,
    scheduleReadiness,
    scheduleReadinessLabel,
    needsScheduling,
    scheduledStart: schedule?.scheduledStart ?? null,
    scheduledEnd: schedule?.scheduledEnd ?? null,
  }
}
