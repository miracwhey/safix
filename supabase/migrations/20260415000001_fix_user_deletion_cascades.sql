-- =============================================================================
-- Migration: Fix user deletion — replace blocking FK constraints
-- =============================================================================
-- Root cause: Deleting a user from Supabase Dashboard fails with
-- "Database error deleting user" because FK constraints in the cascade chain
-- auth.users → profiles → providers block the DELETE.
--
-- Blockers found via pg_constraint audit on live DB (2026-04-15):
--   1. craftsman_subscriptions.profile_id → profiles(id) NO ACTION → CASCADE
--   2. user_reports.reviewed_by → profiles(id) NO ACTION → SET NULL
--   3. escrow_payment_plans.provider_id → providers(id) RESTRICT → SET NULL
--   4. funding_requests.provider_id → providers(id) RESTRICT → SET NULL
--
-- Design decisions:
--   - craftsman_subscriptions: CASCADE — subscription row has no value without profile
--   - user_reports.reviewed_by: SET NULL — audit field, preserves report with null reviewer
--   - escrow/funding: SET NULL — preserves financial records, nulls provider reference
-- =============================================================================

-- 1. craftsman_subscriptions → CASCADE
ALTER TABLE public.craftsman_subscriptions
  DROP CONSTRAINT craftsman_subscriptions_profile_id_fkey;

ALTER TABLE public.craftsman_subscriptions
  ADD CONSTRAINT craftsman_subscriptions_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 2. user_reports.reviewed_by → SET NULL
ALTER TABLE public.user_reports
  DROP CONSTRAINT user_reports_reviewed_by_fkey;

ALTER TABLE public.user_reports
  ADD CONSTRAINT user_reports_reviewed_by_fkey
  FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 3. escrow_payment_plans.provider_id → SET NULL (make nullable first)
ALTER TABLE public.escrow_payment_plans
  ALTER COLUMN provider_id DROP NOT NULL;

ALTER TABLE public.escrow_payment_plans
  DROP CONSTRAINT escrow_payment_plans_provider_id_fkey;

ALTER TABLE public.escrow_payment_plans
  ADD CONSTRAINT escrow_payment_plans_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE SET NULL;

-- 4. funding_requests.provider_id → SET NULL (make nullable first)
ALTER TABLE public.funding_requests
  ALTER COLUMN provider_id DROP NOT NULL;

ALTER TABLE public.funding_requests
  DROP CONSTRAINT funding_requests_provider_id_fkey;

ALTER TABLE public.funding_requests
  ADD CONSTRAINT funding_requests_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES public.providers(id) ON DELETE SET NULL;
