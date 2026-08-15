import type { Job } from './types'
import type { FundingRequestStatus } from '../payments/fundingRequest/types'
import type { EscrowPlanStatus } from '../payments/escrow/escrowTypes'

// ---------------------------------------------------------------------------
// Provider Operational Phase
// ---------------------------------------------------------------------------

/**
 * The provider-facing operational phase for a job.
 *
 * Derived from persisted truth (JobStatus, proposal timestamps, funding
 * request status, escrow plan status) — NOT a separate persisted enum.
 *
 * Phases follow the real execution lifecycle:
 *   quote_sent → quote_accepted → funding_not_requested → funding_requested
 *   → funding_pending → funded_in_escrow → work_started → work_completed
 *   → awaiting_release → closed
 *
 * Dispute compatibility: `disputed` is an overlay, not a replacement.
 */
export type ProviderJobPhase =
  | 'quote_sent'
  | 'quote_accepted'
  | 'funding_not_requested'
  | 'funding_requested'
  | 'funding_pending'
  | 'funded_in_escrow'
  | 'work_started'
  | 'work_completed'
  | 'awaiting_release'
  | 'partially_released'
  | 'payment_released'
  | 'closed'
  | 'disputed'
  | 'cancelled'

export type ProviderPhaseConfig = {
  label: string
  icon: string
  badge: string
  dot: string
}

export const PROVIDER_PHASE_CONFIG: Record<ProviderJobPhase, ProviderPhaseConfig> = {
  quote_sent: {
    label: 'Angebot gesendet',
    icon: '📤',
    badge: 'bg-blue-50 text-blue-700 ring-blue-200',
    dot: 'bg-blue-500',
  },
  quote_accepted: {
    label: 'Angebot angenommen',
    icon: '✅',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  funding_not_requested: {
    label: 'Einzahlung anfordern',
    icon: '💶',
    badge: 'bg-amber-50 text-amber-700 ring-amber-200',
    dot: 'bg-amber-500',
  },
  funding_requested: {
    label: 'Einzahlung angefordert',
    icon: '📨',
    badge: 'bg-blue-50 text-blue-700 ring-blue-200',
    dot: 'bg-blue-500',
  },
  funding_pending: {
    label: 'Warte auf Einzahlung',
    icon: '⏳',
    badge: 'bg-amber-50 text-amber-700 ring-amber-200',
    dot: 'bg-amber-400',
  },
  funded_in_escrow: {
    label: 'Bereit zum Start',
    icon: '🟢',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  work_started: {
    label: 'In Arbeit',
    icon: '🔨',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  work_completed: {
    label: 'Arbeit abgeschlossen',
    icon: '🏁',
    badge: 'bg-violet-50 text-violet-700 ring-violet-200',
    dot: 'bg-violet-500',
  },
  awaiting_release: {
    label: 'Warte auf Freigabe',
    icon: '💰',
    badge: 'bg-amber-50 text-amber-700 ring-amber-200',
    dot: 'bg-amber-500',
  },
  partially_released: {
    label: 'Teilweise freigegeben',
    icon: '💶',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  payment_released: {
    label: 'Vollständig freigegeben',
    icon: '✅',
    badge: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  closed: {
    label: 'Abgeschlossen',
    icon: '✅',
    badge: 'bg-slate-100 text-slate-600 ring-slate-200',
    dot: 'bg-slate-400',
  },
  disputed: {
    label: 'Streitfall',
    icon: '⚖️',
    badge: 'bg-red-50 text-red-700 ring-red-200',
    dot: 'bg-red-500',
  },
  cancelled: {
    label: 'Storniert',
    icon: '❌',
    badge: 'bg-slate-100 text-slate-500 ring-slate-200',
    dot: 'bg-slate-400',
  },
}

/**
 * Ordered list of phases for progress bar calculation.
 * Disputed/cancelled are excluded as they are overlay states.
 */
export const PROVIDER_PHASE_ORDER: ProviderJobPhase[] = [
  'quote_sent',
  'quote_accepted',
  'funding_not_requested',
  'funding_requested',
  'funding_pending',
  'funded_in_escrow',
  'work_started',
  'work_completed',
  'awaiting_release',
  'partially_released',
  'payment_released',
  'closed',
]

// ---------------------------------------------------------------------------
// Phase View Model
// ---------------------------------------------------------------------------

export type ProviderPhaseViewModel = {
  phase: ProviderJobPhase
  label: string
  icon: string
  activeIndex: number
}

// ---------------------------------------------------------------------------
// Funding request status sets
// ---------------------------------------------------------------------------

const FUNDING_IN_PROGRESS_STATUSES = new Set<string>([
  'created', 'sent', 'funding_started', 'funding_initiated',
])

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derives the provider-facing operational phase from persisted truth.
 *
 * This is a **pure function** — no mutations, no side effects.
 * It computes the phase entirely from the job record + optional
 * funding/escrow status.
 *
 * @param job             The job entity
 * @param fundingStatus   FundingRequestStatus (from getFundingRequestByJobId)
 * @param escrowStatus    EscrowPlanStatus (from getEscrowPlanByJobId)
 */
export function deriveProviderJobPhase(
  job: Job,
  fundingStatus?: FundingRequestStatus | string,
  escrowStatus?: EscrowPlanStatus | string
): ProviderPhaseViewModel {
  let phase: ProviderJobPhase

  // Terminal states first
  if (job.status === 'cancelled') {
    phase = 'cancelled'
  } else if (
    job.disputeStatus === 'open' ||
    job.disputeStatus === 'under_review' ||
    job.disputeStatus === 'customer_waiting' ||
    job.disputeStatus === 'provider_waiting'
  ) {
    phase = 'disputed'
  } else if (job.status === 'completed') {
    // Distinguish fully-released from generic closed.
    // Both conditions are checked because escrowStatus may not always be
    // provided (e.g. when the caller doesn't have the escrow plan loaded).
    // paymentReleasedAt is set by releaseEligibleTranche when the plan
    // becomes fully_released, so they are synchronized in the release flow.
    if (escrowStatus === 'fully_released' || job.paymentReleasedAt) {
      phase = 'payment_released'
    } else {
      phase = 'closed'
    }
  } else if (job.status === 'waiting_payment') {
    // Work is done, waiting for payment release
    if (escrowStatus === 'partially_released') {
      phase = 'partially_released'
    } else {
      phase = job.workCompletedAt ? 'awaiting_release' : 'work_completed'
    }
  } else if (job.status === 'in_progress') {
    phase = 'work_started'
  } else if (
    escrowStatus === 'funded_in_escrow' ||
    fundingStatus === 'funded'
  ) {
    phase = 'funded_in_escrow'
  } else if (
    fundingStatus && FUNDING_IN_PROGRESS_STATUSES.has(fundingStatus)
  ) {
    // Differentiate between "just requested" and "customer has started paying"
    if (fundingStatus === 'funding_started' || fundingStatus === 'funding_initiated') {
      phase = 'funding_pending'
    } else {
      phase = 'funding_requested'
    }
  } else if (job.proposalAcceptedAt) {
    // Accepted but no funding request yet
    phase = 'funding_not_requested'
  } else if (job.proposalSentAt) {
    phase = 'quote_sent'
  } else if (job.status === 'booked') {
    // Booked via acceptOfferWorkflow but proposalAcceptedAt may not be set yet
    phase = 'funding_not_requested'
  } else {
    // New job, no proposal yet — still use quote_sent as minimum
    phase = 'quote_sent'
  }

  const config = PROVIDER_PHASE_CONFIG[phase]
  const activeIndex = PROVIDER_PHASE_ORDER.indexOf(phase)

  return {
    phase,
    label: config.label,
    icon: config.icon,
    activeIndex: activeIndex >= 0 ? activeIndex : -1,
  }
}

// ---------------------------------------------------------------------------
// Execution grouping (used by CraftsmanJobsScreen)
// ---------------------------------------------------------------------------

export type ProviderExecutionGroup =
  | 'action_required'   // funding_not_requested, funded_in_escrow
  | 'waiting'           // quote_sent, funding_requested, funding_pending, awaiting_release
  | 'in_execution'      // work_started
  | 'completed'         // work_completed, closed
  | 'blocked'           // disputed

export type ProviderExecutionSummary = {
  actionRequired: Job[]
  waiting: Job[]
  inExecution: Job[]
  completed: Job[]
  blocked: Job[]
  totalActive: number
}

/**
 * Groups jobs by their execution status for the provider jobs screen.
 * Each job is classified based on its derived phase.
 */
export function deriveProviderExecutionSummary(
  jobs: Job[],
  getPhase: (job: Job) => ProviderPhaseViewModel
): ProviderExecutionSummary {
  const actionRequired: Job[] = []
  const waiting: Job[] = []
  const inExecution: Job[] = []
  const completed: Job[] = []
  const blocked: Job[] = []

  for (const job of jobs) {
    if (job.status === 'cancelled') continue

    const { phase } = getPhase(job)

    switch (phase) {
      case 'funding_not_requested':
      case 'funded_in_escrow':
        actionRequired.push(job)
        break
      case 'quote_sent':
      case 'quote_accepted':
      case 'funding_requested':
      case 'funding_pending':
      case 'awaiting_release':
      case 'partially_released':
        waiting.push(job)
        break
      case 'work_started':
        inExecution.push(job)
        break
      case 'work_completed':
      case 'payment_released':
      case 'closed':
        completed.push(job)
        break
      case 'disputed':
        blocked.push(job)
        break
      case 'cancelled':
        break
    }
  }

  return {
    actionRequired,
    waiting,
    inExecution,
    completed,
    blocked,
    totalActive: actionRequired.length + waiting.length + inExecution.length + blocked.length,
  }
}
