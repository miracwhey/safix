-- Serialize RevenueCat subscription state transitions per profile and commit
-- the subscription write together with the webhook audit outcome. The handler
-- claims/reclaims the event before calling this function; this transaction is
-- the only place where a status-bearing event is applied or terminally skipped.

CREATE OR REPLACE FUNCTION public.finalize_revenuecat_subscription_event(
  p_event_id text,
  p_profile_id text,
  p_event_timestamp_ms bigint,
  p_subscription_updates jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_latest_applied_timestamp_ms bigint;
BEGIN
  -- Different RevenueCat event IDs for one profile must not race between the
  -- ordering check and the subscription update. The transaction-scoped lock
  -- is released automatically on commit or rollback.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_profile_id, 728651)
  );

  -- Lock and validate the claim made by the handler. Raising here prevents a
  -- subscription write when the event is no longer in the processing state.
  PERFORM 1
  FROM public.revenuecat_webhook_events
  WHERE event_id = p_event_id
    AND app_user_id = p_profile_id
    AND event_timestamp_ms = p_event_timestamp_ms
    AND outcome = 'processing'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revenuecat_event_not_claimed';
  END IF;

  SELECT max(event_timestamp_ms)
  INTO v_latest_applied_timestamp_ms
  FROM public.revenuecat_webhook_events
  WHERE app_user_id = p_profile_id
    AND outcome = 'processed'
    AND event_id <> p_event_id;

  IF v_latest_applied_timestamp_ms IS NOT NULL
     AND p_event_timestamp_ms < v_latest_applied_timestamp_ms THEN
    UPDATE public.revenuecat_webhook_events
    SET
      outcome = 'skipped',
      outcome_reason = 'stale_out_of_order',
      processed_at = pg_catalog.clock_timestamp()
    WHERE event_id = p_event_id
      AND outcome = 'processing';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'revenuecat_event_finalize_failed';
    END IF;

    RETURN 'stale';
  END IF;

  UPDATE public.craftsman_subscriptions
  SET
    status = p_subscription_updates->>'status',
    billing_provider = p_subscription_updates->>'billing_provider',
    billing_provider_subscription_id = p_subscription_updates->>'billing_provider_subscription_id',
    updated_at = (p_subscription_updates->>'updated_at')::timestamptz,
    current_period_end = CASE
      WHEN p_subscription_updates ? 'current_period_end'
        THEN (p_subscription_updates->>'current_period_end')::timestamptz
      ELSE current_period_end
    END,
    grace_started_at = CASE
      WHEN p_subscription_updates ? 'grace_started_at'
        THEN (p_subscription_updates->>'grace_started_at')::timestamptz
      ELSE grace_started_at
    END,
    canceled_at = CASE
      WHEN p_subscription_updates ? 'canceled_at'
        THEN (p_subscription_updates->>'canceled_at')::timestamptz
      ELSE canceled_at
    END,
    current_period_start = CASE
      WHEN p_subscription_updates ? 'current_period_start'
        THEN (p_subscription_updates->>'current_period_start')::timestamptz
      ELSE current_period_start
    END,
    trial_started_at = CASE
      WHEN p_subscription_updates ? 'trial_started_at'
        THEN (p_subscription_updates->>'trial_started_at')::timestamptz
      ELSE trial_started_at
    END,
    trial_ends_at = CASE
      WHEN p_subscription_updates ? 'trial_ends_at'
        THEN (p_subscription_updates->>'trial_ends_at')::timestamptz
      ELSE trial_ends_at
    END
  WHERE profile_id = p_profile_id::uuid;

  IF NOT FOUND THEN
    UPDATE public.revenuecat_webhook_events
    SET
      outcome = 'failed',
      outcome_reason = 'no_subscription_row',
      processed_at = pg_catalog.clock_timestamp()
    WHERE event_id = p_event_id
      AND outcome = 'processing';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'revenuecat_event_finalize_failed';
    END IF;

    RETURN 'no_subscription';
  END IF;

  UPDATE public.revenuecat_webhook_events
  SET
    outcome = 'processed',
    outcome_reason = NULL,
    processed_at = pg_catalog.clock_timestamp()
  WHERE event_id = p_event_id
    AND outcome = 'processing';

  IF NOT FOUND THEN
    -- The exception rolls the subscription update back as part of this same
    -- transaction; a successful RPC can therefore never leave processing.
    RAISE EXCEPTION 'revenuecat_event_finalize_failed';
  END IF;

  RETURN 'updated';
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_revenuecat_subscription_event(text, text, bigint, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_revenuecat_subscription_event(text, text, bigint, jsonb)
  TO service_role;
