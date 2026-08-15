-- Migration: craftsman_profiles — Create base table
--
-- craftsman_profiles stores enrichment data for craftsman business profiles.
-- It is the secondary source of truth alongside the canonical providers table.
-- craftsmanProfileService.ts reads providers first, then enriches with rows
-- from this table (see providerToProfile() and fetchLegacyRow()).
--
-- The business_address column is added by the subsequent migration
-- 20260405000001_craftsman_profile_business_address.sql and is therefore
-- intentionally absent here.
--
-- RLS policies and the increment_craftsman_jobs_count() RPC are added by
-- migration 20260420000007_block0_craftsman_profiles_rls.sql.

CREATE TABLE IF NOT EXISTS public.craftsman_profiles (
  user_id              TEXT        NOT NULL PRIMARY KEY,
  business_name        TEXT        NOT NULL DEFAULT '',
  handle               TEXT        NOT NULL DEFAULT '',
  avatar_url           TEXT,
  bio                  TEXT,
  location             TEXT        NOT NULL DEFAULT '',
  trade_categories     TEXT[]      NOT NULL DEFAULT '{}',
  services_offered     TEXT[],
  service_radius_km    NUMERIC,
  years_in_business    INTEGER,
  completed_jobs_count INTEGER     NOT NULL DEFAULT 0,
  phone                TEXT,
  website              TEXT,
  onboarding_completed BOOLEAN     NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
