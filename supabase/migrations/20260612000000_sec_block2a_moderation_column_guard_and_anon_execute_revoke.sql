-- ===========================================================================
-- Security hardening — Block 2a (2026-06-12 audit: H6 + A1 + escalation found in review)
--
-- APPLY HELD: run only after explicit "ja apply" (Supabase MCP apply_migration).
-- BEHAVIORAL REPRO REQUIRED before/at apply (pgTAP or real sessions): see the
-- five assertions listed at the bottom — auth/privilege code must be proven, not
-- just read.
--
-- Grounded against PROD (project itdntawwuzqfwmcwnwjr, recon 2026-06-12), NOT the
-- repo migration ledger.
--
--   H6  profiles.moderation_state / suspension_expires_at have NO write guard.
--       Prod-truth: both columns exist; pg_trigger on public.profiles is EMPTY;
--       two UPDATE policies ("Profiles: update own" {authenticated},
--       "Users can update own profile" {public}, with_check NULL) permit a user
--       to UPDATE ANY column of their own row → a banned/suspended user can reset
--       moderation_state = 'active' on themselves.
--
--   ESCALATION (surfaced by adversarial review, confirmed against prod):
--       The moderation gate is is_current_user_operator() = EXISTS(profiles
--       WHERE id=auth.uid() AND is_operator=true). profiles.is_operator is ITSELF
--       self-writable — authenticated holds TABLE-level UPDATE on profiles (a
--       column-level REVOKE(is_operator) is therefore a no-op), and the INSERT
--       policy ({public}, with_check auth.uid()=id) does not constrain column
--       values. So a non-operator could (a) on signup INSERT a profile with
--       is_operator=true, or (b) UPDATE is_operator=true then flip moderation in a
--       second request — a GLOBAL operator escalation. The trigger below therefore
--       also guards is_operator, on INSERT and UPDATE. A non-operator can never
--       bootstrap: the BEFORE trigger reads the CURRENT (pre-write) is_operator via
--       is_current_user_operator(), which is still false for them.
--
--   A1  Eight SECDEF helpers drifted to anon-EXECUTE in prod (advisor ERROR).
--       Revoke the six anon must never reach; KEEP provider_is_public and
--       get_provider_median_response_ms (anon needs them — see note).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- H6 + escalation — moderation_state / suspension_expires_at / is_operator are
-- operator-only, on INSERT and UPDATE.
--
--   Column-scoped: a normal profile write (name, avatar, onboarding, …) leaves
--   all three guarded columns at their defaults / unchanged and passes straight
--   through — only an actual privileged change is gated.
--
--   auth.uid() IS NULL = a trusted no-JWT context (service_role / postgres /
--   dashboard): operator provisioning and the SECDEF moderation RPC's owner-side
--   writes. Allowed. Anonymous PostgREST callers also have a NULL uid but are
--   already blocked by the profiles RLS policies (qual auth.uid()=id), so they
--   never reach here. Any logged-in non-operator (non-null uid,
--   is_current_user_operator() not TRUE) is rejected.
--
--   `IS NOT TRUE` (not `NOT (...)`) so a NULL gate result fails CLOSED —
--   three-valued-logic guard: `NOT NULL` is NULL and `IF NULL THEN` would skip
--   the RAISE, silently allowing the write.
--
--   The operator RPC operator_enforce_report() is SECURITY DEFINER but auth.uid()
--   reads the JWT GUC (unchanged under nested SECDEF) → is_current_user_operator()
--   is TRUE for the operator → its writes pass.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._enforce_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_touches_privileged boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Treat the operator-owned defaults (active / no-suspension / not-operator)
    -- as the baseline a self-signup must not deviate from.
    v_touches_privileged := (
      NEW.is_operator IS TRUE
      OR COALESCE(NEW.moderation_state, 'active') <> 'active'
      OR NEW.suspension_expires_at IS NOT NULL
    );
  ELSE  -- UPDATE
    v_touches_privileged := (
      NEW.moderation_state      IS DISTINCT FROM OLD.moderation_state
      OR NEW.suspension_expires_at IS DISTINCT FROM OLD.suspension_expires_at
      OR NEW.is_operator         IS DISTINCT FROM OLD.is_operator
    );
  END IF;

  IF v_touches_privileged
     AND auth.uid() IS NOT NULL
     AND public.is_current_user_operator() IS NOT TRUE
  THEN
    RAISE EXCEPTION
      'profiles.moderation_state / suspension_expires_at / is_operator are operator-only'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger functions fire regardless of EXECUTE grant; revoke anyway (default
-- privileges auto-grant EXECUTE to anon on CREATE; REVOKE FROM PUBLIC alone does
-- not remove the explicit anon grant).
REVOKE EXECUTE ON FUNCTION public._enforce_profile_privileged_columns()
  FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_profiles_privileged_columns_guard ON public.profiles;
CREATE TRIGGER trg_profiles_privileged_columns_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_profile_privileged_columns();

-- ---------------------------------------------------------------------------
-- A1 — REVOKE anon/PUBLIC EXECUTE on internal SECDEF helpers that drifted to
--   anon-executable in prod. Each is a trigger function, an internal assert
--   called only inside other SECDEF paths (which run as owner), or an
--   authenticated-only RPC / policy helper — none is reachable by anon.
--
--   authenticated EXECUTE is re-granted explicitly for the helpers an
--   authenticated caller genuinely uses, so REVOKE FROM PUBLIC cannot strip
--   access that relied on the PUBLIC grant.
--
--   DELIBERATELY NOT REVOKED — anon legitimately needs these:
--     • provider_is_public(uuid) — evaluated inside {public} RLS policies on
--       provider_media and provider_media_assets; revoking breaks anonymous
--       provider-media reads.
--     • get_provider_median_response_ms(...) — called by the anon-browsable
--       explore / provider-profile surface; benign read-only aggregate, no PII.
-- ---------------------------------------------------------------------------

-- Used in the {authenticated} chat-message participant policy path; never anon.
REVOKE EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_blocked(uuid, uuid) TO authenticated;

-- Used only in the {authenticated} spatial_scenes_update policy.
REVOKE EXECUTE ON FUNCTION public.spatial_can_edit_scene(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_can_edit_scene(uuid, uuid) TO authenticated;

-- Authenticated-only client RPC (createEmptyRoomProject.ts).
REVOKE EXECUTE ON FUNCTION public.spatial_create_manual_scene(
  uuid, uuid, text, text, integer, text, jsonb, text
) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_create_manual_scene(
  uuid, uuid, text, text, integer, text, jsonb, text
) TO authenticated;

-- Trigger function (auth.users delete cascade) — fires regardless of grant.
REVOKE EXECUTE ON FUNCTION public.handle_auth_user_delete_cascade() FROM PUBLIC, anon;

-- Trigger function (provider media cover sync) — fires regardless of grant.
REVOKE EXECUTE ON FUNCTION public.sync_provider_media_cover() FROM PUBLIC, anon;

-- Internal assert, called only inside the SECDEF release path (runs as owner).
REVOKE EXECUTE ON FUNCTION public.assert_attribution_finalized_before_release()
  FROM PUBLIC, anon;

-- Make the grant/trigger changes visible to PostgREST immediately.
NOTIFY pgrst, 'reload schema';

-- ===========================================================================
-- BEHAVIORAL REPRO to run at apply (real sessions or pgTAP):
--   1. non-operator UPDATE own moderation_state='active'        → 42501 (blocked)
--   2. non-operator UPDATE own is_operator=true                 → 42501 (blocked)
--   3. fresh signup INSERT own profile with is_operator=true    → 42501 (blocked)
--   4. operator_enforce_report('ban'/'suspend', …) by operator  → succeeds
--   5. normal user UPDATE own display_name / avatar             → succeeds
-- ===========================================================================
