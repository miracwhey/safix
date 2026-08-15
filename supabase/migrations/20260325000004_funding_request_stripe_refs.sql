-- Funding Request Stripe Integration
-- Adds external payment references and funding_initiated/funding_failed
-- status support to the funding_requests table for Stripe PaymentIntent tracking.

-- ═══════════════════════════════════════════════════════════════════════════
-- Add external funding reference columns to funding_requests
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'funding_requests' AND column_name = 'external_funding_ref'
  ) THEN
    ALTER TABLE funding_requests ADD COLUMN external_funding_ref TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'funding_requests' AND column_name = 'funding_idempotency_key'
  ) THEN
    ALTER TABLE funding_requests ADD COLUMN funding_idempotency_key TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'funding_requests' AND column_name = 'failure_reason'
  ) THEN
    ALTER TABLE funding_requests ADD COLUMN failure_reason TEXT;
  END IF;
END $$;

-- Update the status check to include funding_initiated and funding_failed
ALTER TABLE funding_requests DROP CONSTRAINT IF EXISTS funding_requests_status_check;
ALTER TABLE funding_requests ADD CONSTRAINT funding_requests_status_check CHECK (
  status IN (
    'created',
    'sent',
    'funding_started',
    'funding_initiated',
    'funded',
    'funding_failed',
    'expired',
    'cancelled'
  )
);

-- Partial unique index for idempotency keys
CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_requests_idempotency_key
  ON funding_requests (funding_idempotency_key)
  WHERE funding_idempotency_key IS NOT NULL;

-- Index for external reference lookup (webhook handler)
CREATE INDEX IF NOT EXISTS idx_funding_requests_external_ref
  ON funding_requests (external_funding_ref)
  WHERE external_funding_ref IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS: Allow customer to update funding_started status on their requests
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'funding_requests' AND policyname = 'funding_requests_customer_update'
  ) THEN
    CREATE POLICY funding_requests_customer_update ON funding_requests
      FOR UPDATE
      USING (auth.uid() = customer_user_id);
  END IF;
END $$;
