-- Spatial Core · Block H · Storage Lifecycle pg_cron Job
--
-- Reclaims storage for scans that were explicitly archived and have aged
-- past the 90-day retention floor. Deletes the underlying `storage.objects`
-- rows AND the matching `scan_assets` rows in the same transaction so a
-- partial failure cannot leave dangling references.
--
-- Worldmap assets (D2 Layer 3, ARWorldMap blobs) are excluded — they are
-- the only signal a future re-scan has for restoring AR anchor stability,
-- so they are retained even past archive + 90d. Dispute-locked scans are
-- excluded by status (FSM enforces that lock-status reverts only via a
-- legal walk, never silently).
--
-- Idempotency: every run picks a fresh slice of expired rows. Deleting an
-- already-deleted storage.objects row is a no-op (no row matched). Batch
-- size capped at 200 per run to keep the cron tick under 5s; the job
-- re-runs nightly and naturally catches up on backlog.
--
-- Auditing: each lifecycle run is logged to `scan_events` via the existing
-- SECURITY DEFINER `record_scan_event` RPC with action 'archived' + a
-- 'lifecycle_cleanup' payload so the audit trail shows when storage was
-- actually freed.

CREATE OR REPLACE FUNCTION public.spatial_storage_lifecycle()
RETURNS TABLE (deleted_objects int, deleted_asset_rows int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted_objs    int := 0;
  v_deleted_rows    int := 0;
  v_batch_size      int := 200;
  v_retention_days  int := 90;
  r_asset           record;
BEGIN
  FOR r_asset IN
    SELECT sa.id           AS asset_id,
           sa.scan_id      AS scan_id,
           sa.storage_path AS storage_path
    FROM public.scan_assets sa
    JOIN public.scans s ON s.id = sa.scan_id
    WHERE s.status = 'archived'
      AND s.archived_at IS NOT NULL
      AND s.archived_at < now() - make_interval(days => v_retention_days)
      AND sa.kind <> 'worldmap'
    LIMIT v_batch_size
  LOOP
    -- Storage row delete. The storage.objects RLS policies allow only the
    -- uploader / operator to delete; SECURITY DEFINER bypasses that.
    DELETE FROM storage.objects
    WHERE bucket_id = 'project-scans' AND name = r_asset.storage_path;
    GET DIAGNOSTICS v_deleted_objs = ROW_COUNT;

    -- Domain row delete. We don't rely on FK cascade because there is no
    -- FK from scan_assets to storage.objects — the path is just a string.
    DELETE FROM public.scan_assets WHERE id = r_asset.asset_id;
    GET DIAGNOSTICS v_deleted_rows = ROW_COUNT;

    -- Append audit so the lifecycle action is visible per-scan in scan_events.
    PERFORM public.record_scan_event(
      r_asset.scan_id,
      'archived'::public.scan_event_action,
      jsonb_build_object(
        'phase',       'lifecycle_cleanup',
        'storagePath', r_asset.storage_path,
        'retentionDays', v_retention_days
      ),
      NULL
    );
  END LOOP;

  RETURN QUERY SELECT v_deleted_objs, v_deleted_rows;
END;
$$;

COMMENT ON FUNCTION public.spatial_storage_lifecycle()
  IS 'Spatial Core: nightly lifecycle for scan_assets — deletes storage objects + asset rows for archived scans older than 90d. Skips worldmap assets (re-scan AR anchor restore). SECURITY DEFINER.';

REVOKE EXECUTE ON FUNCTION public.spatial_storage_lifecycle() FROM PUBLIC, anon, authenticated;
-- Only pg_cron + operators run this manually — no GRANT to authenticated.

-- ── pg_cron schedule ──────────────────────────────────────────────────────────
-- 03:37 UTC, deliberately offset from spatial_idempotency_cleanup_nightly (03:17).
DO $$ BEGIN
  PERFORM cron.unschedule('spatial_storage_lifecycle_nightly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spatial_storage_lifecycle_nightly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'spatial_storage_lifecycle_nightly',
  '37 3 * * *',
  $job$ SELECT public.spatial_storage_lifecycle(); $job$
);

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- SELECT cron.unschedule('spatial_storage_lifecycle_nightly');
-- DROP FUNCTION IF EXISTS public.spatial_storage_lifecycle();
