export type ProjectTimelineEventType =
  | 'job_created'
  | 'scheduled'
  | 'work_started'
  | 'waiting_payment'
  | 'photo_added'
  | 'artifact_attached'
  | 'dispute_evidence_attached'
  | 'invoice_created'
  | 'invoice_issued'
  | 'invoice_sent'
  | 'invoice_cancelled'
  | 'invoice_credit_note_issued'
  | 'deposit_paid'
  | 'escrow_locked'
  | 'release_requested'
  | 'payment_released'
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'dispute_resolved_release'
  | 'dispute_resolved_refund'
  | 'dispute_resolved_split'
  // Block P · Run 2 — T+80 AGB partial-default. Emitted server-side by the
  // dispute-default-cut cron (api/_disputeDefaultCut.ts) when the held remainder
  // is refunded 75/25 under reservation (right-of-recourse). Deliberately NOT in
  // NOTIFICATION_EVENT_CONFIG, so it surfaces in-app only (email is the awareness
  // channel) and fires no push. Distinct from the operator `dispute_resolved_*`
  // copy, which would misdescribe this as a full refund / closed case.
  | 'dispute_default_refund_applied'
  | 'dispute_rejected'
  | 'payment_refunded'
  | 'job_completed'
  | 'dispute_under_review'
  | 'dispute_evidence_requested'
  | 'job_scheduled'
  | 'schedule_updated'
  | 'schedule_confirmed'
  | 'schedule_rescheduled'
  | 'schedule_cancelled'
  | 'execution_started'
  | 'execution_completed'
  | 'proposal_sent'
  | 'proposal_accepted'
  | 'execution_ready'
  | 'work_completed'
  | 'worker_marked_complete'
  | 'admin_confirmed_complete'
  | 'admin_rejected_completion'
  | 'acceptance_reminder_24h'
  | 'acceptance_reminder_60h'
  | 'acceptance_customer_released'
  | 'acceptance_auto_released'
  | 'funding_requested'
  | 'tranche_25_eligible'
  | 'tranche_75_eligible'
  | 'tranche_released'
  | 'release_blocked'
  | 'payout_handoff_initiated'
  | 'payout_handoff_failed'
  | 'payout_completed'
  | 'payout_failed'
  | 'transfer_reversed'
  | 'offer_sent'
  | 'offer_accepted'
  | 'change_order_sent'
  | 'change_order_accepted'
  | 'change_order_declined'
  | 'change_order_cancelled'
  | 'supplementary_payment_required'
  | 'supplementary_acknowledged'
  | 'supplementary_funding_initiated'
  | 'supplementary_funded'
  | 'supplementary_released'
  | 'supplementary_paid'
  | 'supplementary_waived'
  | 'correction_created'
  | 'correction_resolved'
  | 'correction_rejected'
  // Spatial V1.5 · Provider-Pre-Sales-Conversion (Phase B-P4):
  // emitted after `createJobFromPresalesProject` succeeds. `jobId` is the
  // newly-created job; `entityId` is the source `provider_presales_projects.id`
  // so downstream listings can link back to the original aufmaß.
  | 'presales_converted'
  // Spatial Lane 3 V1.6 Block 3: emitted when HW flips
  // scans.shared_with_customer = true on a job-anchored scan. `jobId` is the
  // job; `entityId` is the scan.id so the push deep-link can navigate to
  // /customer/spatial/scan/{entityId}.
  | 'spatial_shared_with_customer'

export type ProjectTimelineSignal = {
  id: string
  jobId: string
  type: ProjectTimelineEventType
  occurredAt: number
  /**
   * Optional poly-domain entity reference (e.g. `offers.id` for `offer_sent`).
   * Propagated to `notification_signals.entity_id` by the bridge, then to
   * push payload `data.entityId` by the DB trigger, then to deep-link route
   * templates by the push route map. NULL when the event has no targetable
   * entity (e.g. timeline-only events without a customer-facing deep-link).
   */
  entityId?: string | null
}

export type TimelineEventAccent =
  | 'blue'
  | 'emerald'
  | 'violet'
  | 'amber'
  | 'rose'
  | 'slate'

export type ProjectTimelineEvent = {
  id: string
  jobId: string
  type: ProjectTimelineEventType
  title: string
  description: string
  label: string
  accent: TimelineEventAccent
  dateLabel: string
  createdAt: number
}
