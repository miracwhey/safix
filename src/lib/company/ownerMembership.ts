/**
 * Owner membership creation.
 *
 * Creates the owner's team_members row for their company.
 * Called from CraftsmanOnboardingProfileScreen after updateProviderProfile()
 * succeeds, using the same best-effort pattern as upsertCraftsmanBusinessProfile.
 *
 * For existing owners (who completed onboarding before this migration was
 * applied), the SQL backfill in 20260408000001_company_join_codes.sql
 * creates their row at migration time — this function is redundant for
 * them but still safe (the unique partial index + ON CONFLICT guard makes
 * it idempotent).
 */

import { supabase } from '../supabase'

// ---------------------------------------------------------------------------
// ensureOwnerTeamMembership
// ---------------------------------------------------------------------------
// Inserts a team_members row linking the owner to their provider.
// The unique partial index idx_team_members_provider_profile_unique ensures
// that a second call for the same (provider, user) pair is silently ignored
// (error.code 23505 = unique_violation).
// ---------------------------------------------------------------------------

export async function ensureOwnerTeamMembership(
  userId: string,
  providerId: string,
  displayName: string,
): Promise<void> {
  const { error } = await supabase.from('team_members').insert({
    provider_id: providerId,
    profile_id: userId,
    full_name: displayName.trim() || 'Inhaber',
    role: 'owner',
    is_active: true,
  })

  // 23505 = unique_violation — row already exists, this is a no-op
  if (error && error.code !== '23505') {
    console.warn('[ensureOwnerTeamMembership] insert failed (non-blocking):', error)
  }
}
