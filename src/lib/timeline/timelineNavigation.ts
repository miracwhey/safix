import type { ProjectTimelineEvent, ProjectTimelineEventType } from './types'

export type TimelineNavTarget = {
  path: string
  label: string
}

const DISPUTE_TYPES: ReadonlyArray<ProjectTimelineEventType> = [
  'dispute_opened',
  'dispute_resolved',
  'dispute_evidence_attached',
]

/** Invoice events: craftsmen navigate to the dedicated invoices screen. */
const INVOICE_TYPES: ReadonlyArray<ProjectTimelineEventType> = [
  'invoice_created',
  'invoice_issued',
  'invoice_sent',
  'invoice_cancelled',
  'invoice_credit_note_issued',
]

const SCHEDULE_TYPES: ReadonlyArray<ProjectTimelineEventType> = [
  'scheduled',
  'job_scheduled',
  'schedule_updated',
  'schedule_confirmed',
  'execution_started',
  'execution_completed',
]

/**
 * Payment-context events for customer navigation.
 * Includes invoice_created because customers have no separate invoice screen —
 * both payment and invoice events are surfaced under the project payment section.
 */
const CUSTOMER_PAYMENT_TYPES: ReadonlyArray<ProjectTimelineEventType> = [
  'deposit_paid',
  'escrow_locked',
  'release_requested',
  'payment_released',
  'payment_refunded',
  'waiting_payment',
  'invoice_created',
]

/**
 * Returns a navigation target for a craftsman-context timeline event.
 *
 * Called from surfaces like JobTimelineCard (inside a job detail screen) where
 * dispute/invoice/schedule entries should link to their dedicated screens rather
 * than staying on the current page.  Returns null for events that have no
 * meaningful cross-screen destination.
 */
export function getCraftsmanTimelineNavTarget(
  event: ProjectTimelineEvent
): TimelineNavTarget | null {
  const { type } = event

  if ((DISPUTE_TYPES as ReadonlyArray<string>).includes(type)) {
    return { path: '/craftsman/disputes', label: 'Zum Streitfall →' }
  }

  if ((INVOICE_TYPES as ReadonlyArray<string>).includes(type)) {
    return { path: '/craftsman/invoices', label: 'Zur Rechnung →' }
  }

  if ((SCHEDULE_TYPES as ReadonlyArray<string>).includes(type)) {
    return { path: '/craftsman/operations', label: 'Zum Zeitplan →' }
  }

  return null
}

/**
 * Returns a navigation target pointing to a specific job detail screen.
 * Useful when showing a timeline event outside its direct job-detail context
 * (e.g. in a feed, notification list, or dashboard).
 */
export function getCraftsmanJobNavTarget(
  event: ProjectTimelineEvent
): TimelineNavTarget {
  return {
    path: `/craftsman/jobs/${event.jobId}`,
    label: 'Auftrag ansehen →',
  }
}

/**
 * Returns a navigation target for a customer-context timeline event.
 * Passes the projectId so we can construct a link back to the relevant
 * project detail page when the event is shown outside that context.
 * Returns null when no meaningful destination exists.
 */
export function getCustomerTimelineNavTarget(
  event: ProjectTimelineEvent,
  projectId: string
): TimelineNavTarget | null {
  const { type } = event

  if ((DISPUTE_TYPES as ReadonlyArray<string>).includes(type)) {
    return { path: `/projects/${projectId}`, label: 'Streitfall ansehen →' }
  }

  if ((CUSTOMER_PAYMENT_TYPES as ReadonlyArray<string>).includes(type)) {
    return { path: `/projects/${projectId}`, label: 'Zahlung ansehen →' }
  }

  return null
}
