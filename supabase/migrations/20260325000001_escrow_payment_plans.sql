-- Escrow Payment Plan Foundation
-- Creates persistent tables for the FixUp V1 escrow model:
--   1. escrow_payment_plans  — one per accepted quote
--   2. escrow_tranches       — two per plan (25% deposit_release + 75% final_release)

-- ═══════════════════════════════════════════════════════════════════════════
-- escrow_payment_plans
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS escrow_payment_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_offer_id UUID NOT NULL,
  job_id          UUID NOT NULL,
  customer_user_id UUID NOT NULL,
  provider_id     UUID NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'EUR',
  total_amount    NUMERIC(12,2) NOT NULL,
  funding_mode    TEXT NOT NULL DEFAULT 'full_upfront_escrow',
  release_model   TEXT NOT NULL DEFAULT 'start_25_completion_75',
  status          TEXT NOT NULL DEFAULT 'awaiting_customer_funding',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Funding lifecycle timestamps
  funding_initiated_at TIMESTAMPTZ,
  funded_at            TIMESTAMPTZ,

  -- External payment provider references
  external_funding_ref    TEXT,
  funding_idempotency_key TEXT,

  -- Enforce one plan per accepted offer (idempotency)
  CONSTRAINT escrow_plans_source_offer_unique UNIQUE (source_offer_id),

  -- Enforce valid plan statuses
  CONSTRAINT escrow_plans_status_check CHECK (
    status IN (
      'awaiting_customer_funding',
      'funding_initiated',
      'funded_in_escrow',
      'partially_released',
      'fully_released',
      'funding_failed',
      'disputed',
      'refunded',
      'cancelled'
    )
  ),

  -- Enforce valid funding modes
  CONSTRAINT escrow_plans_funding_mode_check CHECK (
    funding_mode IN ('full_upfront_escrow')
  ),

  -- Enforce valid release models
  CONSTRAINT escrow_plans_release_model_check CHECK (
    release_model IN ('start_25_completion_75')
  )
);

-- Partial unique index: only enforce uniqueness for non-NULL idempotency keys
CREATE UNIQUE INDEX IF NOT EXISTS idx_escrow_plans_idempotency_key
  ON escrow_payment_plans (funding_idempotency_key)
  WHERE funding_idempotency_key IS NOT NULL;

-- Index for fast lookup by job_id
CREATE INDEX IF NOT EXISTS idx_escrow_plans_job_id
  ON escrow_payment_plans (job_id);

-- Index for fast lookup by customer
CREATE INDEX IF NOT EXISTS idx_escrow_plans_customer
  ON escrow_payment_plans (customer_user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- escrow_tranches
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS escrow_tranches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         UUID NOT NULL REFERENCES escrow_payment_plans(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  percentage      NUMERIC(5,2) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  release_trigger TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending_funding',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Release lifecycle timestamps
  eligible_at     TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,

  -- External release references and audit
  external_release_ref TEXT,
  triggered_by         TEXT,
  released_by          TEXT,

  -- Enforce valid tranche kinds
  CONSTRAINT escrow_tranches_kind_check CHECK (
    kind IN ('deposit_release', 'final_release')
  ),

  -- Enforce valid release triggers
  CONSTRAINT escrow_tranches_trigger_check CHECK (
    release_trigger IN ('work_started', 'work_completed')
  ),

  -- Enforce valid tranche statuses
  CONSTRAINT escrow_tranches_status_check CHECK (
    status IN (
      'pending_funding',
      'funded',
      'locked',
      'eligible_for_release',
      'release_pending',
      'released',
      'blocked',
      'disputed',
      'refunded',
      'cancelled'
    )
  ),

  -- Enforce valid triggered_by values
  CONSTRAINT escrow_tranches_triggered_by_check CHECK (
    triggered_by IS NULL OR triggered_by IN ('customer', 'provider', 'system')
  ),

  -- Enforce valid released_by values
  CONSTRAINT escrow_tranches_released_by_check CHECK (
    released_by IS NULL OR released_by IN ('customer', 'provider', 'system')
  ),

  -- Prevent duplicate tranches of the same kind within a plan
  CONSTRAINT escrow_tranches_plan_kind_unique UNIQUE (plan_id, kind)
);

-- Index for fast lookup by plan_id
CREATE INDEX IF NOT EXISTS idx_escrow_tranches_plan_id
  ON escrow_tranches (plan_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS Policies
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE escrow_payment_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrow_tranches ENABLE ROW LEVEL SECURITY;

-- Customers can read their own plans
CREATE POLICY escrow_plans_customer_read ON escrow_payment_plans
  FOR SELECT
  USING (auth.uid() = customer_user_id);

-- Providers can read plans where they are the counterparty
CREATE POLICY escrow_plans_provider_read ON escrow_payment_plans
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM providers
      WHERE providers.id = escrow_payment_plans.provider_id
        AND providers.profile_id = auth.uid()
    )
  );

-- Service role can do everything (for webhooks, admin)
CREATE POLICY escrow_plans_service_all ON escrow_payment_plans
  FOR ALL
  USING (auth.role() = 'service_role');

-- Tranches inherit read access through their plan (customer)
CREATE POLICY escrow_tranches_customer_read ON escrow_tranches
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM escrow_payment_plans
      WHERE escrow_payment_plans.id = escrow_tranches.plan_id
        AND escrow_payment_plans.customer_user_id = auth.uid()
    )
  );

-- Tranches inherit read access through their plan (provider)
CREATE POLICY escrow_tranches_provider_read ON escrow_tranches
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM escrow_payment_plans
        INNER JOIN providers ON providers.id = escrow_payment_plans.provider_id
      WHERE escrow_payment_plans.id = escrow_tranches.plan_id
        AND providers.profile_id = auth.uid()
    )
  );

CREATE POLICY escrow_tranches_service_all ON escrow_tranches
  FOR ALL
  USING (auth.role() = 'service_role');
