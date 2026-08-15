/**
 * Server-side acceptance-reminder logic (Block 7.2.1e).
 *
 * The customer has a 72-hour window to confirm completed work after the owner
 * confirms it. Without this cron a customer can sleep through the window and
 * the system silently auto-releases — `auto-release-acceptance` already
 * handles the financial side, but the customer has no signal that the
 * deadline is approaching.
 *
 * This cron pushes two customer-targeted reminders during the window:
 *
 *   - `acceptance_reminder_24h` — once 24h after acceptance creation
 *   - `acceptance_reminder_60h` — once 60h after acceptance creation
 *
 * Idempotency lives in `acceptances.reminders_sent` (JSONB, see
 * migration `20260501000004_acceptance_reminders.sql`). A reminder is
 * marked sent only after a successful `notification_signals` insert, so a
 * Supabase-write failure simply retries on the next 15-minute tick.
 *
 * Concurrency safety:
 *   - Two cron pods running at the same instant could both insert the same
 *     reminder. Each insert uses a deterministic id (`reminder-<acc>-<key>`)
 *     so the second insert hits the PRIMARY KEY uniqueness — counted as
 *     "already sent" and not as a failure.
 *   - The `reminders_sent` UPDATE uses optimistic-write semantics: if the
 *     row state changed between SELECT and UPDATE (status flipped), the
 *     UPDATE no-ops, the next tick re-derives.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

import { logInfo, logWarning, logError } from './_observability.js'
import { deriveDueReminders } from '../src/lib/acceptance/reminderSelectors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReminderSummary = {
  /** Acceptances inspected by the cron tick */
  checked: number
  /** Customer 24h reminders successfully written */
  sent24h: number
  /** Customer 60h reminders successfully written */
  sent60h: number
  /** Rows skipped because no reminder was due */
  skippedNoneDue: number
  /** Insert / update failures (will retry on next tick) */
  failed: number
}

interface AcceptanceRow {
  id: string
  job_id: string
  customer_user_id: string | null
  status: string
  expires_at: number | null
  created_at: number
  reminders_sent: Record<string, boolean> | null
}

const BATCH_LIMIT = 100

// Window of acceptances the cron looks at, expressed via `expires_at` so the
// existing `idx_acceptances_pending_expires` partial index (status='pending'
// AND expires_at IS NOT NULL) serves the query directly.
//
//   - upper bound  expires_at <= now + 48h
//     A pending acceptance whose deadline is at most 48h away has already
//     crossed the +24h reminder threshold (deadline is 72h from creation).
//   - lower bound  expires_at >= now - 1h
//     The auto-release cron handles the post-deadline tail; we still want a
//     small slack window so a tick that fires a few minutes late after the
//     60h mark still sees the row.
const REMINDER_QUERY_LOOKAHEAD_MS = 48 * 60 * 60 * 1000
const REMINDER_QUERY_LOOKBACK_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function processAcceptanceReminders(
  supabase: SupabaseClient,
  now: number,
): Promise<ReminderSummary> {
  const summary: ReminderSummary = {
    checked: 0,
    sent24h: 0,
    sent60h: 0,
    skippedNoneDue: 0,
    failed: 0,
  }

  // ── 1. Window query ───────────────────────────────────────────────────
  // Pending rows whose deadline is in the [now - 1h, now + 48h] window. The
  // upper bound covers the +24h reminder threshold (deadline = createdAt +
  // 72h, so an acceptance at +24h has expires_at = now + 48h). The lower
  // bound gives a small slack tail; auto-release handles anything past
  // deadline. Hits `idx_acceptances_pending_expires` directly.
  const { data, error } = await supabase
    .from('acceptances')
    .select('id, job_id, customer_user_id, status, expires_at, created_at, reminders_sent')
    .eq('status', 'pending')
    .gte('expires_at', now - REMINDER_QUERY_LOOKBACK_MS)
    .lte('expires_at', now + REMINDER_QUERY_LOOKAHEAD_MS)
    .limit(BATCH_LIMIT)

  if (error) {
    logError('acceptance_reminder.fetch_failed', error)
    throw new Error(`Failed to query pending acceptances: ${error.message}`)
  }

  const rows = (data ?? []) as AcceptanceRow[]
  summary.checked = rows.length

  if (rows.length === 0) {
    logInfo('acceptance_reminder.none_due', { checked: 0 })
    return summary
  }

  // ── 2. Per-row derive + send ──────────────────────────────────────────
  for (const row of rows) {
    try {
      const due = deriveDueReminders(
        {
          status: row.status as 'pending' | 'accepted' | 'disputed',
          createdAt: row.created_at,
          expiresAt: row.expires_at ?? undefined,
          remindersSent: row.reminders_sent ?? {},
        },
        now,
      )

      if (!due.customer_24h && !due.customer_60h) {
        summary.skippedNoneDue++
        continue
      }

      const nextRemindersSent: Record<string, boolean> = {
        ...(row.reminders_sent ?? {}),
      }

      if (due.customer_24h) {
        const ok = await emitReminderSignal(supabase, {
          acceptanceId: row.id,
          jobId: row.job_id,
          type: 'acceptance_reminder_24h',
          priority: 'action',
          recipientRole: 'customer',
          occurredAt: now,
        })
        if (ok) {
          nextRemindersSent.customer_24h = true
          summary.sent24h++
        } else {
          summary.failed++
        }
      }

      if (due.customer_60h) {
        const ok = await emitReminderSignal(supabase, {
          acceptanceId: row.id,
          jobId: row.job_id,
          type: 'acceptance_reminder_60h',
          priority: 'action',
          recipientRole: 'customer',
          occurredAt: now,
        })
        if (ok) {
          nextRemindersSent.customer_60h = true
          summary.sent60h++
        } else {
          summary.failed++
        }
      }

      const sentSomething =
        nextRemindersSent.customer_24h !== row.reminders_sent?.customer_24h ||
        nextRemindersSent.customer_60h !== row.reminders_sent?.customer_60h

      if (sentSomething) {
        const { error: updateError } = await supabase
          .from('acceptances')
          .update({
            reminders_sent: nextRemindersSent,
            updated_at: now,
          })
          .eq('id', row.id)
          .eq('status', 'pending')

        if (updateError) {
          logWarning('acceptance_reminder.flag_persist_failed', {
            acceptanceId: row.id,
            error: updateError.message,
          })
          // Not counted as failed — the signal already landed; flag will
          // retry next tick. The PRIMARY-KEY guard on signals prevents
          // duplicate pushes.
        }
      }
    } catch (err) {
      logError(
        'acceptance_reminder.row_failed',
        err instanceof Error ? err : undefined,
        { acceptanceId: row.id, jobId: row.job_id },
      )
      summary.failed++
    }
  }

  logInfo('acceptance_reminder.completed', summary)
  return summary
}

// ---------------------------------------------------------------------------
// Signal insert
// ---------------------------------------------------------------------------

type ReminderSignalParams = {
  acceptanceId: string
  jobId: string
  type:
    | 'acceptance_reminder_24h'
    | 'acceptance_reminder_60h'
    | 'acceptance_customer_released'
    | 'acceptance_auto_released'
  priority: 'info' | 'action' | 'alert'
  recipientRole: 'customer' | 'craftsman'
  occurredAt: number
}

async function emitReminderSignal(
  supabase: SupabaseClient,
  params: ReminderSignalParams,
): Promise<boolean> {
  // Deterministic id: a duplicate insert from a parallel cron pod hits the
  // PK and is treated as "already sent" rather than a write failure.
  const id = `reminder-${params.acceptanceId}-${params.type}`

  const { error } = await supabase.from('notification_signals').insert({
    id,
    job_id: params.jobId,
    type: params.type,
    priority: params.priority,
    read: false,
    occurred_at: params.occurredAt,
    recipient_role: params.recipientRole,
  })

  if (error) {
    if (isDuplicatePrimaryKey(error)) {
      logInfo('acceptance_reminder.signal_already_present', {
        acceptanceId: params.acceptanceId,
        type: params.type,
      })
      return true
    }
    logWarning('acceptance_reminder.signal_insert_failed', {
      acceptanceId: params.acceptanceId,
      type: params.type,
      error: error.message,
    })
    return false
  }

  return true
}

/**
 * Server-side helper that inserts the craftsman-targeted
 * `acceptance_auto_released` signal after the auto-release cron releases a
 * tranche. Mirrors {@link emitReminderSignal} but is exported so
 * {@link autoReleaseExpiredAcceptances} can call it without re-implementing
 * the duplicate-key handling.
 */
export async function emitAutoReleasedSignal(
  supabase: SupabaseClient,
  params: { acceptanceId: string; jobId: string; occurredAt: number },
): Promise<boolean> {
  return emitReminderSignal(supabase, {
    acceptanceId: params.acceptanceId,
    jobId: params.jobId,
    type: 'acceptance_auto_released',
    priority: 'info',
    recipientRole: 'craftsman',
    occurredAt: params.occurredAt,
  })
}

function isDuplicatePrimaryKey(error: { code?: string; message?: string }): boolean {
  if (error.code === '23505') return true
  return typeof error.message === 'string' && /duplicate key/i.test(error.message)
}
