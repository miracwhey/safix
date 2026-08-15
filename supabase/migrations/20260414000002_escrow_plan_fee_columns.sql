-- Add fee-rate and commercial-origin columns to escrow_payment_plans.
--
-- These columns were referenced by api/initiate-funding.ts (SELECT + UPDATE)
-- and api/release-tranche.ts (SELECT) but never created.
-- Without them, PostgREST rejects both queries with error 42703, making
-- funding initiation and tranche release impossible.
--
-- platform_fee_rate   — locked at funding time from resolveCommercialFeeRate()
-- platform_fee_amount — computed (totalAmount × platformFeeRate), snapshot
-- commercial_origin   — copied from jobs.commercial_origin at funding time

ALTER TABLE escrow_payment_plans
  ADD COLUMN IF NOT EXISTS platform_fee_rate NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS commercial_origin TEXT
    CHECK (commercial_origin IN ('merchant_brought', 'platform_acquired'));
