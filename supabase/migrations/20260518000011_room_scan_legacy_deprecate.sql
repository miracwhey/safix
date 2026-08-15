-- Spatial Core · Block B.4 · Deprecate legacy projects.room_scan_* columns
--
-- Pre-check 2026-05-17 via Supabase MCP:
--   SELECT count(*) FROM public.projects WHERE room_scan_url IS NOT NULL  → 0
--   SELECT count(*) FROM public.projects WHERE room_scan_metadata IS NOT NULL → 0
--
-- 0 real rows means no backfill is required. We only mark the columns as
-- deprecated so that any future reader sees the contract. Physical DROP is
-- scheduled for a separate post-V1-ship cleanup migration, to give a one-release
-- deprecation buffer for any unknown out-of-tree consumer.
--
-- New SoT: public.scans + public.scan_assets (Block A schema, migration 000002).

COMMENT ON COLUMN public.projects.room_scan_url IS
  'DEPRECATED 2026-05-17 (Spatial Block B): superseded by public.scans + public.scan_assets. '
  '0 rows at deprecation time. Will be dropped in a post-V1 cleanup migration.';

COMMENT ON COLUMN public.projects.room_scan_metadata IS
  'DEPRECATED 2026-05-17 (Spatial Block B): superseded by public.scans.device_meta + '
  'public.scan_quality_reports. 0 rows at deprecation time. Will be dropped in a '
  'post-V1 cleanup migration.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- COMMENT ON COLUMN public.projects.room_scan_url IS NULL;
-- COMMENT ON COLUMN public.projects.room_scan_metadata IS NULL;
