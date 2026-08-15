import type { ProjectTimelineEventType } from '../timeline'
import type { AttentionRole, NotificationPriority } from './types'

/**
 * Maps notification-worthy timeline event types to their display priority.
 * Event types absent from this map do not produce notification signals.
 */
export const NOTIFICATION_EVENT_CONFIG: Partial<
  Record<ProjectTimelineEventType, NotificationPriority>
> = {
  work_started: 'info',
  deposit_paid: 'info',
  escrow_locked: 'info',
  invoice_created: 'info',
  invoice_issued: 'info',
  invoice_sent: 'info',
  invoice_cancelled: 'alert',
  invoice_credit_note_issued: 'info',
  release_requested: 'action',
  payment_released: 'info',
  dispute_opened: 'alert',
  dispute_resolved: 'alert',
  dispute_under_review: 'action',
  dispute_evidence_attached: 'info',
  dispute_evidence_requested: 'alert',
  payment_refunded: 'alert',
  job_completed: 'info',
  schedule_confirmed: 'info',
  schedule_rescheduled: 'action',
  schedule_cancelled: 'alert',
  execution_started: 'info',
  execution_completed: 'info',
  proposal_accepted: 'action',
  execution_ready: 'info',
  funding_requested: 'action',
  tranche_25_eligible: 'info',
  tranche_75_eligible: 'info',
  tranche_released: 'info',
  release_blocked: 'action',
  payout_handoff_initiated: 'info',
  payout_handoff_failed: 'alert',
  payout_completed: 'info',
  payout_failed: 'alert',
  transfer_reversed: 'alert',
  work_completed: 'action',
  worker_marked_complete: 'action',
  admin_confirmed_complete: 'action',
  admin_rejected_completion: 'action',
  acceptance_reminder_24h: 'action',
  acceptance_reminder_60h: 'action',
  acceptance_customer_released: 'info',
  acceptance_auto_released: 'info',
  supplementary_acknowledged: 'info',
  supplementary_funding_initiated: 'info',
  supplementary_funded: 'info',
  supplementary_released: 'info',
  supplementary_paid: 'info',
  supplementary_waived: 'info',
  // Block 7.2.2 — correction-request workflows (Phase 4 backend)
  correction_created: 'action',
  correction_resolved: 'info',
  correction_rejected: 'alert',
  // Spatial C-10 · C10.5 — Customer must act on a Spatial-Quote
  // (accept / decline / counter). 'action' priority surfaces it as a
  // top-of-feed item rather than info-noise.
  offer_sent: 'action',
  // Spatial V1.5 · Phase B-P4 — Provider sees the job they just created from
  // a Pre-Sales-Aufmaß surface as an info-level event ("Auftrag erstellt").
  presales_converted: 'info',
  // Spatial Lane 3 V1.6 Block 3 — Customer-only: "Dein Handwerker hat dir das
  // Aufmaß freigegeben". Info-priority is intentional — no customer action
  // required, just a nudge to open the room and look around.
  spatial_shared_with_customer: 'info',
}

/**
 * Maps event types to their role relevance.
 * Events not listed are relevant to all roles.
 */
export const NOTIFICATION_ROLE_RELEVANCE: Partial<
  Record<ProjectTimelineEventType, AttentionRole[]>
> = {
  release_requested: ['customer', 'craftsman'],
  deposit_paid: ['craftsman'],
  work_started: ['customer'],
  invoice_created: ['craftsman'],
  invoice_issued: ['craftsman'],
  invoice_sent: ['customer', 'craftsman'],
  invoice_cancelled: ['customer', 'craftsman'],
  invoice_credit_note_issued: ['customer', 'craftsman'],
  dispute_opened: ['customer', 'craftsman', 'admin'],
  dispute_resolved: ['customer', 'craftsman', 'admin'],
  dispute_under_review: ['customer', 'craftsman', 'admin'],
  dispute_evidence_attached: ['admin'],
  dispute_evidence_requested: ['customer', 'craftsman'],
  payment_released: ['craftsman'],
  payment_refunded: ['customer'],
  schedule_confirmed: ['customer', 'craftsman'],
  schedule_rescheduled: ['customer', 'craftsman'],
  schedule_cancelled: ['customer', 'craftsman'],
  execution_started: ['customer'],
  execution_completed: ['customer', 'craftsman'],
  job_completed: ['customer', 'craftsman'],
  proposal_accepted: ['craftsman'],
  execution_ready: ['craftsman'],
  funding_requested: ['customer'],
  tranche_25_eligible: ['customer', 'craftsman'],
  tranche_75_eligible: ['customer', 'craftsman'],
  tranche_released: ['customer', 'craftsman'],
  release_blocked: ['customer', 'craftsman'],
  payout_handoff_initiated: ['craftsman'],
  payout_handoff_failed: ['craftsman', 'admin'],
  payout_completed: ['craftsman'],
  payout_failed: ['craftsman', 'admin'],
  transfer_reversed: ['craftsman', 'admin'],
  work_completed: ['customer'],
  // Block 7.2.1b — admin-confirm-gate
  worker_marked_complete: ['craftsman'],
  admin_confirmed_complete: ['customer'],
  admin_rejected_completion: ['craftsman'],
  // Block 7.2.1e — acceptance reminder cron + customer/auto release fan-out
  acceptance_reminder_24h: ['customer'],
  acceptance_reminder_60h: ['customer'],
  acceptance_customer_released: ['craftsman'],
  acceptance_auto_released: ['craftsman'],
  supplementary_acknowledged: ['customer', 'craftsman'],
  supplementary_funding_initiated: ['customer'],
  supplementary_funded: ['customer', 'craftsman'],
  supplementary_released: ['craftsman'],
  supplementary_paid: ['customer', 'craftsman'],
  supplementary_waived: ['customer', 'craftsman'],
  // Block 7.2.2 — correction-request workflows (Phase 4 backend)
  correction_created: ['craftsman'],
  correction_resolved: ['craftsman'],
  correction_rejected: ['craftsman'],
  // Spatial C-10 · C10.5 — Customer-only (Provider sent the quote, doesn't
  // need a push back to themselves).
  offer_sent: ['customer'],
  // Spatial V1.5 · Phase B-P4 — Provider-only: this is an internal artefact
  // of the conversion flow; no customer-facing surface exists yet.
  presales_converted: ['craftsman'],
  // Spatial Lane 3 V1.6 Block 3 — Customer-only push.
  spatial_shared_with_customer: ['customer'],
}

/**
 * Returns the roles for which a notification event type is relevant.
 * Returns undefined (all roles) if the event is not specifically scoped.
 */
export function getNotificationRoleRelevance(
  type: ProjectTimelineEventType
): AttentionRole[] | undefined {
  return NOTIFICATION_ROLE_RELEVANCE[type]
}

export function getNotificationPriority(
  type: ProjectTimelineEventType
): NotificationPriority | undefined {
  return NOTIFICATION_EVENT_CONFIG[type]
}

export function isNotifiableEventType(type: ProjectTimelineEventType): boolean {
  return type in NOTIFICATION_EVENT_CONFIG
}
