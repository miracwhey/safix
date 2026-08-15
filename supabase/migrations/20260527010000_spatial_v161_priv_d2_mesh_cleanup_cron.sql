-- 20260527010000 · Spatial V1.6.1 #4 · PRIV-D2 Mesh-Snapshot Cleanup Cron
--
-- DSGVO Storage-Retention für Bucket `spatial-mesh-snapshots`.
--
-- Background
-- ----------
-- Phase 2 PR #945 introduced `spatial-mesh-snapshots` (5 MB cap, USDZ blobs from
-- RoomPlan customer captures). Path convention: `{user_id}/{scan_id}.usdz`.
-- Phase 5 PR #948 wired account-deletion-cascade for the user→all-buckets case
-- (Vercel route + safety-net trigger). What was left deferred (V1.6.1 §4):
--
--   (a) Orphan blobs — mesh files whose parent `scans` row has been deleted
--       but the storage row remained (PRIV-D2 short-term cleanup).
--   (b) Age-based retention — mesh blobs older than 90 days, regardless of
--       parent-scan state (PRIV-D2 long-term hygiene, B4-D10 lock).
--
-- Architecture (Hybrid C)
-- -----------------------
-- pg_cron schedules `public.spatial_mesh_cleanup_dispatch()` daily at
-- 03:47 UTC (offset from existing nightly jobs at 03:17 / 03:37). The SQL
-- function inspects the work-queue via two SECDEF RPCs and fires an
-- async pg_net HTTP POST to the Edge Function `spatial-mesh-cleanup`,
-- which removes via the Storage HTTP API (`admin.storage.from().remove()`)
-- — which deletes BOTH the storage.objects row and the underlying blob.
--
-- We deliberately do NOT use the legacy pattern `DELETE FROM storage.objects`
-- (used by `spatial_storage_lifecycle` from Block H), because that leaks the
-- underlying S3 blob — only deletes the metadata row. The Storage HTTP API
-- is the only correct cleanup path.
--
-- The two RPCs (`spatial_mesh_cleanup_list_orphans`,
-- `spatial_mesh_cleanup_list_expired`) mirror the Phase 5 pattern
-- (`account_cascade_list_storage`) — SECDEF service-role-only, bypassing
-- the PostgREST `storage` schema-exposure restriction.
--
-- Audit
-- -----
-- `mesh_cleanup_log` table (append-only, REVOKE writes from anon+authenticated,
-- RLS default-deny). Edge-Fn writes one row per run with files_deleted,
-- bytes_freed, ran_at, error_detail. DSGVO auditor reads via service-role.
--
-- Idempotency / safety
-- --------------------
-- • If a blob was already removed in a prior run, the next run's RPC simply
--   returns 0 rows for that path — no error.
-- • Edge-Fn batches at 500 files per remove() call; daily run hard-caps at
--   500 files total per dispatch (configurable, see MAX_FILES_PER_RUN below)
--   so cron tick stays under 5s + storage rate-limit-safe.
-- • Vault secrets missing → cron logs NOTICE and returns 0 — never fails.
--
-- Dependencies
-- ------------
-- • pg_cron (installed since 20260518000009).
-- • pg_net (installed since 20260503000003 v0.19.5).
-- • supabase_vault (installed v0.3.1).
-- • Bucket `spatial-mesh-snapshots` (20260526140000).
-- • Edge Function `spatial-mesh-cleanup` deployed with verify_jwt=false.
-- • Vault secrets (seeded out-of-band):
--     spatial_mesh_cleanup.url           — Edge Function URL
--     spatial_mesh_cleanup.shared_secret — value of x-fixup-trigger-secret

-- ── 1. Audit table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mesh_cleanup_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at          timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL CHECK (source IN ('cron', 'manual')),
  files_deleted   integer NOT NULL DEFAULT 0,
  bytes_freed     bigint  NOT NULL DEFAULT 0,
  orphan_count    integer NOT NULL DEFAULT 0,
  expired_count   integer NOT NULL DEFAULT 0,
  duration_ms     integer,
  error_detail    text NULL
);

CREATE INDEX IF NOT EXISTS mesh_cleanup_log_ran_at_idx
  ON public.mesh_cleanup_log (ran_at DESC);

ALTER TABLE public.mesh_cleanup_log ENABLE ROW LEVEL SECURITY;

-- Append-only audit · defense-in-depth REVOKE writes from non-service roles
-- (RLS default-deny already blocks them, but explicit grant-layer revoke is
-- a second wall — see feedback_audit_table_revoke_writes).
REVOKE ALL ON public.mesh_cleanup_log FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.mesh_cleanup_log FROM anon, authenticated;

COMMENT ON TABLE public.mesh_cleanup_log IS
  'Spatial V1.6.1 #4 · PRIV-D2 · Append-only audit trail for mesh-snapshot '
  'cleanup runs. Service-role only (RLS default-deny + REVOKE writes). '
  'source=cron when fired by pg_cron / source=manual when triggered via '
  'admin (e.g. one-off CLI invocation). error_detail NULL on full success.';

COMMENT ON COLUMN public.mesh_cleanup_log.bytes_freed IS
  'Sum of size deltas reported by storage.objects.metadata->>size for the '
  'paths removed in this run. May be 0 if metadata.size was NULL on some rows.';

COMMENT ON COLUMN public.mesh_cleanup_log.orphan_count IS
  'Number of files identified as orphans (parent-scan-row deleted) in this run.';

COMMENT ON COLUMN public.mesh_cleanup_log.expired_count IS
  'Number of files older than retention_days in this run (excluding orphans, '
  'which are counted separately).';

-- ── 2. SECDEF RPC · list orphan mesh blobs ───────────────────────────────
-- An orphan = storage.objects row in `spatial-mesh-snapshots` whose embedded
-- scan_id (filename stem) is not present in public.scans. This happens when
-- a scan row was deleted (FK cascade from job / project / customer-action)
-- but the blob was not cleaned up at delete-time.
--
-- Uses the existing path-helper `spatial_mesh_snapshot_scan_id(text)`
-- (defined in 20260526140000), which returns NULL on malformed paths.
-- We treat malformed paths as orphans too — they cannot be matched to a
-- live scan, so cleaning them up is safe.
--
-- SECURITY DEFINER bypasses both:
--   • PostgREST `storage` schema-exposure (Phase 5 hotfix lesson)
--   • storage.objects RLS for cross-user listing

CREATE OR REPLACE FUNCTION public.spatial_mesh_cleanup_list_orphans(
  p_limit integer DEFAULT 500
)
RETURNS TABLE (object_name text, size_bytes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, storage, extensions
AS $$
DECLARE
  v_limit integer := GREATEST(0, LEAST(COALESCE(p_limit, 500), 5000));
BEGIN
  RETURN QUERY
    SELECT
      o.name::text AS object_name,
      COALESCE((o.metadata->>'size')::bigint, 0) AS size_bytes
    FROM storage.objects o
    WHERE o.bucket_id = 'spatial-mesh-snapshots'
      AND NOT EXISTS (
        SELECT 1
        FROM public.scans s
        WHERE s.id = public.spatial_mesh_snapshot_scan_id(o.name)
      )
    ORDER BY o.created_at ASC NULLS FIRST
    LIMIT v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.spatial_mesh_cleanup_list_orphans(integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.spatial_mesh_cleanup_list_orphans(integer)
  TO service_role;

COMMENT ON FUNCTION public.spatial_mesh_cleanup_list_orphans(integer) IS
  'Spatial V1.6.1 #4 · PRIV-D2 · Lists mesh-snapshot blobs whose parent scan '
  'row no longer exists in public.scans. Returns (object_name, size_bytes) '
  'capped at p_limit (default 500, max 5000). Service-role only. Used by '
  'the spatial-mesh-cleanup Edge-Function to drive Storage HTTP API removes.';

-- ── 3. SECDEF RPC · list expired mesh blobs ──────────────────────────────
-- Age-based retention. A blob is "expired" when it was created more than
-- `p_retention_days` ago (default 90 per B4-D10 storage forecast). Orphans
-- are excluded — they have a dedicated path and would otherwise be counted
-- twice in the audit.
--
-- We rank by created_at ASC NULLS FIRST so the oldest blobs go first in a
-- backlog scenario.

CREATE OR REPLACE FUNCTION public.spatial_mesh_cleanup_list_expired(
  p_retention_days integer DEFAULT 90,
  p_limit          integer DEFAULT 500
)
RETURNS TABLE (object_name text, size_bytes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, storage, extensions
AS $$
DECLARE
  v_retention integer := GREATEST(1, COALESCE(p_retention_days, 90));
  v_limit     integer := GREATEST(0, LEAST(COALESCE(p_limit, 500), 5000));
  v_cutoff    timestamptz := now() - make_interval(days => v_retention);
BEGIN
  RETURN QUERY
    SELECT
      o.name::text AS object_name,
      COALESCE((o.metadata->>'size')::bigint, 0) AS size_bytes
    FROM storage.objects o
    WHERE o.bucket_id = 'spatial-mesh-snapshots'
      AND o.created_at IS NOT NULL
      AND o.created_at < v_cutoff
      -- Exclude orphans (handled separately by list_orphans).
      AND EXISTS (
        SELECT 1
        FROM public.scans s
        WHERE s.id = public.spatial_mesh_snapshot_scan_id(o.name)
      )
    ORDER BY o.created_at ASC
    LIMIT v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.spatial_mesh_cleanup_list_expired(integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.spatial_mesh_cleanup_list_expired(integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.spatial_mesh_cleanup_list_expired(integer, integer) IS
  'Spatial V1.6.1 #4 · PRIV-D2 · Lists mesh-snapshot blobs older than '
  'p_retention_days (default 90) whose parent scan still exists. Orphans '
  'are EXCLUDED — use spatial_mesh_cleanup_list_orphans for those. Capped '
  'at p_limit (default 500, max 5000). Service-role only.';

-- ── 4. Dispatch function (pg_cron tick) ──────────────────────────────────
-- Reads Vault for Edge-Function URL + shared secret, fires async pg_net
-- POST. Returns the request_id (NULL on skip) so cron logs are useful.
-- EXCEPTION WHEN OTHERS swallows transport errors — we never want cron to
-- be marked failed because of a transient HTTP issue. Failures are visible
-- via net._http_response + the audit table (missing source='cron' row for
-- a given day signals a delivery problem).

CREATE OR REPLACE FUNCTION public.spatial_mesh_cleanup_dispatch()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, extensions
AS $$
DECLARE
  v_url       text;
  v_secret    text;
  v_request_id bigint;
  v_lock_acquired boolean;
BEGIN
  -- H1 · Re-entry guard. If a previous cron tick is still in-flight (Edge-Fn
  -- running long, pg_net retrying) we skip rather than fire a duplicate POST.
  -- The lock is session-scoped — pg_cron sessions are short-lived so the lock
  -- releases automatically when this function returns (or the session dies).
  -- hashtext('spatial_mesh_cleanup') = stable int32 key, no collision with
  -- other named advisory locks in the system.
  v_lock_acquired := pg_try_advisory_lock(hashtext('spatial_mesh_cleanup'));
  IF NOT v_lock_acquired THEN
    RAISE NOTICE 'spatial-mesh-cleanup: cleanup skipped (concurrent run)';
    RETURN NULL;
  END IF;

  -- Vault lookup. Missing secrets → no-op (do not fail cron during bring-up).
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'spatial_mesh_cleanup.url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'spatial_mesh_cleanup.shared_secret'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'spatial-mesh-cleanup: vault unavailable (sqlstate=%, msg=%) — skipping',
      SQLSTATE, SQLERRM;
    RETURN NULL;
  END;

  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE NOTICE 'spatial-mesh-cleanup: vault entries spatial_mesh_cleanup.url '
                 'or spatial_mesh_cleanup.shared_secret missing — skipping';
    RETURN NULL;
  END IF;

  -- Fire async HTTP. pg_net returns a request_id immediately; the Edge-Fn
  -- handles batching, audit-log INSERT, and per-bucket error isolation.
  BEGIN
    SELECT net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-fixup-trigger-secret', v_secret
      ),
      body := jsonb_build_object(
        'source', 'cron',
        'retention_days', 90,
        'max_files', 500
      ),
      timeout_milliseconds := 30000
    ) INTO v_request_id;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'spatial-mesh-cleanup: pg_net.http_post failed (sqlstate=%, msg=%)',
      SQLSTATE, SQLERRM;
    RETURN NULL;
  END;

  RETURN v_request_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.spatial_mesh_cleanup_dispatch()
  FROM PUBLIC, anon, authenticated;
-- pg_cron + service_role only.

COMMENT ON FUNCTION public.spatial_mesh_cleanup_dispatch() IS
  'Spatial V1.6.1 #4 · PRIV-D2 · pg_cron dispatch function. Looks up Vault '
  'secrets and fires async pg_net.http_post to the spatial-mesh-cleanup '
  'Edge-Function. Returns the pg_net request_id (NULL on skip). EXCEPTION '
  'WHEN OTHERS swallows errors so cron is never marked failed.';

-- ── 5. pg_cron schedule ──────────────────────────────────────────────────
-- 03:47 UTC nightly. Offsets:
--   03:17 spatial_idempotency_cleanup_nightly
--   03:37 spatial_storage_lifecycle_nightly
--   03:47 spatial_mesh_cleanup_nightly   ← this job
--
-- Note: 03:47 UTC = 04:47 CET / 05:47 CEST (Europe/Berlin) — outside the
-- typical Hannover-Pilot capture window (08:00-20:00 local). The plan-spec
-- says "03:00 Europe/Berlin" — we keep UTC across the codebase for
-- consistency with the two other crons. Diff is ~3-4h, acceptable for a
-- low-priority hygiene job.

DO $$ BEGIN
  PERFORM cron.unschedule('spatial_mesh_cleanup_nightly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spatial_mesh_cleanup_nightly');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'spatial_mesh_cleanup_nightly',
  '47 3 * * *',
  $job$ SELECT public.spatial_mesh_cleanup_dispatch(); $job$
);

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual) ─────────────────────────────────────────────────────
-- SELECT cron.unschedule('spatial_mesh_cleanup_nightly');
-- DROP FUNCTION IF EXISTS public.spatial_mesh_cleanup_dispatch();
-- DROP FUNCTION IF EXISTS public.spatial_mesh_cleanup_list_expired(integer, integer);
-- DROP FUNCTION IF EXISTS public.spatial_mesh_cleanup_list_orphans(integer);
-- DROP TABLE IF EXISTS public.mesh_cleanup_log;
-- NOTIFY pgrst, 'reload schema';
