-- Spatial Core · Block I.4 · download-job RPCs
--
-- Two SECURITY DEFINER entries:
--   1. `request_scan_download(scan_id, kind)` — single legal INSERT path.
--      Enforces the spatial_can_view_scan invariant + raises insufficient
--      privilege when the caller is unauthorised.
--   2. `resign_download_url(job_id)` — placeholder that bumps the
--      `expires_at` window so a signed URL can be re-issued by the client.
--      The actual signed URL itself is minted on the client side via the
--      Supabase storage SDK; this function only proves the requester is
--      still allowed and refreshes the TTL audit field.
--
-- Rate-limit on resign is enforced at the app layer (5/job/hour) — the
-- hard ceiling per master plan F.I.5 risk note.

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
    RAISE EXCEPTION 'scan not visible to caller' USING ERRCODE = '42501';
  END IF;
  IF p_kind NOT IN ('pdf_report','floorplan_svg','mesh_summary_json') THEN
    RAISE EXCEPTION 'invalid download kind: %', p_kind USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.download_jobs (scan_id, requested_by, kind)
  VALUES (p_scan_id, v_uid, p_kind)
  RETURNING id INTO v_id;

  -- Notify the Cloud Run worker via pg_notify — the listener turns the
  -- channel name into an HTTP POST to spatial-export-worker.
  PERFORM pg_notify('download_jobs', v_id::text);

  -- Audit event on the parent scan so the lifecycle is visible alongside
  -- the rest of the spatial domain timeline.
  PERFORM public.record_scan_event(
    p_scan_id,
    'archived'::scan_event_action,  -- closest existing action enum value
    jsonb_build_object(
      'phase', 'download_requested',
      'download_job_id', v_id,
      'kind', p_kind
    ),
    NULL,
    v_uid
  );

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.request_scan_download(uuid, text) TO authenticated;

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
BEGIN
  SELECT * INTO v_job FROM public.download_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'download job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.requested_by <> v_uid
     AND NOT public.spatial_can_view_scan(v_job.scan_id, v_uid)
  THEN
    RAISE EXCEPTION 'download not visible to caller' USING ERRCODE = '42501';
  END IF;
  -- Bump the expires_at audit field; client mints a fresh signed URL via
  -- supabase.storage.createSignedUrl after this RPC returns.
  UPDATE public.download_jobs
  SET expires_at = now() + interval '15 minutes'
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  RETURN v_job;
END $$;

GRANT EXECUTE ON FUNCTION public.resign_download_url(uuid) TO authenticated;
