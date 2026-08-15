-- =============================================================================
-- Migration: Owner-side team_member management (edit / deactivate / reactivate)
-- =============================================================================
-- 1. team_member_audit append-only log (analog to company_code_audit)
-- 2. RPCs (SECURITY DEFINER, owner-scoped, audit-on-success):
--    - update_team_member(p_member_id, p_full_name, p_role)
--    - deactivate_team_member(p_member_id)
--    - reactivate_team_member(p_member_id)
--
-- Why server-side RPCs:
--   - workers cannot UPDATE under existing RLS; owner UPDATE works but
--     centralising via RPCs guarantees the audit trail is written every time.
--   - owner_self protection (cannot edit/deactivate own row) is enforced
--     uniformly server-side rather than scattered across UI checks.
--
-- Owner cannot:
--   - edit/deactivate own membership row (would orphan provider control)
--   - reassign role to/from 'owner' (system role is set during onboarding only)
--
-- All actions write a row to team_member_audit. The audit table is
-- append-only at two layers: lack of INSERT/UPDATE/DELETE policies under RLS
-- + REVOKE on the column GRANTs (defense-in-depth, mirrors company_code_audit).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. team_member_audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "public"."team_member_audit" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_id"  uuid        NOT NULL
                             REFERENCES "public"."providers"("id") ON DELETE CASCADE,
  "member_id"    uuid        NOT NULL
                             REFERENCES "public"."team_members"("id") ON DELETE CASCADE,
  "actor_id"     uuid        NOT NULL,
  "action"       text        NOT NULL
                             CHECK ("action" IN (
                               'update', 'deactivate', 'reactivate'
                             )),
  "old_values"   jsonb,
  "new_values"   jsonb,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_team_member_audit_provider_created"
  ON "public"."team_member_audit" ("provider_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_team_member_audit_member"
  ON "public"."team_member_audit" ("member_id", "created_at" DESC);

ALTER TABLE "public"."team_member_audit" ENABLE ROW LEVEL SECURITY;

-- Owner can read their own provider's audit log.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'team_member_audit'
      AND policyname = 'team_member_audit_owner_select'
  ) THEN
    CREATE POLICY "team_member_audit_owner_select" ON "public"."team_member_audit"
      FOR SELECT TO "authenticated"
      USING (
        "provider_id" IN (
          SELECT "id" FROM "public"."providers"
          WHERE "profile_id" = "auth"."uid"()
        )
      );
  END IF;
END $$;

-- Append-only: revoke writes for both anon + authenticated. SECURITY DEFINER
-- RPCs (postgres role) remain the only writers.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."team_member_audit" FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "public"."team_member_audit" FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. update_team_member()
-- ---------------------------------------------------------------------------
-- Owner edits full_name + role/trade label of a team member.
-- Cannot change to/from system role 'owner'.
-- Cannot edit own row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."update_team_member"(
  p_member_id  uuid,
  p_full_name  text,
  p_role       text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid uuid := "auth"."uid"();
  v_provider_id uuid;
  v_old_row     RECORD;
  v_new_full    text;
  v_new_role    text;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  v_new_full := COALESCE(NULLIF(TRIM(p_full_name), ''), NULL);
  v_new_role := COALESCE(NULLIF(TRIM(p_role), ''), NULL);

  IF v_new_full IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Name darf nicht leer sein.', 'code', 'invalid_name');
  END IF;

  IF v_new_role IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Rolle darf nicht leer sein.', 'code', 'invalid_role');
  END IF;

  -- Block escalation/demotion to/from system role 'owner'.
  IF v_new_role = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Rolle kann hier nicht gesetzt werden.', 'code', 'invalid_role');
  END IF;

  SELECT tm.* INTO v_old_row
  FROM "team_members" tm
  WHERE tm."id" = p_member_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;

  IF v_old_row."role" = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Datensatz kann hier nicht geändert werden.', 'code', 'owner_immutable');
  END IF;

  v_provider_id := v_old_row."provider_id";

  -- RBAC: caller must be owner of this provider.
  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_provider_id
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter bearbeiten.', 'code', 'rbac_owner_required');
  END IF;

  -- Self-edit guard: owner cannot edit own row via this RPC.
  IF v_old_row."profile_id" = v_caller_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Eigene Daten können hier nicht geändert werden.', 'code', 'self_edit_forbidden');
  END IF;

  UPDATE "team_members"
     SET "full_name"  = v_new_full,
         "role"       = v_new_role,
         "updated_at" = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_provider_id,
    p_member_id,
    v_caller_uid,
    'update',
    jsonb_build_object('full_name', v_old_row."full_name", 'role', v_old_row."role"),
    jsonb_build_object('full_name', v_new_full, 'role', v_new_role)
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Aktualisierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;

REVOKE ALL ON FUNCTION "public"."update_team_member"(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."update_team_member"(uuid, text, text) TO "authenticated";

-- ---------------------------------------------------------------------------
-- 3. deactivate_team_member()
-- ---------------------------------------------------------------------------
-- Soft-removal: is_active := false. Worker loses access on next session reload.
-- Existing job assignments / calendar entries remain intact for history.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."deactivate_team_member"(p_member_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid  uuid := "auth"."uid"();
  v_old_row     RECORD;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  SELECT tm.* INTO v_old_row
  FROM "team_members" tm
  WHERE tm."id" = p_member_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;

  IF v_old_row."role" = 'owner' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Inhaber-Datensatz kann nicht deaktiviert werden.', 'code', 'owner_immutable');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_old_row."provider_id"
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter deaktivieren.', 'code', 'rbac_owner_required');
  END IF;

  IF v_old_row."profile_id" = v_caller_uid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Eigene Mitgliedschaft kann hier nicht deaktiviert werden.', 'code', 'self_edit_forbidden');
  END IF;

  IF v_old_row."is_active" = false THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE "team_members"
     SET "is_active"  = false,
         "updated_at" = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_old_row."provider_id",
    p_member_id,
    v_caller_uid,
    'deactivate',
    jsonb_build_object('is_active', true),
    jsonb_build_object('is_active', false)
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Deaktivierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;

REVOKE ALL ON FUNCTION "public"."deactivate_team_member"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."deactivate_team_member"(uuid) TO "authenticated";

-- ---------------------------------------------------------------------------
-- 4. reactivate_team_member()
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."reactivate_team_member"(p_member_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_uid  uuid := "auth"."uid"();
  v_old_row     RECORD;
BEGIN
  IF v_caller_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nicht eingeloggt.', 'code', 'unauthenticated');
  END IF;

  SELECT tm.* INTO v_old_row
  FROM "team_members" tm
  WHERE tm."id" = p_member_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mitarbeiter nicht gefunden.', 'code', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "team_members" tm2
    WHERE tm2."provider_id" = v_old_row."provider_id"
      AND tm2."profile_id"  = v_caller_uid
      AND tm2."role"        = 'owner'
      AND tm2."is_active"   = true
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nur der Inhaber darf Mitarbeiter reaktivieren.', 'code', 'rbac_owner_required');
  END IF;

  IF v_old_row."is_active" = true THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  UPDATE "team_members"
     SET "is_active"  = true,
         "updated_at" = now()
   WHERE "id" = p_member_id;

  INSERT INTO "team_member_audit" (
    "provider_id", "member_id", "actor_id", "action", "old_values", "new_values"
  ) VALUES (
    v_old_row."provider_id",
    p_member_id,
    v_caller_uid,
    'reactivate',
    jsonb_build_object('is_active', false),
    jsonb_build_object('is_active', true)
  );

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', 'Reaktivierung fehlgeschlagen.', 'code', 'unknown');
END;
$$;

REVOKE ALL ON FUNCTION "public"."reactivate_team_member"(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."reactivate_team_member"(uuid) TO "authenticated";
