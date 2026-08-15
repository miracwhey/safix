-- =============================================================================
-- Migration: extended team_member admin RPCs
-- =============================================================================
-- 1. update_team_member()      — extended signature: phone, email, target hours
-- 2. create_team_member_stub() — owner pre-creates a member (profile_id NULL)
-- 3. join_company_with_code()  — auto-matches stub by email when worker joins
--
-- Why a new update signature: the original (p_member_id, p_full_name, p_role)
-- stays in place to avoid breaking client-side typings during deploy. The
-- extended RPC is the canonical write path going forward — TS layer points to
-- the new function name. Old function is kept callable but unused.
--
-- Stub auto-match invariant in join_company_with_code:
--   If a team_members row exists for this provider with profile_id IS NULL
--   and lower(email) = lower(auth-email of caller), the stub is updated
--   in-place (profile_id := caller, is_active := true). No new row created.
--   This prevents the "two rows per worker" problem after a code redemption.
--   Falls back to legacy insert when no stub matches.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. update_team_member() — extended
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS "public"."update_team_member"(uuid, text, text);

CREATE OR REPLACE FUNCTION "public"."update_team_member"(
  p_member_id            uuid,
  p_full_name            text,
  p_role                 text,
  p_phone                text,
  p_email                text,
  p_weekly_target_hours  numeric,
  p_daily_target_hours   numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid  uuid := "auth"."uid"();
  v_provider_id uuid;
  v_old_row     RECORD;
  v_new_full    text;
  v_new_role    text;
  v_new_phone   text;
  v_new_email   text;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  v_new_full  := COALESCE(NULLIF(TRIM(p_full_name), ''), NULL);
  v_new_role  := COALESCE(NULLIF(TRIM(p_role), ''), NULL);
  v_new_phone := NULLIF(TRIM(p_phone), '');
  v_new_email := NULLIF(LOWER(TRIM(p_email)), '');

  IF v_new_full IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Name darf nicht leer sein.', 'code', 'invalid_name');
  END IF;
  IF v_new_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Rolle darf nicht leer sein.', 'code', 'invalid_role');
  END IF;
  IF v_new_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Rolle kann hier nicht gesetzt werden.', 'code', 'invalid_role');
  END IF;

  IF p_weekly_target_hours IS NOT NULL AND (p_weekly_target_hours < 0 OR p_weekly_target_hours > 168) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wochenstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;
  IF p_daily_target_hours IS NOT NULL AND (p_daily_target_hours < 0 OR p_daily_target_hours > 24) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Tagesstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;

  SELECT tm.* INTO v_old_row FROM "team_members" tm WHERE tm."id" = p_member_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;
  IF v_old_row."role" = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Datensatz kann hier nicht geändert werden.', 'code', 'owner_immutable');
  END IF;

  v_provider_id := v_old_row."provider_id";

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_provider_id
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter bearbeiten.', 'code', 'rbac_owner_required');
  END IF;

  IF v_old_row."profile_id" = v_caller_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Eigene Daten können hier nicht geändert werden.', 'code', 'self_edit_forbidden');
  END IF;

  UPDATE "team_members"
     SET "full_name"           = v_new_full,
         "role"                = v_new_role,
         "phone"               = v_new_phone,
         "email"               = v_new_email,
         "weekly_target_hours" = p_weekly_target_hours,
         "daily_target_hours"  = p_daily_target_hours,
         "updated_at"          = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_provider_id,
    p_member_id,
    v_caller_uid,
    'update',
    jsonb_build_object(
      'full_name',           v_old_row."full_name",
      'role',                v_old_row."role",
      'phone',               v_old_row."phone",
      'email',               v_old_row."email",
      'weekly_target_hours', v_old_row."weekly_target_hours",
      'daily_target_hours',  v_old_row."daily_target_hours"
    ),
    jsonb_build_object(
      'full_name',           v_new_full,
      'role',                v_new_role,
      'phone',               v_new_phone,
      'email',               v_new_email,
      'weekly_target_hours', p_weekly_target_hours,
      'daily_target_hours',  p_daily_target_hours
    )
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Aktualisierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;

REVOKE ALL ON FUNCTION "public"."update_team_member"(uuid, text, text, text, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."update_team_member"(uuid, text, text, text, text, numeric, numeric) TO "authenticated";

-- ---------------------------------------------------------------------------
-- 2. create_team_member_stub()
-- ---------------------------------------------------------------------------
-- Owner pre-creates a member without account link. Stub becomes a real
-- membership when the worker redeems a code (see #3 auto-match below) or
-- can stay as a "shadow" entry for capacity planning.
--
-- Idempotency:
--   - email is the natural dedup key for stubs in a provider scope
--   - if a stub already exists with same lower(email), update it in-place
--   - if a *real* (profile_id NOT NULL) member with same email exists, refuse
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."create_team_member_stub"(
  p_provider_id          uuid,
  p_full_name            text,
  p_role                 text,
  p_phone                text,
  p_email                text,
  p_weekly_target_hours  numeric,
  p_daily_target_hours   numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := "auth"."uid"();
  v_full       text;
  v_role       text;
  v_phone      text;
  v_email      text;
  v_existing_id uuid;
  v_new_id      uuid;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  v_full  := COALESCE(NULLIF(TRIM(p_full_name), ''), NULL);
  v_role  := COALESCE(NULLIF(TRIM(p_role), ''), NULL);
  v_phone := NULLIF(TRIM(p_phone), '');
  v_email := NULLIF(LOWER(TRIM(p_email)), '');

  IF v_full IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Name darf nicht leer sein.', 'code', 'invalid_name');
  END IF;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Rolle darf nicht leer sein.', 'code', 'invalid_role');
  END IF;
  IF v_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Rolle kann hier nicht gesetzt werden.', 'code', 'invalid_role');
  END IF;
  IF p_weekly_target_hours IS NOT NULL AND (p_weekly_target_hours < 0 OR p_weekly_target_hours > 168) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Wochenstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;
  IF p_daily_target_hours IS NOT NULL AND (p_daily_target_hours < 0 OR p_daily_target_hours > 24) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Tagesstunden außerhalb des erlaubten Bereichs.', 'code', 'invalid_hours');
  END IF;

  -- RBAC: caller must be active owner of this provider.
  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm
    WHERE tm."provider_id" = p_provider_id
      AND tm."profile_id"  = v_caller_uid
      AND tm."role"        = 'owner'
      AND tm."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter anlegen.', 'code', 'rbac_owner_required');
  END IF;

  -- Refuse if a *real* (account-linked) member already uses this email.
  IF v_email IS NOT NULL AND EXISTS (
    SELECT 1 FROM "team_members" tm
    WHERE tm."provider_id" = p_provider_id
      AND lower(tm."email") = v_email
      AND tm."profile_id" IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Es existiert bereits ein verknüpfter Mitarbeiter mit dieser E-Mail.', 'code', 'email_exists');
  END IF;

  -- Idempotent stub upsert by (provider_id, lower(email)).
  IF v_email IS NOT NULL THEN
    SELECT tm."id" INTO v_existing_id
    FROM "team_members" tm
    WHERE tm."provider_id" = p_provider_id
      AND lower(tm."email") = v_email
      AND tm."profile_id" IS NULL
    LIMIT 1;
  END IF;

  IF v_existing_id IS NOT NULL THEN
    UPDATE "team_members"
       SET "full_name"           = v_full,
           "role"                = v_role,
           "phone"               = v_phone,
           "email"               = v_email,
           "weekly_target_hours" = p_weekly_target_hours,
           "daily_target_hours"  = p_daily_target_hours,
           "is_active"           = true,
           "updated_at"          = now()
     WHERE "id" = v_existing_id;
    v_new_id := v_existing_id;
  ELSE
    INSERT INTO "team_members" (
      "provider_id", "profile_id", "full_name", "role", "phone", "email",
      "weekly_target_hours", "daily_target_hours", "is_active"
    ) VALUES (
      p_provider_id, NULL, v_full, v_role, v_phone, v_email,
      p_weekly_target_hours, p_daily_target_hours, true
    )
    RETURNING "id" INTO v_new_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'member_id', v_new_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Anlegen fehlgeschlagen.', 'code', 'unknown');
END;
$$;

REVOKE ALL ON FUNCTION "public"."create_team_member_stub"(uuid, text, text, text, text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."create_team_member_stub"(uuid, text, text, text, text, numeric, numeric) TO "authenticated";

-- ---------------------------------------------------------------------------
-- 3. join_company_with_code() — stub auto-match
-- ---------------------------------------------------------------------------
-- Recreated to add the stub-match path BEFORE the legacy insert. Order:
--   a. validate code → resolve provider
--   b. existing membership for this user (any state) → reactivate (handles re-join)
--   c. stub for this provider matching caller's auth email (profile_id NULL)
--      → claim the stub: profile_id := caller, full_name overwrite if provided
--   d. fallback: insert new row
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
  v_code_row    RECORD;
  v_caller_email text;
  v_stub_id      uuid;
BEGIN
  -- a. Validate and look up the code (uppercase, status=active).
  SELECT "id", "provider_id", "target_role"
  INTO v_code_row
  FROM "company_join_codes"
  WHERE "code"   = UPPER(TRIM(p_code))
    AND "status" = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Code ungültig oder abgelaufen.', 'code', 'invalid_code');
  END IF;

  -- b. Existing membership? Reactivate. Handles re-join after leave.
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

    RETURN jsonb_build_object('ok', true, 'provider_id', v_code_row."provider_id");
  END IF;

  -- c. Stub auto-match by email. Caller's auth email comes from auth.users.
  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u
  WHERE u.id = "auth"."uid"();

  IF v_caller_email IS NOT NULL THEN
    SELECT tm."id" INTO v_stub_id
    FROM "team_members" tm
    WHERE tm."provider_id" = v_code_row."provider_id"
      AND lower(tm."email") = v_caller_email
      AND tm."profile_id" IS NULL
    LIMIT 1;

    IF v_stub_id IS NOT NULL THEN
      UPDATE "team_members"
         SET "profile_id" = "auth"."uid"(),
             "full_name"  = COALESCE(NULLIF(TRIM(p_full_name), ''), "full_name"),
             "is_active"  = true,
             "updated_at" = now()
       WHERE "id" = v_stub_id;

      RETURN jsonb_build_object('ok', true, 'provider_id', v_code_row."provider_id", 'matched_stub', true);
    END IF;
  END IF;

  -- d. Fallback insert. Concurrency safety via partial unique index.
  INSERT INTO "team_members" (
    "provider_id", "profile_id", "full_name", "role", "is_active"
  ) VALUES (
    v_code_row."provider_id",
    "auth"."uid"(),
    COALESCE(NULLIF(TRIM(p_full_name), ''), 'Mitarbeiter'),
    v_code_row."target_role",
    true
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'provider_id', v_code_row."provider_id");

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Beitritt fehlgeschlagen. Bitte versuche es erneut.', 'code', 'unknown');
END;
$$;

REVOKE ALL ON FUNCTION "public"."join_company_with_code"(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."join_company_with_code"(text, text) TO "authenticated";
