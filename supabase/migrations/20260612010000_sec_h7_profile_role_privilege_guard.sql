-- ===========================================================================
-- Security hardening — H7 (2026-06-12): profiles.role / craftsman_role
-- self-write = Money/Owner RBAC escalation guard.
--
-- APPLY HELD: run only after explicit "ja apply" (Supabase MCP apply_migration).
-- BEHAVIORAL REPRO required before/at apply — see assertions at the bottom.
--
-- Grounded against PROD (project itdntawwuzqfwmcwnwjr, recon 2026-06-12):
--   • trg_profiles_privileged_columns_guard is LIVE (BEFORE INSERT OR UPDATE ROW,
--     function _enforce_profile_privileged_columns). This migration extends it.
--   • profiles.role DEFAULT = '''customer'''::text — the malformed 10-char string
--     "'customer'" (with embedded single quotes). NOT IN ('customer','craftsman').
--     strictCanonicalRole() in profile.ts treats it as NULL → new users are
--     routed to /onboarding/role as expected. The 20260323000001 DROP DEFAULT
--     did not land in prod (migration ledger drift). The profiles_role_canonical
--     CHECK constraint also did not land in prod.
--   • profiles.craftsman_role has no DEFAULT and no CHECK constraint.
--
-- THE VULNERABILITY (H7):
--   The permissive {public} UPDATE policy (WITH CHECK NULL) that H6/escalation
--   also relied on lets an authenticated user self-write profiles.role and
--   profiles.craftsman_role without any trigger guard (the live 20260612000000
--   guard only covers is_operator / moderation_state / suspension_expires_at).
--
--   Two concrete escalation paths:
--
--   A. Customer → owner escalation:
--      UPDATE profiles SET role='craftsman', craftsman_role='owner' WHERE id=uid
--      After this write, requireOwner() in api/_authRole.ts passes.
--      Attacker gains access to owner-gated API endpoints:
--        request-funding (owner), submit-widerruf (owner),
--        account/team-code-email (owner).
--
--   B. Worker → owner escalation:
--      UPDATE profiles SET craftsman_role='owner' WHERE id=uid
--      Promotes a craftsman worker to owner without the company owner's consent.
--
-- THE GUARD (transition model):
--   Non-operator changes to role/craftsman_role are allowed only for first-set
--   transitions. The distinction is made purely from DB-visible column values.
--
--   role:
--     First-set = OLD.role NOT IN ('customer','craftsman') — covers both NULL and
--     the malformed production DEFAULT "'customer'" (which is not canonical). Any
--     write starting from a non-canonical OLD.role passes through; this is exactly
--     the /onboarding/role flow for new users (malformed → canonical).
--
--     Locked = OLD.role IN ('customer','craftsman'). Once role is a canonical value,
--     any change to a different value (NEW.role DISTINCT FROM OLD.role) is
--     operator-only. No-change writes (role stays the same) are not triggered.
--
--   craftsman_role:
--     Clearing (value → NULL) is always allowed for non-operators — it reduces
--     access, not an escalation.
--
--     First-set (NULL → value) is allowed ONLY when OLD.role is already the
--     canonical 'craftsman'. This closes the gap where setMyCraftsmanRole() is
--     called directly on a fresh account (upsert includes role='craftsman' +
--     craftsman_role='owner' in a single UPDATE while OLD.role is still the
--     malformed default). The legitimate onboarding sequence always calls
--     setMyRole('craftsman') first (which sets canonical OLD.role='craftsman'),
--     then setMyCraftsmanRole() second — so this ordering requirement is enforced
--     at the DB level.
--
--     Post-first-set switch (non-NULL → different non-NULL) is operator-only,
--     covering worker → owner escalation and any other craftsman_role reassignment.
--
--   auth.uid() IS NULL = trusted no-JWT context (service_role / postgres /
--   dashboard / SECDEF trigger). Always allowed.
--   IS NOT TRUE on is_current_user_operator() → fail-closed on three-valued
--   logic. NOT (...) would be NULL for a NULL result → bypasses the RAISE.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Extend _enforce_profile_privileged_columns() to also guard role /
-- craftsman_role. CREATE OR REPLACE: the trigger binding is unchanged.
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
    -- Treat the operator-owned defaults as the baseline a self-signup must
    -- not deviate from (unchanged from 20260612000000).
    -- role / craftsman_role on INSERT are intentionally not guarded here:
    -- handle_new_user always fires first (INSERT INTO profiles (id)), so the
    -- malformed DEFAULT applies and craftsman_role stays NULL. Any subsequent
    -- client upsert conflicts on 'id' and is processed as UPDATE. The only
    -- realistic INSERT path for a client is a theoretical race window before
    -- handle_new_user commits — in that race, the profile row doesn't yet exist
    -- and the column DEFAULT fires (malformed value, not canonical). The UPDATE
    -- guards below cover all practical attack vectors.
    v_touches_privileged := (
      NEW.is_operator IS TRUE
      OR COALESCE(NEW.moderation_state, 'active') <> 'active'
      OR NEW.suspension_expires_at IS NOT NULL
    );

  ELSE  -- UPDATE
    v_touches_privileged := (

      -- H6 / is_operator escalation guard (unchanged from 20260612000000).
      NEW.moderation_state      IS DISTINCT FROM OLD.moderation_state
      OR NEW.suspension_expires_at IS DISTINCT FROM OLD.suspension_expires_at
      OR NEW.is_operator         IS DISTINCT FROM OLD.is_operator

      -- H7: role escalation guard.
      -- Allowed: OLD.role is NULL or the malformed production DEFAULT
      --   ('''customer'''::text = the string "'customer'", NOT IN canonical set).
      --   These represent "not yet set" — first-set onboarding writes pass through.
      -- Allowed: no-change write (NEW.role = OLD.role, IS DISTINCT FROM = false).
      -- Blocked: OLD.role was already a canonical value AND NEW.role is different.
      OR (
        NEW.role IS DISTINCT FROM OLD.role
        AND OLD.role IN ('customer', 'craftsman')
      )

      -- H7: craftsman_role escalation guard.
      -- Allowed: first-set NULL→value, BUT ONLY when OLD.role = 'craftsman' (canonical).
      --   Without this condition, setMyCraftsmanRole() called on a fresh user with the
      --   malformed OLD.role (upsert sets both role='craftsman' + craftsman_role='owner'
      --   in one shot) would bypass the guard. Requiring OLD.role='craftsman' enforces
      --   the two-step onboarding ordering at the DB level.
      -- Blocked: non-NULL → different non-NULL (worker→owner or owner→worker reassignment).
      -- Blocked: clearing a previously-set craftsman_role (value → NULL). This is NOT
      --   exempt: the clear-then-reset laundering bypass (worker clears 'worker'→NULL,
      --   then NULL→'owner' passes as a first-set with OLD.role='craftsman') escalates a
      --   worker to owner in two writes. The only legit clear is clearMyCraftsmanRole()
      --   from RoleSelectionScreen, which is gated behind role IS NULL → craftsman_role
      --   is already NULL there → NULL→NULL is IS DISTINCT FROM = false, never triggers.
      OR (
        NEW.craftsman_role IS DISTINCT FROM OLD.craftsman_role
        AND (
          OLD.craftsman_role IS NOT NULL           -- post-first-set switch OR clearing a set role: blocked
          OR OLD.role IS DISTINCT FROM 'craftsman' -- first-set requires canonical 'craftsman' role first
        )
      )

    );
  END IF;

  IF v_touches_privileged
     AND auth.uid() IS NOT NULL
     AND public.is_current_user_operator() IS NOT TRUE
  THEN
    RAISE EXCEPTION
      'profiles: role / craftsman_role changes after first canonical set, and '
      'moderation_state / suspension_expires_at / is_operator changes, are operator-only'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger functions fire regardless of EXECUTE grant; keep the revoke in sync.
REVOKE EXECUTE ON FUNCTION public._enforce_profile_privileged_columns()
  FROM PUBLIC, anon;

-- Trigger already exists from 20260612000000; DROP + recreate is idempotent
-- and ensures the binding points to the updated function.
DROP TRIGGER IF EXISTS trg_profiles_privileged_columns_guard ON public.profiles;
CREATE TRIGGER trg_profiles_privileged_columns_guard
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public._enforce_profile_privileged_columns();

-- Flush PostgREST schema cache so the updated trigger is visible immediately.
NOTIFY pgrst, 'reload schema';

-- ===========================================================================
-- ROLLBACK (revert to 20260612000000 function body):
--
--   CREATE OR REPLACE FUNCTION public._enforce_profile_privileged_columns()
--   RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
--   AS $$
--   DECLARE
--     v_touches_privileged boolean;
--   BEGIN
--     IF TG_OP = 'INSERT' THEN
--       v_touches_privileged := (
--         NEW.is_operator IS TRUE
--         OR COALESCE(NEW.moderation_state, 'active') <> 'active'
--         OR NEW.suspension_expires_at IS NOT NULL
--       );
--     ELSE
--       v_touches_privileged := (
--         NEW.moderation_state      IS DISTINCT FROM OLD.moderation_state
--         OR NEW.suspension_expires_at IS DISTINCT FROM OLD.suspension_expires_at
--         OR NEW.is_operator         IS DISTINCT FROM OLD.is_operator
--       );
--     END IF;
--     IF v_touches_privileged
--        AND auth.uid() IS NOT NULL
--        AND public.is_current_user_operator() IS NOT TRUE
--     THEN
--       RAISE EXCEPTION
--         'profiles.moderation_state / suspension_expires_at / is_operator are operator-only'
--         USING ERRCODE = '42501';
--     END IF;
--     RETURN NEW;
--   END;
--   $$;
--   DROP TRIGGER IF EXISTS trg_profiles_privileged_columns_guard ON public.profiles;
--   CREATE TRIGGER trg_profiles_privileged_columns_guard
--     BEFORE INSERT OR UPDATE ON public.profiles
--     FOR EACH ROW
--     EXECUTE FUNCTION public._enforce_profile_privileged_columns();
--   NOTIFY pgrst, 'reload schema';
-- ===========================================================================

-- ===========================================================================
-- BEHAVIORAL REPRO (aborted-tx technique — describe only, do NOT run on prod):
--
-- Run as a single transaction with RAISE at the end to roll all assertions back.
-- Each assertion is wrapped in a nested BEGIN/EXCEPTION block so one failure
-- does not abort the outer transaction.
--
-- Setup: two test UIDs needed:
--   non_op_uid  — any existing non-operator user (role='customer', craftsman_role=NULL)
--   worker_uid  — any existing craftsman with craftsman_role='worker'
--
-- The aborted-tx repro sets the JWT GUC to impersonate each user:
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claim.sub', '<uid>', true);
--
-- Assertions (each as nested DO / BEGIN EXCEPTION block):
--
--  1. Customer self-escalation to craftsman owner → 42501 BLOCKED
--     SET LOCAL ROLE authenticated; set_config sub = non_op_uid;
--     UPDATE public.profiles SET role='craftsman', craftsman_role='owner'
--       WHERE id = non_op_uid::uuid;
--     → MUST raise exception with SQLSTATE 42501.
--
--  2. Worker self-escalation to owner → 42501 BLOCKED
--     SET LOCAL ROLE authenticated; set_config sub = worker_uid;
--     UPDATE public.profiles SET craftsman_role='owner'
--       WHERE id = worker_uid::uuid;
--     → MUST raise exception with SQLSTATE 42501.
--
--  3. Legit first-set: new user (malformed DEFAULT role) → canonical customer → allowed
--     Manually set a test row: UPDATE profiles SET role='''customer''' WHERE id=...
--     Then: SET LOCAL ROLE authenticated; set_config sub = test_uid;
--     UPDATE public.profiles SET role='customer' WHERE id = test_uid::uuid;
--     → MUST succeed (no exception).
--
--  4. Legit second-step craftsman_role set: OLD.role='craftsman', OLD.craftsman_role=NULL → allowed
--     Prepare: UPDATE profiles SET role='craftsman', craftsman_role=NULL WHERE id=test_uid;
--     (service_role / postgres context, no trigger restriction on direct write)
--     Then: SET LOCAL ROLE authenticated; set_config sub = test_uid;
--     UPDATE public.profiles SET role='craftsman', craftsman_role='owner'
--       WHERE id = test_uid::uuid;
--     → MUST succeed (no exception).
--
--  5. Operator change of role → allowed
--     SET LOCAL ROLE authenticated; set_config sub = <operator_uid>;
--     UPDATE public.profiles SET role='craftsman', craftsman_role='owner'
--       WHERE id = non_op_uid::uuid;
--     → MUST succeed (operator path).
--
--  6. Normal display_name / avatar update → allowed
--     SET LOCAL ROLE authenticated; set_config sub = non_op_uid;
--     UPDATE public.profiles SET display_name='Test' WHERE id = non_op_uid::uuid;
--     → MUST succeed.
--
--  7. setMyCraftsmanRole directly on fresh user (OLD.role malformed, skip setMyRole) → BLOCKED
--     Prepare: UPDATE profiles SET role='''customer''', craftsman_role=NULL WHERE id=test_uid;
--     Then: SET LOCAL ROLE authenticated; set_config sub = test_uid;
--     UPDATE public.profiles SET role='craftsman', craftsman_role='owner'
--       WHERE id = test_uid::uuid;
--     → MUST raise 42501 (OLD.role not canonical 'craftsman' → craftsman_role first-set blocked).
--
-- Final RAISE in the outer transaction: rolls back all state changes.
-- ===========================================================================
