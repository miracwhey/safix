-- ============================================================================
-- Migration: thread_artifacts — Add change_order artifact type
-- ============================================================================
--
-- Expands the thread_artifacts CHECK constraint to include 'change_order' as
-- a valid artifact_type.  Each ChangeOrder (Nachtrag) that is sent to the
-- customer produces an append-only artifact record in the thread, similar to
-- how project cards work (multiple per conversation, no uniqueness constraint).
--
-- Also adds a change_order_id column so the artifact record carries its
-- canonical ChangeOrder identifier directly — the client selector needs this
-- to load the live ChangeOrder entity and render the Nachtrag card.
--
-- ── Expand CHECK constraint ───────────────────────────────────────────────

DO $$
BEGIN
  ALTER TABLE thread_artifacts DROP CONSTRAINT IF EXISTS thread_artifacts_artifact_type_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;

ALTER TABLE thread_artifacts
  ADD CONSTRAINT thread_artifacts_artifact_type_check
  CHECK (artifact_type IN ('project', 'offer', 'payment_phase', 'funding_step', 'change_order'));

-- ── Add change_order_id column ────────────────────────────────────────────
-- Nullable FK to change_orders.id.  Only set for artifactType='change_order'.
-- ON DELETE CASCADE: if the ChangeOrder is deleted (e.g. during rollback),
-- the artifact record is automatically removed.

ALTER TABLE thread_artifacts
  ADD COLUMN IF NOT EXISTS change_order_id uuid REFERENCES change_orders(id) ON DELETE CASCADE;

-- ── Index for change_order lookups ────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_thread_artifacts_change_order
  ON thread_artifacts(change_order_id)
  WHERE change_order_id IS NOT NULL;
