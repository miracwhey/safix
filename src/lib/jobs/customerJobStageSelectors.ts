import type { JobStatus, PaymentState } from '../shared/coreTypes'
import { deriveProposalLifecycle } from './helpers'

/**
 * Named lifecycle stage from the customer's perspective.
 * These 9 stages map the entire inquiry→payment lifecycle to
 * simple, human-readable milestones.
 */
export type CustomerJobStage =
  | 'inquiry_sent'           // Job exists, proposal not yet sent
  | 'offer_received'         // Proposal sent but not accepted
  | 'offer_accepted'         // Proposal accepted, not yet funded
  | 'funding_pending'        // Funding requested, awaiting customer payment
  | 'funded_in_escrow'       // Customer has funded, work can start
  | 'work_in_progress'       // Job status is in_progress
  | 'work_completed'         // Job waiting_payment or release_pending
  | 'partially_released'     // First tranche (25%) released, rest pending
  | 'payment_released'       // Completed: all payment released or refunded

export type CustomerStageViewModel = {
  stage: CustomerJobStage
  /** 0-based index of the active stage in STAGE_ORDER */
  activeIndex: number
}

// Ordered list of all stages (used for progress calculation)
export const CUSTOMER_STAGE_ORDER: CustomerJobStage[] = [
  'inquiry_sent',
  'offer_received',
  'offer_accepted',
  'funding_pending',
  'funded_in_escrow',
  'work_in_progress',
  'work_completed',
  'partially_released',
  'payment_released',
]

/**
 * Human-readable short labels for each stage.
 * Keep them short (≤15 chars) so they fit inline.
 */
export const CUSTOMER_STAGE_LABELS: Record<CustomerJobStage, string> = {
  inquiry_sent: 'Anfrage',
  offer_received: 'Angebot',
  offer_accepted: 'Annahme',
  funding_pending: 'Vorbereitung',
  funded_in_escrow: 'Startbereit',
  work_in_progress: 'Arbeit läuft',
  work_completed: 'Abnahme',
  partially_released: 'Teilfreigabe',
  payment_released: 'Fertig',
}

/**
 * Derives the current customer-facing lifecycle stage from job + payment state.
 * Pure function — no mutations.
 *
 * @param escrowStatus  Optional EscrowPlanStatus to distinguish partial vs full release.
 */
export function deriveCustomerJobStage(
  jobStatus: JobStatus,
  paymentState: PaymentState | undefined,
  proposalSentAt?: number,
  proposalAcceptedAt?: number,
  fundingStatus?: string,
  escrowStatus?: string
): CustomerStageViewModel {
  const lifecycle = deriveProposalLifecycle(proposalSentAt, proposalAcceptedAt)
  const isAccepted = lifecycle.stage === 'accepted'
  const isSent = lifecycle.stage === 'sent' || lifecycle.stage === 'accepted'
  const actionablePaymentState =
    jobStatus !== 'new' || isAccepted ? paymentState : undefined

  // Derive funding awareness
  const FUNDING_REQUESTED_STATUSES = new Set(['sent', 'created', 'funding_started', 'funding_initiated'])
  const FUNDED_PAYMENT_STATES = new Set(['deposit_paid', 'in_escrow'])
  const isFundingRequested = FUNDING_REQUESTED_STATUSES.has(fundingStatus ?? '')
  const isFundedInEscrow = fundingStatus === 'funded' || FUNDED_PAYMENT_STATES.has(actionablePaymentState ?? '')

  let stage: CustomerJobStage

  if (lifecycle.stage === 'invalid') {
    stage = 'inquiry_sent'
  } else
  if (
    actionablePaymentState === 'released' ||
    actionablePaymentState === 'refunded' ||
    escrowStatus === 'fully_released'
  ) {
    // Terminal payment truth — payment has been released or refunded.
    stage = 'payment_released'
  } else if (jobStatus === 'completed' || jobStatus === 'cancelled') {
    // Job is terminal but payment state is not yet terminal — show work_completed
    // rather than prematurely projecting payment_released.  This covers the
    // edge case where job.status advanced before the downstream payment state
    // caught up (e.g. due to partial-success propagation).
    stage = 'work_completed'
  } else if (escrowStatus === 'partially_released') {
    // First tranche released but not all — distinct from work_completed
    stage = 'partially_released'
  } else if (
    jobStatus === 'waiting_payment' ||
    actionablePaymentState === 'release_pending'
  ) {
    stage = 'work_completed'
  } else if (
    jobStatus === 'in_progress' ||
    actionablePaymentState === 'work_in_progress'
  ) {
    stage = 'work_in_progress'
  } else if (isFundedInEscrow) {
    stage = 'funded_in_escrow'
  } else if (isFundingRequested && isAccepted) {
    stage = 'funding_pending'
  } else if (isAccepted) {
    stage = 'offer_accepted'
  } else if (isSent) {
    stage = 'offer_received'
  } else {
    stage = 'inquiry_sent'
  }

  return {
    stage,
    activeIndex: CUSTOMER_STAGE_ORDER.indexOf(stage),
  }
}
