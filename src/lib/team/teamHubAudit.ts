import { supabase } from '../supabase'
import { logError } from '../observability'

export type TeamHubAuditEntry =
  | {
      kind: 'code_rotation'
      id: string
      createdAt: string
      reason: string | null
    }
  | {
      kind: 'member_action'
      id: string
      createdAt: string
      memberId: string
      action: 'update' | 'deactivate' | 'reactivate'
      oldValues: Record<string, unknown> | null
      newValues: Record<string, unknown> | null
    }

type CodeAuditRow = {
  id: string
  rotated_at: string
  reason: string | null
}

type MemberAuditRow = {
  id: string
  member_id: string
  action: string
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown> | null
  created_at: string
}

const KNOWN_ACTIONS = new Set(['update', 'deactivate', 'reactivate'])

export async function listTeamHubAudit(
  providerId: string,
  limit = 10,
): Promise<TeamHubAuditEntry[]> {
  if (!providerId) return []

  const [codeRes, memberRes] = await Promise.all([
    supabase
      .from('company_code_audit')
      .select('id, rotated_at, reason')
      .eq('provider_id', providerId)
      .order('rotated_at', { ascending: false })
      .limit(limit),
    supabase
      .from('team_member_audit')
      .select('id, member_id, action, old_values, new_values, created_at')
      .eq('provider_id', providerId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ])

  if (codeRes.error) {
    logError('teamHubAudit.code_audit_failed', codeRes.error)
  }
  if (memberRes.error) {
    logError('teamHubAudit.member_audit_failed', memberRes.error)
  }

  const codeRows = (codeRes.data as CodeAuditRow[] | null) ?? []
  const memberRows = (memberRes.data as MemberAuditRow[] | null) ?? []

  const codeEntries: TeamHubAuditEntry[] = codeRows.map((row) => ({
    kind: 'code_rotation',
    id: row.id,
    createdAt: row.rotated_at,
    reason: row.reason ?? null,
  }))

  const memberEntries: TeamHubAuditEntry[] = memberRows
    .filter((row) => KNOWN_ACTIONS.has(row.action))
    .map((row) => ({
      kind: 'member_action',
      id: row.id,
      createdAt: row.created_at,
      memberId: row.member_id,
      action: row.action as 'update' | 'deactivate' | 'reactivate',
      oldValues: row.old_values,
      newValues: row.new_values,
    }))

  return [...codeEntries, ...memberEntries]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit)
}
