-- =============================================================================
-- Migration: Stripe webhook event audit log
-- =============================================================================
-- Creates public.stripe_webhook_events as a durable audit trail for
-- processed Stripe webhook events.
--
-- This table is written by the api/stripe-webhook.ts serverless function
-- using the SUPABASE_SERVICE_ROLE_KEY, which bypasses Row Level Security.
-- Normal app clients (anon key) have no write access.
--
-- Row Retention:
--   Events accumulate indefinitely.  For production deployments, schedule
--   a periodic cleanup of rows older than 90 days using a Supabase Edge
--   Function or pg_cron job.  The table is append-only from the app
--   perspective — no updates are ever made.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  -- Stripe's globally unique event ID (evt_*).
  -- PRIMARY KEY enforces deduplication at the database level.
  event_id         text        PRIMARY KEY,

  -- Stripe event type, e.g. 'payment_intent.succeeded'
  event_type       text        NOT NULL,

  -- Stripe PaymentIntent ID associated with this event, if applicable.
  -- Populated for payment_intent.* and charge.*/refund.* events.
  payment_intent_id text,

  -- FixUp payment record ID resolved from provider_ref, if any.
  payment_id       text,

  -- FixUp job ID linked to the payment, if any.
  job_id           text,

  -- Outcome of the reconciliation attempt:
  --   reconciled        — state transition applied successfully
  --   skipped           — no action taken (already in target state or
  --                       invalid transition)
  --   not_found         — no payment found for the given PaymentIntent ID
  --   log_only          — event type does not trigger a reconciliation
  outcome          text        NOT NULL,

  -- Previous FixUp payment state before reconciliation (if reconciled).
  previous_state   text,

  -- New FixUp payment state after reconciliation (if reconciled).
  new_state        text,

  -- Timestamp when this event was processed (ISO 8601 / timestamptz).
  processed_at     timestamptz NOT NULL
);

-- Index for fast lookup by PaymentIntent ID (operational queries, debugging).
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_payment_intent_id
  ON public.stripe_webhook_events (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- Index for temporal scans (cleanup jobs, recent-events queries).
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed_at
  ON public.stripe_webhook_events (processed_at DESC);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The stripe_webhook_events table is written only by the service-role key
-- (from api/stripe-webhook.ts server-side).  No anon or authenticated read
-- access is granted by default.  Adjust according to your backoffice needs.

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Deny all access for normal clients (anon / authenticated roles).
-- The service-role key bypasses RLS entirely and is the sole writer.
-- If you want admin/backoffice read access, add a policy here.
