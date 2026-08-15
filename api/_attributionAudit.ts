/**
 * Attribution Audit-Log writer.
 *
 * Single entry point for inserts into `public.attribution_audit_log`.  Used by:
 *   - api/cron/finalize-attribution.ts (Stage 3) for finalize / retry / DLQ
 *   - api/operator/resolve-attribution  (Stage 4) for operator transitions
 *
 * Non-fatal: audit-write failures are logged but never block the calling
 * workflow.  The primary state transition on `jobs` is the source of truth;
 * the audit log is a forensic supplement.  Losing a single audit row is
 * acceptable; losing a jobs state transition is not.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logWarning } from './_observability.js'

export type AttributionAuditEvent =
  | 'finalize_auto'
  | 'finalize_absent'
  | 'retry_incremented'
  | 'dlq_entered'
  | 'operator_resolve'
  | 'operator_reclassify'

export interface AttributionAuditInput {
  jobId: string
  eventType: AttributionAuditEvent
  fromStatus?: string | null
  toStatus?: string | null
  fromOrigin?: string | null
  toOrigin?: string | null
  retryCount?: number | null
  reason?: string | null
  operatorId?: string | null
  metadata?: Record<string, unknown> | null
}

export async function writeAttributionAudit(
  supabase: SupabaseClient,
  input: AttributionAuditInput,
): Promise<void> {
  const { error } = await supabase.from('attribution_audit_log').insert({
    job_id: input.jobId,
    event_type: input.eventType,
    from_status: input.fromStatus ?? null,
    to_status: input.toStatus ?? null,
    from_origin: input.fromOrigin ?? null,
    to_origin: input.toOrigin ?? null,
    retry_count: input.retryCount ?? null,
    reason: input.reason ?? null,
    operator_id: input.operatorId ?? null,
    metadata: input.metadata ?? null,
  })

  if (error) {
    logWarning('attribution_audit_log.write_failed', {
      jobId: input.jobId,
      eventType: input.eventType,
      error: error.message,
    })
  }
}
