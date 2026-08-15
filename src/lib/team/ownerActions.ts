/**
 * Owner-side team_member management actions.
 *
 * All writes go through SECURITY DEFINER RPCs introduced in
 * 20260503000002_team_member_management.sql. The RPCs enforce:
 *   - RBAC (caller must be owner of the member's provider)
 *   - self-edit guard (owner cannot edit/deactivate own row)
 *   - owner-immutability ('owner' role rows untouchable here)
 *   - append-only audit row on every success
 *
 * After a successful RPC the local team cache is stale; callers should
 * refresh via `retryTeamMembersHydration(true)` (or this module triggers
 * the refresh automatically — see implementation).
 */

import { supabase } from '../supabase'
import { retryTeamMembersHydration } from './teamStore'

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type TeamMemberMutationResult =
  | { ok: true; noop?: boolean }
  | {
      ok: false
      error: string
      code:
        | 'unauthenticated'
        | 'rbac_owner_required'
        | 'self_edit_forbidden'
        | 'owner_immutable'
        | 'invalid_name'
        | 'invalid_role'
        | 'invalid_hours'
        | 'email_exists'
        | 'not_found'
        | 'unknown'
    }

export type TeamMemberCreateResult =
  | { ok: true; memberId: string }
  | {
      ok: false
      error: string
      code:
        | 'unauthenticated'
        | 'rbac_owner_required'
        | 'invalid_name'
        | 'invalid_role'
        | 'invalid_hours'
        | 'email_exists'
        | 'unknown'
    }

export type TeamMemberDetail = {
  id: string
  providerId: string
  profileId: string | null
  fullName: string
  role: string
  isActive: boolean
  phone: string | null
  email: string | null
  avatarUrl: string | null
  weeklyTargetHours: number | null
  dailyTargetHours: number | null
  createdAt: string
  updatedAt: string
}

export type TeamMemberUpdateInput = {
  fullName: string
  role: string
  phone: string | null
  email: string | null
  weeklyTargetHours: number | null
  dailyTargetHours: number | null
}

export type TeamMemberCreateInput = TeamMemberUpdateInput

export type TeamMemberAuditEntry = {
  id: string
  memberId: string
  actorId: string
  action: 'update' | 'deactivate' | 'reactivate'
  oldValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMutationResponse(data: unknown, fallbackError: string): TeamMemberMutationResult {
  const result = data as
    | { ok?: boolean; error?: string; code?: string; noop?: boolean }
    | null

  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, error: fallbackError, code: 'unknown' }
  }

  if (result.ok) {
    return result.noop ? { ok: true, noop: true } : { ok: true }
  }

  const code = (result.code ?? 'unknown') as TeamMemberMutationResult extends {
    ok: false
    code: infer C
  }
    ? C
    : never

  return { ok: false, error: result.error ?? fallbackError, code }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function updateTeamMember(
  memberId: string,
  input: TeamMemberUpdateInput,
): Promise<TeamMemberMutationResult> {
  const { data, error } = await supabase.rpc('update_team_member', {
    p_member_id:           memberId,
    p_full_name:           input.fullName,
    p_role:                input.role,
    p_phone:               input.phone,
    p_email:               input.email,
    p_weekly_target_hours: input.weeklyTargetHours,
    p_daily_target_hours:  input.dailyTargetHours,
  })

  if (error) {
    return { ok: false, error: 'Aktualisierung fehlgeschlagen.', code: 'unknown' }
  }

  const parsed = parseMutationResponse(data, 'Aktualisierung fehlgeschlagen.')
  if (parsed.ok) retryTeamMembersHydration()
  return parsed
}

export async function createTeamMemberStub(
  providerId: string,
  input: TeamMemberCreateInput,
): Promise<TeamMemberCreateResult> {
  const { data, error } = await supabase.rpc('create_team_member_stub', {
    p_provider_id:         providerId,
    p_full_name:           input.fullName,
    p_role:                input.role,
    p_phone:               input.phone,
    p_email:               input.email,
    p_weekly_target_hours: input.weeklyTargetHours,
    p_daily_target_hours:  input.dailyTargetHours,
  })

  if (error) {
    return { ok: false, error: 'Anlegen fehlgeschlagen.', code: 'unknown' }
  }

  const result = data as
    | { ok?: boolean; error?: string; code?: string; member_id?: string }
    | null

  if (!result || typeof result.ok !== 'boolean') {
    return { ok: false, error: 'Anlegen fehlgeschlagen.', code: 'unknown' }
  }

  if (result.ok && typeof result.member_id === 'string') {
    retryTeamMembersHydration()
    return { ok: true, memberId: result.member_id }
  }

  const code = (result.code ?? 'unknown') as TeamMemberCreateResult extends {
    ok: false
    code: infer C
  }
    ? C
    : never

  return { ok: false, error: result.error ?? 'Anlegen fehlgeschlagen.', code }
}

export async function deactivateTeamMember(
  memberId: string,
): Promise<TeamMemberMutationResult> {
  const { data, error } = await supabase.rpc('deactivate_team_member', {
    p_member_id: memberId,
  })

  if (error) {
    return { ok: false, error: 'Deaktivierung fehlgeschlagen.', code: 'unknown' }
  }

  const parsed = parseMutationResponse(data, 'Deaktivierung fehlgeschlagen.')
  if (parsed.ok) retryTeamMembersHydration()
  return parsed
}

export async function reactivateTeamMember(
  memberId: string,
): Promise<TeamMemberMutationResult> {
  const { data, error } = await supabase.rpc('reactivate_team_member', {
    p_member_id: memberId,
  })

  if (error) {
    return { ok: false, error: 'Reaktivierung fehlgeschlagen.', code: 'unknown' }
  }

  const parsed = parseMutationResponse(data, 'Reaktivierung fehlgeschlagen.')
  if (parsed.ok) retryTeamMembersHydration()
  return parsed
}

// ---------------------------------------------------------------------------
// Detail read — used by the member-detail screen
// ---------------------------------------------------------------------------
// Owner-only. Existing owner-scoped RLS on team_members covers the SELECT
// (owners can read all rows for their provider).
// ---------------------------------------------------------------------------

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function getTeamMemberDetail(
  memberId: string,
): Promise<TeamMemberDetail | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select(
      'id, provider_id, profile_id, full_name, role, is_active, phone, email, avatar_url, weekly_target_hours, daily_target_hours, created_at, updated_at',
    )
    .eq('id', memberId)
    .maybeSingle()

  if (error || !data) return null

  return {
    id:        data.id as string,
    providerId: data.provider_id as string,
    profileId: (data.profile_id as string | null) ?? null,
    fullName:  (data.full_name as string) ?? '',
    role:      (data.role as string) ?? '',
    isActive:  Boolean(data.is_active),
    phone:     (data.phone as string | null) ?? null,
    email:     (data.email as string | null) ?? null,
    avatarUrl: (data.avatar_url as string | null) ?? null,
    weeklyTargetHours: toNumberOrNull(
      data.weekly_target_hours as number | string | null | undefined,
    ),
    dailyTargetHours: toNumberOrNull(
      data.daily_target_hours as number | string | null | undefined,
    ),
    createdAt: (data.created_at as string) ?? '',
    updatedAt: (data.updated_at as string) ?? '',
  }
}

export async function getTeamMemberAuditLog(
  memberId: string,
  limit = 50,
): Promise<TeamMemberAuditEntry[]> {
  const { data, error } = await supabase
    .from('team_member_audit')
    .select('id, member_id, actor_id, action, old_values, new_values, created_at')
    .eq('member_id', memberId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error || !data) return []

  return (data as Array<{
    id: string
    member_id: string
    actor_id: string
    action: string
    old_values: Record<string, unknown> | null
    new_values: Record<string, unknown> | null
    created_at: string
  }>).map((row) => ({
    id:         row.id,
    memberId:   row.member_id,
    actorId:    row.actor_id,
    action:     row.action as TeamMemberAuditEntry['action'],
    oldValues:  row.old_values,
    newValues:  row.new_values,
    createdAt:  row.created_at,
  }))
}
