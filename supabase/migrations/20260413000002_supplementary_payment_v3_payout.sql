-- Supplementary Payment Requests — V3: Payout Release
--
-- Extends the supplementary_payment_requests table to support the payout
-- release flow: funded → released (Stripe Transfer to craftsman).
--
-- Changes:
--   1. Expand CHECK constraint to include 'released' status.
--   2. Add released_at timestamp column.
--   3. Add external_payout_ref column (Stripe Transfer ID).
--   4. Add ledger entry types for supplementary payout tracking.

-- ── 1. Drop and recreate the status CHECK constraint ──────────────────────────

ALTER TABLE supplementary_payment_requests
  DROP CONSTRAINT IF EXISTS supplementary_payment_requests_status_check;

ALTER TABLE supplementary_payment_requests
  ADD CONSTRAINT supplementary_payment_requests_status_check
    CHECK (status IN ('pending', 'acknowledged', 'funding_initiated', 'funded', 'released', 'paid', 'waived'));

-- ── 2. Add new columns ───────────────────────────────────────────────────────

ALTER TABLE supplementary_payment_requests
  ADD COLUMN IF NOT EXISTS released_at BIGINT;

ALTER TABLE supplementary_payment_requests
  ADD COLUMN IF NOT EXISTS external_payout_ref TEXT;

-- ── 3. Index for payout ref lookups (reconciliation) ─────────────────────────

CREATE INDEX IF NOT EXISTS supplementary_payment_requests_payout_ref_idx
  ON supplementary_payment_requests (external_payout_ref)
  WHERE external_payout_ref IS NOT NULL;

-- ── 4. Expand ledger_entries type constraint if it exists ────────────────────
-- The ledger_entries.type column may have a CHECK constraint. If so, expand it.
-- If not (no constraint), this is a no-op.

DO $$
BEGIN
  -- Only alter if the constraint exists
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'ledger_entries' AND column_name = 'type'
  ) THEN
    ALTER TABLE ledger_entries
      DROP CONSTRAINT IF EXISTS ledger_entries_type_check;

    ALTER TABLE ledger_entries
      ADD CONSTRAINT ledger_entries_type_check
        CHECK (type IN (
          'escrow_created', 'deposit_paid', 'final_paid', 'platform_fee',
          'payout', 'refund', 'dispute_hold', 'dispute_resolved_release',
          'dispute_resolved_refund', 'supplementary_created',
          'supplementary_funded', 'supplementary_platform_fee', 'supplementary_payout'
        ));
  END IF;
END $$;
