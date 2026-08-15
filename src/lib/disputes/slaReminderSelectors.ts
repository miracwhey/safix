/**
 * Pure derivation of which dispute SLA reminders are due RIGHT NOW.
 *
 * Mirrors the pattern from `src/lib/acceptance/reminderSelectors.ts`.
 *
 * SEMANTICS
 * ---------
 * A dispute is in `customer_waiting` or `provider_waiting` state when an
 * operator has formally requested evidence / a statement from one side.
 * The user is on a soft 24/48/72-hour clock to respond. Without nudges
 * the case can sit for weeks unnoticed (the user only sees the inbox
 * row when they next open the app).
 *
 * The "waiting clock" is reset whenever the dispute row is mutated
 * (`disputes.updated_at`). This is intentional: every meaningful user
 * action (uploading evidence, attaching a description, an operator
 * reply, etc.) bumps `updated_at` and therefore postpones the SLA
 * reminder. A user who is uploading 5 photos over an hour does not get
 * pinged. A user who is genuinely silent does.
 *
 * THRESHOLDS (from waitingSinceMs):
 *   - 24h → `dispute_sla_reminder_24h` (action)
 *   - 48h → `dispute_sla_reminder_48h` (action)
 *   - 72h → `dispute_sla_reminder_72h` (alert — last gentle ping before
 *           the case sits indefinitely)
 *
 * TARGET ROLE:
 *   - `customer_waiting` → reminder targets `customer`
 *   - `provider_waiting` → reminder targets `craftsman`
 *
 * IDEMPOTENCY:
 *   `disputes.metadata.sla_reminders_sent` is a JSONB dict
 *   `{ h24: true, h48: true, h72: true }` (each key optional).
 *   Once a threshold has been emitted it is never emitted again, even
 *   if the dispute later transitions out of `*_waiting` and back. The
 *   operator-`request_evidence` workflow is responsible for resetting
 *   the dict (clear keys) when re-arming a side — out of scope here.
 */

export type DisputeSlaReminderRole = 'customer' | 'craftsman'

export type DisputeSlaThreshold = 'h24' | 'h48' | 'h72'

export type DisputeSlaRemindersSent = {
  h24?: boolean
  h48?: boolean
  h72?: boolean
}

export type SlaWaitingDispute = {
  status: 'customer_waiting' | 'provider_waiting' | string
  /** ms — typically `Date.parse(disputes.updated_at)`. */
  waitingSinceMs: number
  remindersSent: DisputeSlaRemindersSent
}

export type DueDisputeSlaReminders = {
  h24: boolean
  h48: boolean
  h72: boolean
  targetRole: DisputeSlaReminderRole | null
}

const HOUR_MS = 60 * 60 * 1000
export const SLA_THRESHOLDS_MS = {
  h24: 24 * HOUR_MS,
  h48: 48 * HOUR_MS,
  h72: 72 * HOUR_MS,
} as const

export function getSlaTargetRole(
  status: string,
): DisputeSlaReminderRole | null {
  if (status === 'customer_waiting') return 'customer'
  if (status === 'provider_waiting') return 'craftsman'
  return null
}

export function deriveDueDisputeSlaReminders(
  input: SlaWaitingDispute,
  nowMs: number,
): DueDisputeSlaReminders {
  const targetRole = getSlaTargetRole(input.status)
  const sent = input.remindersSent ?? {}
  const elapsed = nowMs - input.waitingSinceMs

  // No reminders unless we're actually in a *_waiting state.
  if (targetRole === null) {
    return { h24: false, h48: false, h72: false, targetRole: null }
  }

  // Negative / future "waiting since" — clock skew, edge case. Skip.
  if (elapsed < 0) {
    return { h24: false, h48: false, h72: false, targetRole }
  }

  return {
    h24: !sent.h24 && elapsed >= SLA_THRESHOLDS_MS.h24,
    h48: !sent.h48 && elapsed >= SLA_THRESHOLDS_MS.h48,
    h72: !sent.h72 && elapsed >= SLA_THRESHOLDS_MS.h72,
    targetRole,
  }
}

export const DISPUTE_SLA_REMINDER_TYPE: Record<DisputeSlaThreshold, string> = {
  h24: 'dispute_sla_reminder_24h',
  h48: 'dispute_sla_reminder_48h',
  h72: 'dispute_sla_reminder_72h',
}

export const DISPUTE_SLA_REMINDER_PRIORITY: Record<
  DisputeSlaThreshold,
  'action' | 'alert'
> = {
  h24: 'action',
  h48: 'action',
  h72: 'alert',
}
