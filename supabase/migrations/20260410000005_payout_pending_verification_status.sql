-- Add 'pending_verification' to the allowed onboarding_status values.
-- This distinguishes "user submitted all info, waiting for Stripe verification"
-- from "user still has required steps to complete" (onboarding_in_progress).
--
-- Safe to apply: only adds a new allowed value, does not alter existing rows.

ALTER TABLE provider_payout_accounts
  DROP CONSTRAINT IF EXISTS provider_payout_accounts_onboarding_status_check;

ALTER TABLE provider_payout_accounts
  ADD CONSTRAINT provider_payout_accounts_onboarding_status_check
  CHECK (onboarding_status IN ('not_started', 'onboarding_in_progress', 'pending_verification', 'onboarding_complete', 'payout_blocked'));
