-- Migration: Add Stripe Connect integration columns to payments table
-- Enables destination charges with platform fees for provider payouts

-- Add column to link payment to provider's Stripe Connect account
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider_stripe_account_id TEXT;

-- Add column to track platform fee amount (calculated from PLATFORM_FEE_RATE)
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(12, 2);

-- Add index for Connect account lookups (useful for provider payout queries)
CREATE INDEX IF NOT EXISTS idx_payments_provider_stripe_account
  ON public.payments (provider_stripe_account_id)
  WHERE provider_stripe_account_id IS NOT NULL;

-- Add helpful comment explaining the integration
COMMENT ON COLUMN public.payments.provider_stripe_account_id IS
  'Stripe Connect account ID (acct_*) for the craftsman receiving payout. Used for destination charges with application_fee_amount.';

COMMENT ON COLUMN public.payments.platform_fee_amount IS
  'Platform fee amount in EUR calculated at payment creation time. Retained by the platform when using destination charges.';
