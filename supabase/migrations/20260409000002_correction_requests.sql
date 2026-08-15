-- =============================================================================
-- Migration: Correction Requests
-- =============================================================================
-- Internal worker ↔ owner correction-request flow.
-- Scope: time deviations, assignment deviations, capture/recording issues.
--
-- Visibility rules:
--   Worker  — INSERT own requests; SELECT own requests only
--   Owner   — SELECT + UPDATE all requests for their company
--   No DELETE for either party in V1
-- =============================================================================

CREATE TABLE IF NOT EXISTS "public"."correction_requests" (
  "id"                    text        PRIMARY KEY,
  -- Company scope — matches providers.id
  "provider_id"           uuid        NOT NULL
                                      REFERENCES "public"."providers"("id") ON DELETE CASCADE,
  -- Worker identity — team_members.id (text PK in existing schema)
  "worker_team_member_id" text        NOT NULL,
  -- Auth uid of the submitting worker — used for RLS INSERT/SELECT
  "worker_profile_id"     uuid        NOT NULL,
  -- Optional reference to a specific calendar entry / assignment
  "calendar_entry_id"     text        NULL,
  -- Optional date the correction refers to (YYYY-MM-DD)
  "requested_date"        text        NULL,
  -- Correction kind: missing_time | wrong_time | wrong_assignment | other
  "kind"                  text        NOT NULL
                                      CHECK ("kind" IN ('missing_time', 'wrong_time', 'wrong_assignment', 'other')),
  -- Worker's description of the deviation
  "description"           text        NOT NULL DEFAULT '',
  -- Lifecycle: open | in_review | resolved | rejected
  "status"                text        NOT NULL DEFAULT 'open'
                                      CHECK ("status" IN ('open', 'in_review', 'resolved', 'rejected')),
  -- Optional owner/admin response note
  "owner_note"            text        NULL,
  -- Milliseconds since epoch (repo convention)
  "created_at"            bigint      NOT NULL,
  "updated_at"            bigint      NOT NULL
);

-- Fast lookups
CREATE INDEX IF NOT EXISTS "idx_correction_requests_provider_id"
  ON "public"."correction_requests" ("provider_id");

CREATE INDEX IF NOT EXISTS "idx_correction_requests_worker_profile_id"
  ON "public"."correction_requests" ("worker_profile_id");

CREATE INDEX IF NOT EXISTS "idx_correction_requests_status"
  ON "public"."correction_requests" ("status");

ALTER TABLE "public"."correction_requests" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Worker: INSERT own requests
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'correction_requests'
      AND policyname = 'correction_requests_worker_insert'
  ) THEN
    CREATE POLICY "correction_requests_worker_insert"
      ON "public"."correction_requests"
      FOR INSERT TO "authenticated"
      WITH CHECK (
        "worker_profile_id" = "auth"."uid"()
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Worker: SELECT own requests only
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'correction_requests'
      AND policyname = 'correction_requests_worker_select'
  ) THEN
    CREATE POLICY "correction_requests_worker_select"
      ON "public"."correction_requests"
      FOR SELECT TO "authenticated"
      USING (
        "worker_profile_id" = "auth"."uid"()
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Owner: SELECT all requests for their company
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'correction_requests'
      AND policyname = 'correction_requests_owner_select'
  ) THEN
    CREATE POLICY "correction_requests_owner_select"
      ON "public"."correction_requests"
      FOR SELECT TO "authenticated"
      USING (
        "provider_id" IN (
          SELECT "id" FROM "public"."providers"
          WHERE "profile_id" = "auth"."uid"()
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Owner: UPDATE (status + owner_note) for their company's requests
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'correction_requests'
      AND policyname = 'correction_requests_owner_update'
  ) THEN
    CREATE POLICY "correction_requests_owner_update"
      ON "public"."correction_requests"
      FOR UPDATE TO "authenticated"
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
