-- Spatial Canonical · Phase 3 · Block 3.11 · VF-4 Verify-Reminder Scheduler
--
-- Purpose:
--   src/lib/spatial/workflow/verifyReminder.ts is the PURE decision layer for
--   the VF-4 customer-verify reminder cadence (24h push / 72h email). It
--   DECIDES which reminder is due per scene but, by design, neither scans nor
--   schedules. This migration is the missing time-driven half: an hourly
--   pg_cron job + the SECURITY DEFINER function it calls.
--
--   spatial_verify_reminder_tick():
--     1. Scans spatial_scenes for an unfinished customer-verify
--        (customer_verify_state IN not_started | in_progress) whose
--        customer_verify_last_active_at is >= 24h old.
--     2. Per scene, ports resolveVerifyReminderChannel: >=72h -> 'email',
--        24-72h -> 'push', with the verifyReminder.ts de-dup — a channel
--        already sent for the current activity anchor is suppressed; customer
--        activity newer than the last reminder restarts the cadence.
--     3. Emits a notification_signals row (the job-scoped FixUp push pipeline)
--        and advances the customer_verify_last_reminder_* de-dup columns
--        (added in 20260520120040).
--
-- Why pg_cron + plpgsql, not an Edge Function:
--   The job needs no HTTP and no external transport — it is a pure DB scan +
--   notification_signals INSERT. This mirrors the established Spatial-Core
--   cron pattern (20260518000040 spatial_storage_lifecycle) exactly: one
--   SECURITY DEFINER function, one cron.schedule. An Edge Function would add
--   HMAC + a separate deploy surface for zero benefit.
--
-- Channel / transport reality (honest scope note):
--   verifyReminder.ts tags the 72h escalation 'email'. FixUp currently has NO
--   email-sending transport — notification_signals (in-app + APNs push) is the
--   only delivery surface. The 'email' reminder is therefore delivered through
--   the same notification_signals surface as the 'push' one; the channel is
--   still recorded in customer_verify_last_reminder_channel so the de-dup is
--   exact and a future email-transport upgrade is a clean swap. A dedicated
--   email escalation is a separate prerequisite, not part of this scheduler.
--
--   The notification_signals pipeline is job-scoped (job_id NOT NULL). A scene
--   with a source_job_id gets the signal; a scan-only scene advances its
--   de-dup cadence without a signal (the customer still sees the verify state
--   in-app on next open — push is the convenience layer, matching the
--   spatial-convert-done edge function's project-only-scan behaviour).
--
--   notification_signals.type 'spatial_verify_reminder' has no PUSH_ROUTE_MAP
--   entry yet — customer deep-routes are a documented schema-extension block
--   (src/lib/notifications/pushRouteMap.ts header). Until then the push routes
--   to default-home; the in-app notification still surfaces. The route entry
--   lands with the productive customer-notification wiring.
--
-- Plan reference: spatial-v1-verify-flow-implementation-spec.md §3.11 (VF-4).

-- ── Function: spatial_verify_reminder_tick ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.spatial_verify_reminder_tick()
RETURNS TABLE (reminders_due int, signals_emitted int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_due       int := 0;
  v_emitted   int := 0;
  v_channel   text;
  v_elapsed   interval;
  r_scene     record;
BEGIN
  FOR r_scene IN
    SELECT s.id                                    AS scene_id,
           s.source_job_id                         AS source_job_id,
           s.customer_verify_last_active_at         AS last_active_at,
           s.customer_verify_last_reminder_sent_at  AS last_reminder_sent_at,
           s.customer_verify_last_reminder_channel  AS last_reminder_channel
    FROM public.spatial_scenes s
    WHERE s.customer_verify_state IN ('not_started','in_progress')
      AND s.customer_verify_last_active_at IS NOT NULL
      AND now() - s.customer_verify_last_active_at >= interval '24 hours'
      -- A scene whose source scan is locked for dispute is not nudged.
      AND (s.source_scan_id IS NULL OR NOT public.spatial_scan_is_locked(s.source_scan_id))
  LOOP
    -- ── resolveVerifyReminderChannel — time-driven channel ──────────────────
    v_elapsed := now() - r_scene.last_active_at;
    IF v_elapsed >= interval '72 hours' THEN
      v_channel := 'email';
    ELSE
      v_channel := 'push';
    END IF;

    -- ── de-dup — suppress a channel already sent for this activity anchor ───
    -- Activity newer than the last reminder restarts the cadence; an unchanged
    -- anchor with the same channel already sent is a duplicate.
    IF r_scene.last_reminder_channel IS NOT NULL
       AND r_scene.last_reminder_sent_at IS NOT NULL
       AND r_scene.last_active_at <= r_scene.last_reminder_sent_at
       AND r_scene.last_reminder_channel = v_channel THEN
      CONTINUE;
    END IF;

    v_due := v_due + 1;

    BEGIN
      -- Emit the notification signal (job-scoped pipeline). A scene with no
      -- source_job_id cannot carry the NOT NULL job_id FK — its cadence still
      -- advances below so the de-dup stays correct.
      IF r_scene.source_job_id IS NOT NULL THEN
        INSERT INTO public.notification_signals
          (job_id, type, priority, read, occurred_at,
           recipient_role, entity_id, entity_type, action_type)
        VALUES
          (r_scene.source_job_id, 'spatial_verify_reminder', 'low', false,
           (extract(epoch FROM now()) * 1000)::bigint,
           'customer', r_scene.scene_id::text, 'spatial_scene', 'open_verify');
        v_emitted := v_emitted + 1;
      END IF;

      -- Advance the VF-4 de-dup cadence (migration 20260520120040 columns).
      UPDATE public.spatial_scenes
         SET customer_verify_last_reminder_sent_at = now(),
             customer_verify_last_reminder_channel = v_channel
       WHERE id = r_scene.scene_id;
    EXCEPTION WHEN OTHERS THEN
      -- A scene that raced into a dispute-lock / FSM edge between the scan and
      -- the write — skip it; the next hourly tick re-evaluates cleanly.
      CONTINUE;
    END;
  END LOOP;

  RETURN QUERY SELECT v_due, v_emitted;
END;
$$;

COMMENT ON FUNCTION public.spatial_verify_reminder_tick() IS
  'Spatial Canonical Block 3.11 (VF-4): hourly verify-reminder scheduler. Scans '
  'spatial_scenes for an unfinished customer-verify idle >= 24h, ports '
  'verifyReminder.ts resolveVerifyReminderChannel (24h push / 72h email + de-dup), '
  'emits a notification_signals row and advances the customer_verify_last_reminder_* '
  'columns. SECURITY DEFINER — cron-invoked only.';

-- cron + operators only — no authenticated/anon EXECUTE (matches spatial_storage_lifecycle).
REVOKE EXECUTE ON FUNCTION public.spatial_verify_reminder_tick() FROM PUBLIC, anon, authenticated;

-- ── pg_cron schedule ──────────────────────────────────────────────────────────
-- Hourly at minute 7 — offset from the nightly spatial jobs (03:17 / 03:37).
DO $$ BEGIN
  PERFORM cron.unschedule('spatial_verify_reminder_hourly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spatial_verify_reminder_hourly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'spatial_verify_reminder_hourly',
  '7 * * * *',
  $job$ SELECT public.spatial_verify_reminder_tick(); $job$
);

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- SELECT cron.unschedule('spatial_verify_reminder_hourly');
-- DROP FUNCTION IF EXISTS public.spatial_verify_reminder_tick();
