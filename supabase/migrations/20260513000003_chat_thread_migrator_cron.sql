-- =============================================================================
-- Block D Slice 1 Phase 1a — Cron-Trigger für chat-thread-migrator batch mode
-- =============================================================================
-- Pattern: pg_cron + pg_net.http_post → Edge-Function `chat-thread-migrator`
-- Frequency: alle 5 Minuten (Batch-Background)
-- Lazy-On-Access wird vom App-Code (chat.service.enqueueLazyMigration) getriggert.
-- Edge-Fn akzeptiert POST ohne Auth (verify_jwt=false; Slice 2 Hardening folgt).
--
-- Apply: 2026-05-10 via mcp__claude_ai_Supabase__apply_migration
-- Status: live in Prod, jobid=1, active=true
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
DECLARE
  existing_jobid bigint;
BEGIN
  SELECT jobid INTO existing_jobid FROM cron.job WHERE jobname = 'chat-thread-migrator-batch';
  IF existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(existing_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'chat-thread-migrator-batch',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://itdntawwuzqfwmcwnwjr.supabase.co/functions/v1/chat-thread-migrator',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"mode":"batch","batchSize":20}'::jsonb
  ) AS request_id;
  $cron$
);
