/**
 * Server-side dispute SLA reminder logic (Block N13.SLA-Cron).
 *
 * When an operator transitions a dispute to `customer_waiting` /
 * `provider_waiting`, the addressed party has a soft 24/48/72-hour
 * window to respond. Without nudges the case can sit silently and the
 * `*_waiting` state ages indefinitely — defeating the operator's
 * arbitration cadence and the SaFix dispute SLA promise.
 *
 * This worker emits up to three customer- or craftsman-targeted
 * reminders per dispute:
 *
 *   - `dispute_sla_reminder_24h` (action)
 *   - `dispute_sla_reminder_48h` (action)
 *   - `dispute_sla_reminder_72h` (alert)
 *
 * IDEMPOTENCY
 *   `disputes.metadata.sla_reminders_sent` (jsonb dict) tracks which
 *   thresholds have already been emitted per dispute. A successful
 *   `notification_signals` insert is followed by a metadata update;
 *   if the metadata update fails (transient Postgres error) the next
 *   tick re-derives — duplicate signals are blocked at the PRIMARY KEY
 *   layer because the signal id is a deterministic UUID v5 keyed by
 *   `(disputeId, threshold)`.
 *
 * RESET POLICY
 *   The operator-side `request_evidence` workflow is responsible for
 *   clearing `metadata.sla_reminders_sent` when re-arming the dispute
 *   (status flips back to `*_waiting` for a second round). That clear
 *   is out of scope here — the worker only writes; never resets.
 *
 * CONCURRENCY
 *   Two cron pods can fire simultaneously. The deterministic UUID v5
 *   makes the second insert hit the PK and return success without
 *   double-emit. The `metadata.sla_reminders_sent` UPDATE is
 *   guarded by an optimistic `eq('id', dispute.id).eq('status',
 *   waitingStatus)` so a status flip between SELECT and UPDATE
 *   no-ops the bookkeeping (next tick re-derives).
 */

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

import { logInfo, logWarning, logError } from './_observability.js'
import {
  deriveDueDisputeSlaReminders,
  DISPUTE_SLA_REMINDER_PRIORITY,
  DISPUTE_SLA_REMINDER_TYPE,
  SLA_THRESHOLDS_MS,
  type DisputeSlaThreshold,
  type DisputeSlaRemindersSent,
} from '../src/lib/disputes/slaReminderSelectors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DisputeSlaReminderSummary = {
  /** Disputes inspected by this tick. */
  checked: number
  /** Reminders successfully written, by threshold. */
  sent24h: number
  sent48h: number
  sent72h: number
  /** Disputes where every applicable threshold had already been sent. */
  skippedNoneDue: number
  /** Insert / update failures (will retry next tick). */
  failed: number
}

interface DisputeRow {
  id: string
  job_id: string
  status: string
  updated_at: string
  metadata: Record<string, unknown> | null
}

const BATCH_LIMIT = 100

// Deterministic namespace for SLA reminder UUIDs. Arbitrary but fixed
// — never change once shipped, or duplicates will leak into
// `notification_signals` for in-flight disputes.
const SLA_UUID_NAMESPACE = '6d8c9f4e-3a12-4e7b-9c5d-1a2b3c4d5e6f'

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function processDisputeSlaReminders(
  supabase: SupabaseClient,
  now: number,
): Promise<DisputeSlaReminderSummary> {
  const summary: DisputeSlaReminderSummary = {
    checked: 0,
    sent24h: 0,
    sent48h: 0,
    sent72h: 0,
    skippedNoneDue: 0,
    failed: 0,
  }

  // Window query: only `*_waiting` disputes whose `updated_at` is at
  // least 24h old. Anything fresher cannot have a 24h reminder due
  // yet. Disputes already past 72h with all reminders sent are
  // filtered later via the deriving step.
  const cutoffIso = new Date(now - SLA_THRESHOLDS_MS.h24).toISOString()

  const { data, error } = await supabase
    .from('disputes')
    .select('id, job_id, status, updated_at, metadata')
    .in('status', ['customer_waiting', 'provider_waiting'])
    .lte('updated_at', cutoffIso)
    .limit(BATCH_LIMIT)

  if (error) {
    logError('dispute_sla_reminder.fetch_failed', error)
    throw new Error(`Failed to query *_waiting disputes: ${error.message}`)
  }

  const rows = (data ?? []) as DisputeRow[]
  summary.checked = rows.length

  if (rows.length === 0) {
    logInfo('dispute_sla_reminder.none_due', { checked: 0 })
    return summary
  }

  for (const row of rows) {
    try {
      const remindersSent = readRemindersSent(row.metadata)
      const waitingSinceMs = Date.parse(row.updated_at)
      if (!Number.isFinite(waitingSinceMs)) {
        logWarning('dispute_sla_reminder.bad_updated_at', {
          disputeId: row.id,
          updatedAt: row.updated_at,
        })
        summary.failed++
        continue
      }

      const due = deriveDueDisputeSlaReminders(
        {
          status: row.status,
          waitingSinceMs,
          remindersSent,
        },
        now,
      )

      if (!due.h24 && !due.h48 && !due.h72) {
        summary.skippedNoneDue++
        continue
      }
      if (due.targetRole === null) {
        // status flipped between SELECT and derive — skip.
        summary.skippedNoneDue++
        continue
      }

      const nextSent: DisputeSlaRemindersSent = { ...remindersSent }

      const thresholds: DisputeSlaThreshold[] = []
      if (due.h24) thresholds.push('h24')
      if (due.h48) thresholds.push('h48')
      if (due.h72) thresholds.push('h72')

      for (const threshold of thresholds) {
        const ok = await emitSlaSignal(supabase, {
          disputeId: row.id,
          jobId: row.job_id,
          threshold,
          recipientRole: due.targetRole,
          occurredAt: now,
        })
        if (ok) {
          nextSent[threshold] = true
          if (threshold === 'h24') summary.sent24h++
          if (threshold === 'h48') summary.sent48h++
          if (threshold === 'h72') summary.sent72h++
        } else {
          summary.failed++
        }
      }

      // Persist the new sent-flags into disputes.metadata. Optimistic
      // write: if the dispute status changed in the meantime (operator
      // resolved / customer responded), the eq('status', waiting)
      // filter no-ops the UPDATE — next tick re-derives, signals are
      // already inserted (deterministic UUID guards against duplicates).
      const sentSomething =
        thresholds.some((t) => remindersSent[t] !== nextSent[t])

      if (sentSomething) {
        const nextMetadata = {
          ...((row.metadata ?? {}) as Record<string, unknown>),
          sla_reminders_sent: nextSent,
        }
        const { error: updateError } = await supabase
          .from('disputes')
          .update({
            metadata: nextMetadata,
            updated_at: new Date(now).toISOString(),
          })
          .eq('id', row.id)
          .eq('status', row.status)

        if (updateError) {
          logWarning('dispute_sla_reminder.flag_persist_failed', {
            disputeId: row.id,
            error: updateError.message,
          })
          // Not counted as failed — signal already landed. The next
          // tick will re-attempt the persist; the deterministic-UUID
          // PK guard prevents duplicate notifications.
        }
      }
    } catch (err) {
      logError(
        'dispute_sla_reminder.row_failed',
        err instanceof Error ? err : undefined,
        { disputeId: row.id, jobId: row.job_id },
      )
      summary.failed++
    }
  }

  logInfo('dispute_sla_reminder.completed', summary)
  return summary
}

// ---------------------------------------------------------------------------
// Signal insert
// ---------------------------------------------------------------------------

type EmitParams = {
  disputeId: string
  jobId: string
  threshold: DisputeSlaThreshold
  recipientRole: 'customer' | 'craftsman'
  occurredAt: number
}

async function emitSlaSignal(
  supabase: SupabaseClient,
  params: EmitParams,
): Promise<boolean> {
  const id = deterministicUuidV5(
    `dispute-sla:${params.disputeId}:${params.threshold}`,
    SLA_UUID_NAMESPACE,
  )

  const { error } = await supabase.from('notification_signals').insert({
    id,
    job_id: params.jobId,
    type: DISPUTE_SLA_REMINDER_TYPE[params.threshold],
    priority: DISPUTE_SLA_REMINDER_PRIORITY[params.threshold],
    read: false,
    occurred_at: params.occurredAt,
    recipient_role: params.recipientRole,
  })

  if (error) {
    if (isDuplicatePrimaryKey(error)) {
      logInfo('dispute_sla_reminder.signal_already_present', {
        disputeId: params.disputeId,
        threshold: params.threshold,
      })
      return true
    }
    logWarning('dispute_sla_reminder.signal_insert_failed', {
      disputeId: params.disputeId,
      threshold: params.threshold,
      error: error.message,
    })
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRemindersSent(
  metadata: Record<string, unknown> | null,
): DisputeSlaRemindersSent {
  if (!metadata || typeof metadata !== 'object') return {}
  const raw = (metadata as { sla_reminders_sent?: unknown })
    .sla_reminders_sent
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  return {
    h24: r.h24 === true,
    h48: r.h48 === true,
    h72: r.h72 === true,
  }
}

/**
 * Pure-Node UUID v5 (RFC 4122 §4.3) — SHA-1 over the namespace UUID's
 * raw bytes followed by the name's UTF-8 bytes, with the version + variant
 * bits flipped. Deterministic and dependency-free.
 */
export function deterministicUuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  if (nsBytes.length !== 16) {
    throw new Error(`UUID namespace must be a 16-byte hex value: ${namespace}`)
  }
  const hash = crypto.createHash('sha1').update(nsBytes).update(name).digest()
  const out = Buffer.from(hash.subarray(0, 16))
  out[6] = (out[6] & 0x0f) | 0x50 // version 5
  out[8] = (out[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = out.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

function isDuplicatePrimaryKey(error: { code?: string; message?: string }): boolean {
  if (error.code === '23505') return true
  return typeof error.message === 'string' && /duplicate key/i.test(error.message)
}
