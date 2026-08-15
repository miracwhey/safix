-- Spatial Core · Post-Review P0 Fixes — Part 2 (consolidated batch)
--
-- Addresses the P0/P1 findings from the 6-subagent hard review.
-- Depends on migration 71 (scan_event_action +'download_requested').
--
-- Scope:
--   1. FSM edges  capturing→archived, draft→archived, captured→archived
--      (closes data-loss path in captureScan recovery).
--   2. spatial_scan_storage_path_ok  +photo +voice +export kinds (currently
--      photo/voice are RLS-rejected silently; Block F non-functional in prod).
--   3. project-scans bucket MIME allowlist  +audio/* +image/jpeg/heic +pdf.
--   4. spatial_can_view_scan  captured_by-grant gated to draft|capturing
--      (prevents post-reassignment cross-tenant leak).
--   5. request_scan_download  uses new enum value, no longer corrupts audit.
--   6. resign_download_url  scoped to requested_by only + 5/hour rate-limit
--      + collapsed error-codes (no IDOR oracle).
--   7. download_jobs.storage_path  CHECK constraint  (path-shape lockdown).
--   8. download_jobs  stuck-pending reaper cron (30min → failed).
--   9. scans delete  trigger purges storage subtree (DSGVO Art.17 alignment).

-- ── 1. FSM edges for capture-failure recovery + abort ────────────────────

INSERT INTO public.scan_status_transition_allowed (from_status, to_status) VALUES
  ('draft',     'archived'),
  ('capturing', 'archived'),
  ('captured',  'archived')
ON CONFLICT DO NOTHING;

-- ── 2. storage_path_ok — photo + voice + export extension ────────────────

CREATE OR REPLACE FUNCTION public.spatial_scan_storage_path_ok(p_name text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  v_parts text[];
  v_kind  text;
  v_file  text;
  v_lower text;
BEGIN
  IF position('..' in p_name) <> 0 THEN
    RETURN false;
  END IF;

  v_parts := storage.foldername(p_name);
  IF array_length(v_parts, 1) IS NULL OR array_length(v_parts, 1) < 3 THEN
    RETURN false;
  END IF;

  v_kind := v_parts[3];
  v_file := substring(p_name from '[^/]+$');
  v_lower := lower(coalesce(v_file, ''));

  RETURN CASE v_kind
    WHEN 'usdz'          THEN v_lower LIKE '%.usdz'
    WHEN 'gltf'          THEN v_lower LIKE '%.glb' OR v_lower LIKE '%.gltf'
    WHEN 'scan_json'     THEN v_lower LIKE '%.json'
    WHEN 'mesh_summary'  THEN v_lower LIKE '%.json'
    WHEN 'thumbnail'     THEN v_lower LIKE '%.png' OR v_lower LIKE '%.jpg' OR v_lower LIKE '%.jpeg' OR v_lower LIKE '%.webp'
    WHEN 'floorplan_svg' THEN v_lower LIKE '%.svg'
    WHEN 'worldmap'      THEN v_lower LIKE '%.bin'
    WHEN 'photo'         THEN v_lower LIKE '%.jpg' OR v_lower LIKE '%.jpeg' OR v_lower LIKE '%.png' OR v_lower LIKE '%.webp' OR v_lower LIKE '%.heic'
    WHEN 'voice'         THEN v_lower LIKE '%.m4a' OR v_lower LIKE '%.aac' OR v_lower LIKE '%.mp4' OR v_lower LIKE '%.webm' OR v_lower LIKE '%.wav'
    WHEN 'export'        THEN v_lower LIKE '%.pdf' OR v_lower LIKE '%.svg' OR v_lower LIKE '%.json'
    ELSE false
  END;
END;
$$;

-- ── 3. Bucket MIME + size: add audio/* + image/jpeg/heic + pdf ───────────

UPDATE storage.buckets
SET
  allowed_mime_types = ARRAY[
    'model/vnd.usdz+zip',
    'model/gltf+json',
    'model/gltf-binary',
    'application/json',
    'application/pdf',
    'image/svg+xml',
    'image/png',
    'image/webp',
    'image/jpeg',
    'image/heic',
    'image/heif',
    'audio/mp4',
    'audio/aac',
    'audio/webm',
    'audio/x-m4a',
    'audio/mpeg',
    'audio/wav',
    'application/octet-stream'
  ]
WHERE id = 'project-scans';

-- ── 4. spatial_can_view_scan — gate captured_by to active capture phase ──

CREATE OR REPLACE FUNCTION public.spatial_can_view_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.jobs     j ON j.id = s.job_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR j.craftsman_user_id = p_uid::text
          OR j.customer_user_id  = p_uid
          OR EXISTS (
            SELECT 1
            FROM public.job_assignments ja
            JOIN public.team_members    tm ON tm.id = ja.team_member_id
            WHERE ja.job_id        = s.job_id
              AND tm.profile_id    = p_uid
              AND tm.is_active     = true
              AND ja.status        IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
          )
          -- Captured-by: only during the active capture phase. After capture
          -- finishes, view-access continues via role-based paths above.
          -- Prevents post-reassignment cross-tenant leak.
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
        )
    );
$$;

-- ── 5. request_scan_download — use new enum, no audit hijack ─────────────

CREATE OR REPLACE FUNCTION public.request_scan_download(
  p_scan_id uuid,
  p_kind    text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.spatial_can_view_scan(p_scan_id, v_uid) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('pdf_report','floorplan_svg','mesh_summary_json') THEN
    RAISE EXCEPTION 'invalid download kind: %', p_kind USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.download_jobs (scan_id, requested_by, kind)
  VALUES (p_scan_id, v_uid, p_kind)
  RETURNING id INTO v_id;

  PERFORM pg_notify('download_jobs', v_id::text);

  PERFORM public.record_scan_event(
    p_scan_id,
    'download_requested'::public.scan_event_action,
    jsonb_build_object(
      'download_job_id', v_id,
      'kind', p_kind
    ),
    NULL,
    v_uid
  );

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.request_scan_download(uuid, text) TO authenticated;

-- ── 6. resign_download_url — scope + rate-limit + uniform error ──────────

CREATE OR REPLACE FUNCTION public.resign_download_url(
  p_job_id uuid
)
RETURNS public.download_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_job public.download_jobs;
  v_recent_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Scope strictly to the requester. Collapses not-found/not-permitted into
  -- a single error so this function does not double as an existence-oracle.
  SELECT * INTO v_job
  FROM public.download_jobs
  WHERE id = p_job_id AND requested_by = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  -- Rate-limit: max 5 resigns per job per hour, counted by audit events.
  SELECT count(*) INTO v_recent_count
  FROM public.scan_events
  WHERE scan_id = v_job.scan_id
    AND action  = 'download_requested'::public.scan_event_action
    AND actor_id = v_uid
    AND occurred_at > now() - interval '1 hour'
    AND payload ->> 'phase' = 'resign'
    AND (payload ->> 'download_job_id')::uuid = p_job_id;

  IF v_recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = '54000';
  END IF;

  UPDATE public.download_jobs
  SET expires_at = now() + interval '15 minutes'
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  PERFORM public.record_scan_event(
    v_job.scan_id,
    'download_requested'::public.scan_event_action,
    jsonb_build_object(
      'phase', 'resign',
      'download_job_id', p_job_id
    ),
    NULL,
    v_uid
  );

  RETURN v_job;
END $$;

GRANT EXECUTE ON FUNCTION public.resign_download_url(uuid) TO authenticated;

-- ── 7. download_jobs.storage_path — CHECK constraint (path shape) ────────

ALTER TABLE public.download_jobs
  DROP CONSTRAINT IF EXISTS download_jobs_storage_path_chk;

ALTER TABLE public.download_jobs
  ADD CONSTRAINT download_jobs_storage_path_chk
  CHECK (
    storage_path IS NULL
    OR (
      storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/export/'
      AND position('..' in storage_path) = 0
    )
  );

-- ── 8. download_jobs reaper cron ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.spatial_reap_stuck_download_jobs()
RETURNS TABLE (failed int, deleted int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_failed  int := 0;
  v_deleted int := 0;
BEGIN
  WITH up AS (
    UPDATE public.download_jobs
    SET status = 'failed',
        error_message = COALESCE(error_message, 'reaper: stuck > timeout'),
        completed_at  = now()
    WHERE (status = 'pending'    AND requested_at < now() - interval '30 minutes')
       OR (status = 'processing' AND requested_at < now() - interval '60 minutes')
    RETURNING 1
  )
  SELECT count(*) INTO v_failed FROM up;

  WITH del AS (
    DELETE FROM public.download_jobs
    WHERE status IN ('ready','failed')
      AND requested_at < now() - interval '7 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM del;

  RETURN QUERY SELECT v_failed, v_deleted;
END $$;

REVOKE EXECUTE ON FUNCTION public.spatial_reap_stuck_download_jobs() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spatial_reap_stuck_download_jobs() FROM anon;
REVOKE EXECUTE ON FUNCTION public.spatial_reap_stuck_download_jobs() FROM authenticated;

DO $$ BEGIN
  PERFORM cron.unschedule('spatial_reap_stuck_download_jobs')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'spatial_reap_stuck_download_jobs');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'spatial_reap_stuck_download_jobs',
  '*/15 * * * *',
  $job$ SELECT public.spatial_reap_stuck_download_jobs(); $job$
);

-- ── 9. scan-delete trigger purges storage subtree (DSGVO) ────────────────

CREATE OR REPLACE FUNCTION public.spatial_purge_scan_storage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := OLD.captured_by;
  v_prefix  text;
BEGIN
  IF v_user_id IS NULL THEN
    DELETE FROM storage.objects
    WHERE bucket_id = 'project-scans'
      AND name LIKE '%/' || OLD.id::text || '/%';
    RETURN OLD;
  END IF;

  v_prefix := v_user_id::text || '/' || OLD.id::text || '/';
  DELETE FROM storage.objects
  WHERE bucket_id = 'project-scans'
    AND name LIKE v_prefix || '%';

  RETURN OLD;
END $$;

REVOKE EXECUTE ON FUNCTION public.spatial_purge_scan_storage() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spatial_purge_scan_storage() FROM anon;
REVOKE EXECUTE ON FUNCTION public.spatial_purge_scan_storage() FROM authenticated;

DROP TRIGGER IF EXISTS scans_purge_storage_after_delete ON public.scans;
CREATE TRIGGER scans_purge_storage_after_delete
  AFTER DELETE ON public.scans
  FOR EACH ROW
  EXECUTE FUNCTION public.spatial_purge_scan_storage();

COMMENT ON FUNCTION public.spatial_purge_scan_storage IS
  'P0 review fix — scan DELETE cascades to storage subtree {captured_by}/{scan_id}/*. Aligns Photo+Voice+thumbnail with 90d privacy promise.';
