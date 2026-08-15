-- =============================================================================
-- Migration: Company Join Codes + Membership Foundation
-- =============================================================================
-- 1. company_join_codes table — one active code per provider
-- 2. Partial unique index on team_members(provider_id, profile_id) WHERE profile_id IS NOT NULL
-- 3. SELECT RLS for workers to read their own team_members row
-- 4. join_company_with_code() RPC (SECURITY DEFINER) — safe server-side redemption
-- 5. SQL backfill: owner team_members rows for all existing providers
--
-- Code normalization rule:
--   Codes are always generated, stored, and looked up in UPPERCASE.
--   The RPC applies UPPER(TRIM(...)) before lookup so client-side normalization
--   is defense-in-depth, not the only gate.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. company_join_codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "public"."company_join_codes" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_id" uuid        NOT NULL
                            REFERENCES "public"."providers"("id") ON DELETE CASCADE,
  "code"        text        NOT NULL,
  "target_role" text        NOT NULL DEFAULT 'worker'
                            CHECK ("target_role" IN ('worker')),
  "is_active"   boolean     NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

-- One active code per provider (enforced at DB level)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_company_join_codes_provider_active"
  ON "public"."company_join_codes" ("provider_id")
  WHERE "is_active" = true;

-- Fast lookup on submitted code string (active codes must be globally unique)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_company_join_codes_code_active"
  ON "public"."company_join_codes" ("code")
  WHERE "is_active" = true;

CREATE INDEX IF NOT EXISTS "idx_company_join_codes_provider_id"
  ON "public"."company_join_codes" ("provider_id");

ALTER TABLE "public"."company_join_codes" ENABLE ROW LEVEL SECURITY;

-- Owners can do everything on their company's codes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'company_join_codes'
      AND policyname = 'join_codes_owner_all'
  ) THEN
    CREATE POLICY "join_codes_owner_all" ON "public"."company_join_codes"
      FOR ALL TO "authenticated"
      USING (
        "provider_id" IN (
          SELECT "id" FROM "public"."providers"
          WHERE "profile_id" = "auth"."uid"()
        )
      )
      WITH CHECK (
        "provider_id" IN (
          SELECT "id" FROM "public"."providers"
          WHERE "profile_id" = "auth"."uid"()
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. team_members: partial unique index for linked memberships
-- ---------------------------------------------------------------------------
-- Prevents duplicate membership rows for the same (provider, user) pair.
-- Only applies to rows with an account link (profile_id IS NOT NULL).
-- Unlinked legacy seed rows (tm-1 … tm-4, which have no profile_id) are unaffected.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "idx_team_members_provider_profile_unique"
  ON "public"."team_members" ("provider_id", "profile_id")
  WHERE "profile_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. team_members: SELECT policy for workers to read their own membership row
-- ---------------------------------------------------------------------------
-- The three existing policies only allow owners (via provider ownership).
-- Workers need to read their own row to resolve their company membership.
-- This policy is scoped to the calling user's own profile_id — minimal surface.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'team_members'
      AND policyname = 'Team members: read own profile_id'
  ) THEN
    CREATE POLICY "Team members: read own profile_id" ON "public"."team_members"
      FOR SELECT TO "authenticated"
      USING ("profile_id" = "auth"."uid"());
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. join_company_with_code() — SECURITY DEFINER RPC
-- ---------------------------------------------------------------------------
-- Validates join code server-side and inserts the worker's team_members row.
-- SECURITY DEFINER bypasses the owner-only INSERT RLS on team_members.
-- The function itself enforces all invariants:
--   - code must be active
--   - idempotency (existing member → return success)
--   - race condition safety (ON CONFLICT DO NOTHING via unique partial index)
--   - full_name NOT NULL guaranteed via COALESCE
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
  WHERE "code"      = UPPER(TRIM(p_code))
    AND "is_active" = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',    false,
      'error', 'Code ungültig oder abgelaufen.',
      'code',  'invalid_code'
    );
  END IF;

  -- 2. Idempotency check — already a member of this company?
  IF EXISTS (
    SELECT 1 FROM "team_members"
    WHERE "provider_id" = v_code_row."provider_id"
      AND "profile_id"  = "auth"."uid"()
  ) THEN
    RETURN jsonb_build_object(
      'ok',          true,
      'provider_id', v_code_row."provider_id"
    );
  END IF;

  -- 3. Insert membership row
  --    ON CONFLICT DO NOTHING handles the race condition where two sessions
  --    submit the same code concurrently — unique partial index on
  --    (provider_id, profile_id) WHERE profile_id IS NOT NULL absorbs it.
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

-- Grant execute to authenticated users; revoke from public (default)
REVOKE ALL ON FUNCTION "public"."join_company_with_code"(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."join_company_with_code"(text, text) TO "authenticated";

-- ---------------------------------------------------------------------------
-- 5. Backfill: owner team_members rows for existing providers
-- ---------------------------------------------------------------------------
-- Creates a membership row (role = 'owner') for every provider that does not
-- already have one.  Idempotent: the NOT EXISTS guard skips existing rows.
-- Runs at migration time — existing owners are covered immediately.
-- full_name fallback chain: profiles.display_name → 'Inhaber'
-- ---------------------------------------------------------------------------

INSERT INTO "public"."team_members" (
  "provider_id",
  "profile_id",
  "full_name",
  "role",
  "is_active"
)
SELECT
  p."id",
  p."profile_id",
  COALESCE(NULLIF(TRIM(pr."display_name"), ''), 'Inhaber'),
  'owner',
  true
FROM "public"."providers" p
JOIN "public"."profiles" pr ON pr."id" = p."profile_id"
WHERE p."profile_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "public"."team_members" tm
    WHERE tm."provider_id" = p."id"
      AND tm."profile_id"  = p."profile_id"
      AND tm."role"        = 'owner'
  )
ON CONFLICT DO NOTHING;
