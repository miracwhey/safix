-- Supplementary Payment Requests — V2: Platform Stripe Funding
--
-- Extends the supplementary_payment_requests table to support Stripe-based
-- platform funding (the "V2" path noted in the original V1 design).
--
-- Changes:
--   1. Expand CHECK constraint to include 'funding_initiated' and 'funded' statuses.
--   2. Add funding_initiated_at and funded_at timestamp columns.
--
-- The original V1 manual path (pending → acknowledged → paid/waived) is preserved.
-- The new Stripe path adds: pending/acknowledged → funding_initiated → funded.

-- ── 1. Drop and recreate the status CHECK constraint ──────────────────────────
-- PostgreSQL does not support ALTER CONSTRAINT for CHECK constraints,
-- so we drop and recreate.

ALTER TABLE supplementary_payment_requests
  DROP CONSTRAINT IF EXISTS supplementary_payment_requests_status_check;

ALTER TABLE supplementary_payment_requests
  ADD CONSTRAINT supplementary_payment_requests_status_check
    CHECK (status IN ('pending', 'acknowledged', 'funding_initiated', 'funded', 'paid', 'waived'));

-- ── 2. Add new timestamp columns ──────────────────────────────────────────────

ALTER TABLE supplementary_payment_requests
  ADD COLUMN IF NOT EXISTS funding_initiated_at BIGINT;

ALTER TABLE supplementary_payment_requests
  ADD COLUMN IF NOT EXISTS funded_at BIGINT;

-- ── 3. Index for external_ref lookups (webhook reconciliation) ────────────────

CREATE INDEX IF NOT EXISTS supplementary_payment_requests_external_ref_idx
  ON supplementary_payment_requests (external_ref)
  WHERE external_ref IS NOT NULL;
