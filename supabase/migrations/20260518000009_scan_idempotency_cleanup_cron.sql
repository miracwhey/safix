-- Spatial Core · Block A.1 · Idempotency Cleanup (pg_cron)
--
-- The `idempotency_key` column on scan_events is meant for retry-safety on a
-- single user-action window — keeping keys forever wastes index bytes and
-- (worst case) leaks a stable per-action identifier into audit forensics.
--
-- Strategy:
--   * Null the idempotency_key on scan_events older than 90 days.
--   * Keep the event row itself — audit is append-only forever.
--   * This is a SECURITY DEFINER procedure so the cron can write under a
--     system identity; the trigger never fires because we change a non-FSM
--     column.
--
-- External step: pg_cron is enabled at the Postgres extension level on this
-- project (see existing `chat_thread_migrator_cron` migration which uses it
-- for the same lifecycle pattern).

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.spatial_idempotency_cleanup()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.scan_events
  SET idempotency_key = NULL
  WHERE idempotency_key IS NOT NULL
    AND at < now() - interval '90 days';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.spatial_idempotency_cleanup()
  IS 'Spatial Core: nulls scan_events.idempotency_key entries older than 90 days. Run nightly by pg_cron job spatial_idempotency_cleanup_nightly.';

REVOKE EXECUTE ON FUNCTION public.spatial_idempotency_cleanup() FROM PUBLIC, anon, authenticated;

-- Schedule: 03:17 UTC nightly (off-peak, avoids overlap with the chat-thread
-- migrator cron which runs at 04:00 UTC).
SELECT cron.schedule(
  'spatial_idempotency_cleanup_nightly',
  '17 3 * * *',
  $cmd$ SELECT public.spatial_idempotency_cleanup(); $cmd$
);

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- SELECT cron.unschedule('spatial_idempotency_cleanup_nightly');
-- DROP FUNCTION IF EXISTS public.spatial_idempotency_cleanup();
