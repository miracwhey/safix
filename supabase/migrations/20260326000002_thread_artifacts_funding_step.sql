-- ============================================================================
-- Migration: thread_artifacts — Add funding_step artifact type + funding columns
-- ============================================================================
--
-- Expands the thread_artifacts CHECK constraint to include 'funding_step' as
-- a valid artifact_type.  This separates the provider-requested funding card
-- from the offer-acceptance payment_phase artifact.
--
-- Also adds optional funding_request_id and escrow_plan_id columns so the
-- funding step artifact record carries its canonical funding identifiers
-- directly — the client selector needs these to render the funding card.
--
-- ── Expand CHECK constraint ───────────────────────────────────────────────
-- PostgreSQL does not support ALTER … DROP CONSTRAINT IF EXISTS in all
-- versions, so we use a conditional DO block.

DO $$
BEGIN
  ALTER TABLE thread_artifacts DROP CONSTRAINT IF EXISTS thread_artifacts_artifact_type_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;

ALTER TABLE thread_artifacts
  ADD CONSTRAINT thread_artifacts_artifact_type_check
  CHECK (artifact_type IN ('project', 'offer', 'payment_phase', 'funding_step'));

-- ── The existing UNIQUE(conversation_id, artifact_type) constraint already ──
-- permits distinct types (payment_phase and funding_step) per conversation.
-- No constraint change is needed.

-- ── Add funding reference columns ─────────────────────────────────────────

ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS funding_request_id TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS escrow_plan_id     TEXT;

-- ── Index for funding request lookups ─────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_thread_artifacts_funding_request
  ON thread_artifacts(funding_request_id)
  WHERE funding_request_id IS NOT NULL;
