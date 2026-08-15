-- =============================================================================
-- Migration: Worker self-leave + re-join reactivation
-- =============================================================================
-- 1. leave_company() — SECURITY DEFINER RPC; worker deactivates own membership
-- 2. join_company_with_code() — patched to reactivate previously deactivated rows
--
-- Why a server-side RPC: workers cannot UPDATE team_members directly under
-- existing RLS (owner-only WRITE). SECURITY DEFINER bypasses RLS but each
-- function enforces its own invariants (auth.uid scoping, owner-block).
--
-- Owners are explicitly blocked from leave_company() — leaving via self-service
-- would orphan the provider. Owner removal must go through support.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. leave_company() — worker self-leave
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."leave_company"()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := "auth"."uid"();
  v_count int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Nicht eingeloggt.',
      'code',  'unauthenticated'
    );
  END IF;

  -- Owners cannot leave their own company via self-service.
  IF EXISTS (
    SELECT 1 FROM "team_members"
    WHERE "profile_id" = v_uid
      AND "role"       = 'owner'
      AND "is_active"  = true
  ) THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Inhaber können das Team nicht selbst verlassen. Bitte Support kontaktieren.',
      'code',  'owner_cannot_leave'
    );
  END IF;

  UPDATE "team_members"
     SET "is_active"  = false,
         "updated_at" = now()
   WHERE "profile_id" = v_uid
     AND "is_active"  = true
     AND "role"      <> 'owner';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Du bist aktuell nicht Mitglied eines Teams.',
      'code',  'not_member'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok',    true,
    'count', v_count
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok',    false,
    'error', 'Austritt fehlgeschlagen. Bitte versuche es erneut.',
    'code',  'unknown'
  );
END;
$$;

REVOKE ALL ON FUNCTION "public"."leave_company"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."leave_company"() TO "authenticated";

-- ---------------------------------------------------------------------------
-- 2. join_company_with_code() — reactivate previously deactivated rows
-- ---------------------------------------------------------------------------
-- Without this patch, a worker who left and re-submits the same code hits the
-- idempotency branch ("ok, already member"), but is_active stays false, so
-- the worker has no actual access. This patch reactivates instead of no-op.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."join_company_with_code"(
  p_code      text,
  p_full_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_row  RECORD;
BEGIN
  -- 1. Validate and look up the code (always normalize to uppercase)
  SELECT "id", "provider_id", "target_role"
  INTO v_code_row
  FROM "company_join_codes"
  WHERE "code"   = UPPER(TRIM(p_code))
    AND "status" = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Code ungültig oder abgelaufen.',
      'code',  'invalid_code'
    );
  END IF;

  -- 2. Existing membership? Reactivate (and refresh full_name) — handles re-join after leave.
  IF EXISTS (
    SELECT 1 FROM "team_members"
    WHERE "provider_id" = v_code_row."provider_id"
      AND "profile_id"  = "auth"."uid"()
  ) THEN
    UPDATE "team_members"
       SET "is_active"  = true,
           "full_name"  = COALESCE(NULLIF(TRIM(p_full_name), ''), "full_name"),
           "updated_at" = now()
     WHERE "provider_id" = v_code_row."provider_id"
       AND "profile_id"  = "auth"."uid"();

    RETURN jsonb_build_object(
      'ok',          true,
      'provider_id', v_code_row."provider_id"
    );
  END IF;

  -- 3. Insert membership row.
  --    ON CONFLICT DO NOTHING handles concurrent submission via
  --    idx_team_members_provider_profile_unique (partial unique index).
  --    COALESCE guarantees full_name NOT NULL is never violated.
  INSERT INTO "team_members" (
    "provider_id",
    "profile_id",
    "full_name",
    "role",
    "is_active"
  )
  VALUES (
    v_code_row."provider_id",
    "auth"."uid"(),
    COALESCE(NULLIF(TRIM(p_full_name), ''), 'Mitarbeiter'),
    v_code_row."target_role",
    true
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'ok',          true,
    'provider_id', v_code_row."provider_id"
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'ok',    false,
    'error', 'Beitritt fehlgeschlagen. Bitte versuche es erneut.',
    'code',  'unknown'
  );
END;
$$;

REVOKE ALL ON FUNCTION "public"."join_company_with_code"(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."join_company_with_code"(text, text) TO "authenticated";
