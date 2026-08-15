-- =============================================================================
-- Migration: Add failure_reason to stripe_webhook_events
-- =============================================================================
--
-- Context
-- -------
-- Block 5 (Payment Provider + Reconciliation Hardening) adds explicit failure
-- reason capture to the webhook event audit trail.  This enables operators to
-- quickly identify and recover from provider-vs-DB divergence without parsing
-- application logs.
--
-- The column is nullable (most events succeed) and only populated when the
-- webhook handler records a non-success outcome (failed, invalid_transition).
--
-- =============================================================================

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS failure_reason text;

COMMENT ON COLUMN public.stripe_webhook_events.failure_reason IS
  'Machine-readable failure reason when outcome is failed/invalid_transition. '
  'NULL for successful events. Used for operator recovery diagnostics.';
