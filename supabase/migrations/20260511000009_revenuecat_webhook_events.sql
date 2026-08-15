-- RevenueCat webhook dedup + audit log
--
-- Mirrors the stripe_webhook_events claim-first pattern.
-- event_id is the RevenueCat event idempotency key (UUID from RC payload).
--
-- outcome values:
--   processed — status successfully written to craftsman_subscriptions
--   duplicate — event_id already seen; no-op (return 200)
--   failed    — DB write attempted but errored
--   skipped   — event type maps to no status change (e.g. SUBSCRIBER_ALIAS)
--
-- RLS: default-deny; service_role only writes (anon/authenticated REVOKED).

CREATE TABLE public.revenuecat_webhook_events (
  event_id            text        PRIMARY KEY,
  event_type          text        NOT NULL,
  event_timestamp_ms  bigint      NOT NULL,
  app_user_id         text,
  payload             jsonb       NOT NULL,
  outcome             text        NOT NULL
    CONSTRAINT rc_webhook_events_outcome_check
      CHECK (outcome IN ('processed', 'duplicate', 'failed', 'skipped')),
  outcome_reason      text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz
);

CREATE INDEX idx_rc_webhook_events_user
  ON public.revenuecat_webhook_events (app_user_id, received_at DESC);

CREATE INDEX idx_rc_webhook_events_outcome
  ON public.revenuecat_webhook_events (outcome)
  WHERE outcome IN ('failed', 'skipped');

ALTER TABLE public.revenuecat_webhook_events ENABLE ROW LEVEL SECURITY;

-- Append-only audit: deny all mutations from anon/authenticated
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.revenuecat_webhook_events
  FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.revenuecat_webhook_events TO service_role;
