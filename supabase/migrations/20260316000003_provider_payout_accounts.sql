-- Migration: provider_payout_accounts
-- Stores Stripe Connect onboarding state per provider user.

CREATE TABLE IF NOT EXISTS public.provider_payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_connect_account_id TEXT,
  onboarding_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (onboarding_status IN ('not_started', 'onboarding_in_progress', 'onboarding_complete', 'payout_blocked')),
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  onboarding_completed_at TIMESTAMPTZ,
  requirements_due TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_payout_accounts_provider_user_id_idx
  ON public.provider_payout_accounts (provider_user_id);

ALTER TABLE public.provider_payout_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "provider_payout_own_row" ON public.provider_payout_accounts
  FOR ALL USING (auth.uid() = provider_user_id);
