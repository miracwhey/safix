-- PII hardening on public.profiles (found during 2026-07-06 security sweep,
-- not an advisor finding): the SELECT policy "Authenticated can read onboarded
-- profiles" (qual: onboarding_done = true) exposed ALL columns of every
-- onboarded profile to every authenticated user — including phone,
-- moderation_state and suspension_expires_at.
--
-- RLS cannot filter columns, so we use column-level grants: revoke table-wide
-- SELECT, grant back everything except phone / moderation_state /
-- suspension_expires_at.
--
-- Verified client usage (src/, api/, supabase/functions/):
--   * profiles.phone is read/written nowhere client-side (craftsman "phone"
--     lives on craftsman_profiles / team_members / providers).
--   * moderation_state / suspension_expires_at: no client reads.
--   * is_operator stays granted — profile.ts reads it for the own-profile
--     operator gate; RLS policies reference only profiles.id / is_operator.
--   * All client updates use return=minimal (no .select() after .update()),
--     so RETURNING needs no extra SELECT columns.
--   * anon gets no grant back: no anon read path exists ("Users can read own
--     profile" matches zero rows for anon anyway).
-- api/ and Edge Functions use service_role — untouched.

revoke select on table public.profiles from anon, authenticated;

grant select (
  id,
  created_at,
  role,
  display_name,
  onboarding_done,
  craftsman_role,
  is_operator,
  guided_entry_state,
  tos_accepted_at,
  timezone,
  provider_terms_accepted_at,
  handle,
  handle_changed_at,
  discoverable,
  dm_privacy
) on table public.profiles to authenticated;
