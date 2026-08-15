-- Funding Requests Foundation
-- Persistent object for the funding request / payment card.
-- Tied to accepted quote → job → escrow plan → provider/customer context.
--
-- Exactly one funding request per escrow plan (idempotency via unique constraint).
-- The craftsman-side payment/funding card is backed by this persisted entity.

-- ═══════════════════════════════════════════════════════════════════════════
-- funding_requests
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS funding_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_offer_id   UUID NOT NULL,
  job_id            UUID NOT NULL,
  escrow_plan_id    UUID NOT NULL REFERENCES escrow_payment_plans(id) ON DELETE CASCADE,
  customer_user_id  UUID NOT NULL,
  provider_id       UUID NOT NULL,
  provider_user_id  UUID NOT NULL,
  type              TEXT NOT NULL DEFAULT 'full_escrow',
  status            TEXT NOT NULL DEFAULT 'created',
  amount            NUMERIC(12,2) NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'EUR',
  created_by        TEXT NOT NULL DEFAULT 'provider',
  conversation_id   TEXT,
  message_id        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ,
  funded_at         TIMESTAMPTZ,

  -- Enforce one funding request per escrow plan (idempotency)
  CONSTRAINT funding_requests_escrow_plan_unique UNIQUE (escrow_plan_id),

  -- Enforce valid types
  CONSTRAINT funding_requests_type_check CHECK (
    type IN ('full_escrow')
  ),

  -- Enforce valid statuses
  CONSTRAINT funding_requests_status_check CHECK (
    status IN (
      'created',
      'sent',
      'funding_started',
      'funded',
      'expired',
      'cancelled'
    )
  ),

  -- Enforce valid created_by values
  CONSTRAINT funding_requests_created_by_check CHECK (
    created_by IN ('provider', 'system')
  )
);

-- Index for fast lookup by job_id
CREATE INDEX IF NOT EXISTS idx_funding_requests_job_id
  ON funding_requests (job_id);

-- Index for fast lookup by source_offer_id
CREATE INDEX IF NOT EXISTS idx_funding_requests_source_offer_id
  ON funding_requests (source_offer_id);

-- Index for fast lookup by customer
CREATE INDEX IF NOT EXISTS idx_funding_requests_customer
  ON funding_requests (customer_user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS Policies
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE funding_requests ENABLE ROW LEVEL SECURITY;

-- Customers can read their own funding requests
CREATE POLICY funding_requests_customer_read ON funding_requests
  FOR SELECT
  USING (auth.uid() = customer_user_id);

-- Providers can read funding requests they created
CREATE POLICY funding_requests_provider_read ON funding_requests
  FOR SELECT
  USING (auth.uid() = provider_user_id);

-- Providers can insert funding requests (they create them)
CREATE POLICY funding_requests_provider_insert ON funding_requests
  FOR INSERT
  WITH CHECK (auth.uid() = provider_user_id);

-- Providers can update their own funding requests (status transitions)
CREATE POLICY funding_requests_provider_update ON funding_requests
  FOR UPDATE
  USING (auth.uid() = provider_user_id);

-- Service role can do everything (for webhooks, admin)
CREATE POLICY funding_requests_service_all ON funding_requests
  FOR ALL
  USING (auth.role() = 'service_role');
