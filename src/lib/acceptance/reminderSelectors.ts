/**
 * Pure selectors for the acceptance-reminder cron (Block 7.2.1e).
 *
 * The customer has 72 hours to confirm completed work after the owner
 * confirms it. To reduce silent expirations, the system pushes two
 * customer-targeted reminders during the window:
 *
 *   - `customer_24h`  — once `now >= createdAt + 24h`
 *   - `customer_60h`  — once `now >= createdAt + 60h`
 *
 * Both are gated by `acceptance.remindersSent` (idempotency JSONB), the
 * acceptance status, and the deadline. After the deadline, no further
 * customer reminder fires — the auto-release cron takes over.
 *
 * This module is consumed by `api/_acceptanceReminder.ts` (server-side
 * cron handler). It must stay free of supabase / fetch / any IO so the
 * branches are deterministically testable.
 */
import type { Acceptance } from './types.js'

export const REMINDER_OFFSET_24H_MS = 24 * 60 * 60 * 1000
export const REMINDER_OFFSET_60H_MS = 60 * 60 * 60 * 1000

export type DueReminders = {
  customer_24h: boolean
  customer_60h: boolean
}

const NO_REMINDERS: DueReminders = {
  customer_24h: false,
  customer_60h: false,
}

/**
 * Returns which customer reminders are currently due for the given
 * acceptance, according to the contract above. A reminder is "due" iff:
 *
 *   - the acceptance is still `pending`
 *   - `now < expiresAt` (deadline has not lapsed)
 *   - the cumulative time since creation has crossed the threshold
 *   - the corresponding `remindersSent` flag is not already true
 */
export function deriveDueReminders(
  acceptance: Pick<Acceptance, 'status' | 'createdAt' | 'expiresAt' | 'remindersSent'>,
  now: number,
): DueReminders {
  if (acceptance.status !== 'pending') return NO_REMINDERS
  if (acceptance.expiresAt == null) return NO_REMINDERS
  if (now >= acceptance.expiresAt) return NO_REMINDERS

  const elapsed = now - acceptance.createdAt
  if (elapsed < REMINDER_OFFSET_24H_MS) return NO_REMINDERS

  const sent = acceptance.remindersSent ?? {}

  return {
    customer_24h:
      elapsed >= REMINDER_OFFSET_24H_MS && sent.customer_24h !== true,
    customer_60h:
      elapsed >= REMINDER_OFFSET_60H_MS && sent.customer_60h !== true,
  }
}
