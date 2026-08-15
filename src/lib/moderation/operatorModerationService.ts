import { supabase } from '../supabase'
import type {
  UserReport,
  ReportStatus,
  EnforceReportParams,
  EnforcementResult,
} from './types'

/**
 * Fetches all reports with status 'pending' or 'reviewed' for operator review.
 */
export async function getOpenReports(): Promise<UserReport[]> {
  const { data, error } = await supabase
    .from('user_reports')
    .select('*')
    .in('status', ['pending', 'reviewed'])
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  if (!data) return []

  return data.map(mapReportRow)
}

/**
 * Fetches all reports regardless of status, for the full moderation history.
 */
export async function getAllReports(): Promise<UserReport[]> {
  const { data, error } = await supabase
    .from('user_reports')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw new Error(error.message)
  if (!data) return []

  return data.map(mapReportRow)
}

/**
 * Update a report's status with optional operator notes.
 */
export async function resolveReport(
  reportId: string,
  status: ReportStatus,
  notes?: string,
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Nicht angemeldet.')

  const { error } = await supabase
    .from('user_reports')
    .update({
      status,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      operator_notes: notes ?? null,
    })
    .eq('id', reportId)

  if (error) throw new Error(error.message)
}

/**
 * Applies an enforcement action to a report via the `operator_enforce_report`
 * RPC. The RPC is the single authoritative path: it gates on `is_operator`,
 * mutates the target's moderation state (suspend/ban), optionally hides a
 * message (hide_content), and transitions the report to 'actioned'/'dismissed'.
 *
 * Surfaces any RPC error (auth, validation, or — until the migration is
 * applied — the missing-function error) as a thrown Error.
 */
export async function enforceReport(
  params: EnforceReportParams,
): Promise<EnforcementResult> {
  const { data, error } = await supabase.rpc('operator_enforce_report', {
    p_action: params.action,
    p_report_id: params.reportId,
    p_target_user_id: params.targetUserId,
    p_notes: params.notes ?? null,
    p_suspend_hours: params.suspendHours ?? null,
    p_target_message_id: params.targetMessageId ?? null,
  })

  if (error) throw new Error(error.message)

  const result = (data ?? {}) as Record<string, unknown>
  return {
    ok: (result.ok as boolean) ?? false,
    action: result.action as EnforcementResult['action'],
    reportStatus: (result.report_status as string) ?? '',
    expiresAt: (result.expires_at as string) ?? null,
  }
}

/**
 * Returns counts by status for the operator dashboard badge.
 */
export async function getReportStats(): Promise<Record<ReportStatus, number>> {
  const { data, error } = await supabase
    .from('user_reports')
    .select('status')

  if (error || !data) {
    return { pending: 0, reviewed: 0, resolved: 0, dismissed: 0, actioned: 0 }
  }

  const counts: Record<ReportStatus, number> = {
    pending: 0,
    reviewed: 0,
    resolved: 0,
    dismissed: 0,
    actioned: 0,
  }

  for (const row of data as { status: ReportStatus }[]) {
    if (row.status in counts) counts[row.status]++
  }

  return counts
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapReportRow(row: Record<string, unknown>): UserReport {
  return {
    id: row.id as string,
    reporterId: row.reporter_id as string,
    reportedUserId: row.reported_id as string,
    reason: row.reason as UserReport['reason'],
    context: (row.details as string) ?? null,
    contextType: (row.context_type as string) ?? null,
    contextId: (row.context_id as string) ?? null,
    status: (row.status as ReportStatus) ?? 'pending',
    resolvedBy: (row.reviewed_by as string) ?? null,
    resolvedAt: (row.reviewed_at as string) ?? null,
    operatorNotes: (row.operator_notes as string) ?? null,
    createdAt: row.created_at as string,
  }
}
