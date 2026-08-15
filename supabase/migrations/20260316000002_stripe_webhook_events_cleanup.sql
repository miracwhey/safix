-- =============================================================================
-- Migration: Stripe webhook processing recovery
-- =============================================================================
--
-- Context
-- -------
-- The webhook handler (api/stripe-webhook.ts) uses a claim-first dedup pattern:
--   INSERT with outcome='processing' → process → UPDATE to terminal outcome.
--
-- If the handler is interrupted (timeout, crash, network failure) after claiming
-- but before finalizing, the row stays permanently in outcome='processing'.
-- This blocks future Stripe re-deliveries of the same event (PK conflict).
--
-- The cleanup helper (api/_webhookProcessingRecovery.ts) detects rows with
-- outcome='processing' older than 10 minutes and marks them 'processing_expired'.
--
-- New outcome value:
--   processing_expired — set by cleanup when handler was interrupted before
--                        finalizing; the original handler never wrote payment state.
--
-- Re-processing after expiry:
--   Delete the processing_expired row manually before Stripe re-delivers.
--   (Safe: original handler never mutated payment state.)
--
-- =============================================================================

-- Composite index supporting the stale-row query used by cleanupStaleWebhookEvents:
--
--   SELECT ... FROM stripe_webhook_events
--   WHERE outcome = 'processing'
--     AND processed_at < <staleCutoff>
--   LIMIT 100;
--
-- The (outcome, processed_at) index lets Postgres index-scan directly into
-- the 'processing' bucket and then range-scan by processed_at, avoiding
-- a full table scan or bitmap heap fetch.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_outcome_processing_at
  ON public.stripe_webhook_events (outcome, processed_at)
  WHERE outcome = 'processing';

-- Index supporting cleanup result queries and monitoring for expired rows.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_outcome_expired
  ON public.stripe_webhook_events (processed_at DESC)
  WHERE outcome = 'processing_expired';
