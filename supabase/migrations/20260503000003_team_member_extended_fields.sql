-- =============================================================================
-- Migration: team_members extended fields
-- =============================================================================
-- Adds owner-managed contact + capacity columns:
--   phone               text     — display only
--   email               text     — used for stub auto-match on join (LOWER-cased)
--   avatar_url          text     — public storage URL (UI upload deferred)
--   weekly_target_hours numeric  — soll-stunden/woche (capacity planning)
--   daily_target_hours  numeric  — soll-stunden/tag   (capacity planning)
--
-- All columns nullable. NULL means "nicht hinterlegt" — UI shows placeholder.
-- Numeric (no scale) so 7.5 / 8 / 40 / 37.5 all fit.
-- ADD COLUMN IF NOT EXISTS keeps the migration idempotent.
--
-- An index on lower(email) supports the stub auto-match path in
-- join_company_with_code (recreated in 20260503000004).
-- =============================================================================

ALTER TABLE "public"."team_members"
  ADD COLUMN IF NOT EXISTS "phone"               text,
  ADD COLUMN IF NOT EXISTS "email"               text,
  ADD COLUMN IF NOT EXISTS "avatar_url"          text,
  ADD COLUMN IF NOT EXISTS "weekly_target_hours" numeric,
  ADD COLUMN IF NOT EXISTS "daily_target_hours"  numeric;

-- Sanity range: target hours must be >= 0 and <= 168 (= week max).
-- Daily implicitly capped via weekly check, but enforce per-row anyway.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'team_members_weekly_target_hours_range'
  ) THEN
    ALTER TABLE "public"."team_members"
      ADD CONSTRAINT "team_members_weekly_target_hours_range"
      CHECK ("weekly_target_hours" IS NULL
             OR ("weekly_target_hours" >= 0 AND "weekly_target_hours" <= 168));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'team_members_daily_target_hours_range'
  ) THEN
    ALTER TABLE "public"."team_members"
      ADD CONSTRAINT "team_members_daily_target_hours_range"
      CHECK ("daily_target_hours" IS NULL
             OR ("daily_target_hours" >= 0 AND "daily_target_hours" <= 24));
  END IF;
END $$;

-- Index for stub auto-match by email (LOWER-cased). Only stubs (profile_id IS NULL)
-- are auto-matched, so the partial index keeps the index small.
CREATE INDEX IF NOT EXISTS "idx_team_members_provider_email_stub"
  ON "public"."team_members" ("provider_id", lower("email"))
  WHERE "profile_id" IS NULL AND "email" IS NOT NULL;
