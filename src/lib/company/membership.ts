/**
 * Worker company membership service.
 *
 * The `team_members` table is the primary truth for company-internal role.
 * This module provides the read path for workers to resolve their membership.
 *
 * Reads are gated by the RLS policy added in migration
 * 20260408000001_company_join_codes.sql:
 *   "Team members: read own profile_id" — profile_id = auth.uid()
 *
 * `full_name` and `is_active` columns were added in
 * 20260409000001_team_members_schema_fix.sql.
 */

import { supabase } from '../supabase'

export type WorkerMembership = {
  /** team_members.id — used for correction requests and assignment references */
  teamMemberId: string
  providerId: string
  /** Trade/role label from team_members.role, e.g. "Elektriker" */
  role: string
  /** Worker's display name from team_members.full_name (set during join) */
  name: string
}

// ---------------------------------------------------------------------------
// getMyWorkerMembership
// ---------------------------------------------------------------------------
// Returns the first active team_members row for the given user.
// Returns null when the worker has not yet joined a company.
//
// Only meaningful for craftsman users with craftsmanRole === 'worker'.
// The RLS policy "Team members: read own profile_id" allows this query.
// ---------------------------------------------------------------------------

export async function getMyWorkerMembership(
  userId: string,
): Promise<WorkerMembership | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, provider_id, role, full_name')
    .eq('profile_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  return {
    teamMemberId: data.id as string,
    providerId: data.provider_id as string,
    role: data.role as string,
    name: (data.full_name as string) || '',
  }
}

// ---------------------------------------------------------------------------
// leaveCompany
// ---------------------------------------------------------------------------
// Worker self-leave. Calls SECURITY DEFINER RPC `leave_company` which
// deactivates all `team_members` rows where profile_id = auth.uid() AND
// role <> 'owner'. Owner-rows are blocked server-side.
//
// On success the worker no longer satisfies the membership read in
// getMyWorkerMembership(); the UI should redirect to /onboarding/worker.
// ---------------------------------------------------------------------------

export type LeaveCompanyResult =
  | { ok: true; count: number }
  | {
      ok: false
      error: string
      code: 'unauthenticated' | 'owner_cannot_leave' | 'not_member' | 'unknown'
    }

export async function leaveCompany(): Promise<LeaveCompanyResult> {
  const { data, error } = await supabase.rpc('leave_company')

  if (error) {
    return { ok: false, error: 'Austritt fehlgeschlagen.', code: 'unknown' }
  }

  const result = data as { ok: boolean; error?: string; code?: string; count?: number } | null
  if (!result) {
    return { ok: false, error: 'Austritt fehlgeschlagen.', code: 'unknown' }
  }

  if (result.ok && typeof result.count === 'number') {
    return { ok: true, count: result.count }
  }

  const code = result.code as LeaveCompanyResult extends { code: infer C } ? C : never
  return {
    ok: false,
    error: result.error ?? 'Austritt fehlgeschlagen.',
    code: (code ?? 'unknown') as 'unauthenticated' | 'owner_cannot_leave' | 'not_member' | 'unknown',
  }
}
