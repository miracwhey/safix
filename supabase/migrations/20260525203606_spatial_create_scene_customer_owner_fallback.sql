-- Spatial CAD Lane V1.5.1 · M0 · spatial_create_scene Customer-Owner-Fallback
--
-- Bug:
--   spatial_create_scene (14-param B1+B7 signature from 20260522120054_spatial_
--   scene_versioning) Step 9 derives v_customer_id from either
--   project.customer_user_id (scan-origin) or job.customer_user_id (job-origin).
--   Customer Self-Scan (Lane 3 Block 1 — owner_type='customer') legitimately
--   has BOTH project_id=NULL AND job_id=NULL — the relaxed
--   scans_owner_anchor_chk allows it. The RPC therefore inserts a scene
--   with customer_id=NULL, leaving the Self-Scan orphaned for any list/hub
--   query that filters on spatial_scenes.customer_id directly.
--
-- Fix:
--   Step 9 extended with a Customer-Self-Scan fallback: after the project +
--   job lookups, if v_customer_id is still NULL AND the source scan is
--   owner_type='customer', fall back to scans.captured_by. The scan SELECT
--   now also reads scans.captured_by + scans.owner_type into two new local
--   variables so we don't re-query the row.
--
-- Signature: unchanged 14-param B1+B7 (p_id, p_parametric_storage_path,
--   p_parametric_sha256, p_parametric_size_bytes, p_source_scan_id,
--   p_source_job_id, p_schema_version, p_validation_state, p_validation_report,
--   p_is_renderable, p_requires_user_confirmation, p_metadata,
--   p_parent_scene_id, p_rescan_request_id). Body-only CREATE OR REPLACE —
--   no DROP, no re-grant, no permissions delta. Re-scan-request linkage
--   (Step 4 + Step 13) and parent-scene authorization (Step 7) preserved
--   bit-for-bit from 20260522120054.
--
-- Append-only convention: this migration supersedes the Step-9 logic in
-- 20260522120054. The earlier file remains in place per append-only rules;
-- this file is the canonical body.
--
-- Schema facts (verified read-only against prod 2026-05-25):
--   - scans.owner_type text NOT NULL DEFAULT 'craftsman' (Block 1 schema)
--   - scans.captured_by uuid (existing pre-Lane-3 column)
--   - scans_owner_anchor_chk allows job_id=NULL + project_id=NULL when
--     owner_type='customer' (Block 1 schema migration).
--
-- External steps:
--   1. Supabase Dashboard → Settings → API → Reload schema cache.
--   No env vars, no edge-function deploy, no webhook changes.
--
-- Plan reference: ~/.claude/plans/mockups/spatial-v151/00-INDEX.md M0
--                 ~/.claude/plans/spatial-cad-lane-handover.md §4.0

CREATE OR REPLACE FUNCTION public.spatial_create_scene(
  p_id                         uuid,
  p_parametric_storage_path    text,
  p_parametric_sha256          text    DEFAULT NULL,
  p_parametric_size_bytes      integer DEFAULT NULL,
  p_source_scan_id             uuid    DEFAULT NULL,
  p_source_job_id              uuid    DEFAULT NULL,
  p_schema_version             text    DEFAULT '1.0',
  p_validation_state           text    DEFAULT 'pending',
  p_validation_report          jsonb   DEFAULT '{}'::jsonb,
  p_is_renderable              boolean DEFAULT false,
  p_requires_user_confirmation boolean DEFAULT false,
  p_metadata                   jsonb   DEFAULT '{}'::jsonb,
  p_parent_scene_id            uuid    DEFAULT NULL,
  p_rescan_request_id          uuid    DEFAULT NULL
)
RETURNS public.spatial_scenes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_scene            public.spatial_scenes;
  v_effective_job_id uuid;
  v_customer_id      uuid;
  v_capture_uid      uuid;
  v_owner_type       text;
  v_provider_org_id  uuid;
  v_provider_user_id uuid;
  v_authorized       boolean := false;
  v_req_status       text;
  v_req_scene_id     uuid;
  v_req_resulting    uuid;
  v_parent_customer  uuid;
  v_effective_parent uuid := p_parent_scene_id;
BEGIN
  -- 1. Must be authenticated.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: authentication required'
      USING ERRCODE = '28000';
  END IF;

  -- 2. Required inputs.
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'spatial_create_scene: p_id is required (client-generated scene uuid)'
      USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_parametric_storage_path, '') = '' THEN
    RAISE EXCEPTION 'spatial_create_scene: p_parametric_storage_path is required'
      USING ERRCODE = '22023';
  END IF;

  -- 3. Origin check (mirrors the spatial_scenes_origin_chk constraint):
  --    at least one of source_scan_id / source_job_id must be set.
  IF p_source_scan_id IS NULL AND p_source_job_id IS NULL THEN
    RAISE EXCEPTION
      'spatial_create_scene: source_scan_id OR source_job_id required (R4)'
      USING ERRCODE = '22023';
  END IF;

  -- 4. Re-scan-request linkage (D2 · B7). Preserved verbatim from 20260522120054.
  IF p_rescan_request_id IS NOT NULL THEN
    SELECT r.status, r.scene_id, r.resulting_scene_id
      INTO v_req_status, v_req_scene_id, v_req_resulting
      FROM public.spatial_rescan_requests r
      WHERE r.id = p_rescan_request_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'spatial_create_scene: rescan_request % not found', p_rescan_request_id
        USING ERRCODE = '22023';
    END IF;

    IF v_req_resulting IS NOT NULL THEN
      SELECT *
        INTO v_scene
        FROM public.spatial_scenes
        WHERE id = v_req_resulting;
      IF FOUND THEN
        RETURN v_scene;
      END IF;
    END IF;

    IF v_req_status <> 'accepted' THEN
      RAISE EXCEPTION
        'spatial_create_scene: rescan_request status must be accepted (got %)',
        v_req_status
        USING ERRCODE = '22023';
    END IF;

    IF v_effective_parent IS NULL THEN
      v_effective_parent := v_req_scene_id;
    ELSIF v_effective_parent IS DISTINCT FROM v_req_scene_id THEN
      RAISE EXCEPTION
        'spatial_create_scene: parent_scene_id must match rescan_request.scene_id'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 5. Idempotency pre-check: one scan → one scene.
  IF p_source_scan_id IS NOT NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
    IF FOUND THEN
      RETURN v_scene;
    END IF;
  END IF;

  -- 6. Resolve the effective job.
  v_effective_job_id := p_source_job_id;
  IF v_effective_job_id IS NULL AND p_source_scan_id IS NOT NULL THEN
    SELECT s.job_id INTO v_effective_job_id
      FROM public.scans s
      WHERE s.id = p_source_scan_id;
  END IF;

  -- 7. Parent-scene authorization (D2 · B7). Preserved verbatim.
  IF v_effective_parent IS NOT NULL THEN
    IF p_rescan_request_id IS NOT NULL THEN
      SELECT s.customer_id
        INTO v_parent_customer
        FROM public.spatial_scenes s
        WHERE s.id = v_effective_parent;
      IF v_parent_customer IS NULL THEN
        RAISE EXCEPTION
          'spatial_create_scene: parent scene % not found', v_effective_parent
          USING ERRCODE = '22023';
      END IF;
      IF v_parent_customer IS DISTINCT FROM v_uid THEN
        RAISE EXCEPTION
          'spatial_create_scene: caller % is not the customer of parent scene %',
          v_uid, v_effective_parent
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NOT public.spatial_can_view_scene(v_effective_parent, v_uid) THEN
        RAISE EXCEPTION
          'spatial_create_scene: caller % cannot view parent scene %',
          v_uid, v_effective_parent
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  -- 8. Scan / job ownership guard.
  IF p_source_scan_id IS NOT NULL THEN
    v_authorized := public.spatial_can_convert_scan(p_source_scan_id, v_uid);
  ELSE
    SELECT (
        public.spatial_is_operator(v_uid)
        OR j.customer_user_id = v_uid
        OR (j.provider_id IS NOT NULL
            AND j.provider_id = public.spatial_user_provider_org(v_uid))
        OR (j.assigned_provider_id IS NOT NULL
            AND j.assigned_provider_id = public.spatial_user_provider_org(v_uid))
      )
      INTO v_authorized
      FROM public.jobs j
      WHERE j.id = p_source_job_id;
  END IF;

  IF v_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'spatial_create_scene: caller % is not authorized for this scan/job', v_uid
      USING ERRCODE = '42501';
  END IF;

  -- 9. Derive customer ownership.
  --    scan-origin → project's customer; otherwise → job's customer.
  --    V1.5.1 fallback: when the source scan is owner_type='customer'
  --    (Customer Self-Scan, Lane 3 Block 1) and neither project nor job
  --    carries a customer, fall back to scans.captured_by — by definition
  --    the Self-Scan capturer. Without this fallback the scene row would
  --    persist with customer_id=NULL, breaking hub/list queries that filter
  --    on customer_id directly.
  IF p_source_scan_id IS NOT NULL THEN
    SELECT pr.customer_user_id, s.captured_by, s.owner_type
      INTO v_customer_id, v_capture_uid, v_owner_type
      FROM public.scans s
      LEFT JOIN public.projects pr ON pr.id = s.project_id
      WHERE s.id = p_source_scan_id;
  END IF;
  IF v_customer_id IS NULL AND v_effective_job_id IS NOT NULL THEN
    SELECT j.customer_user_id INTO v_customer_id
      FROM public.jobs j
      WHERE j.id = v_effective_job_id;
  END IF;
  IF v_customer_id IS NULL
     AND v_owner_type = 'customer'
     AND v_capture_uid IS NOT NULL THEN
    v_customer_id := v_capture_uid;
  END IF;

  -- 10. Derive provider ownership from the job.
  IF v_effective_job_id IS NOT NULL THEN
    SELECT coalesce(j.provider_id, j.assigned_provider_id)
      INTO v_provider_org_id
      FROM public.jobs j
      WHERE j.id = v_effective_job_id;
    IF v_provider_org_id IS NOT NULL THEN
      SELECT p.profile_id INTO v_provider_user_id
        FROM public.providers p
        WHERE p.id = v_provider_org_id;
    END IF;
  END IF;

  -- 11. Insert.
  INSERT INTO public.spatial_scenes (
    id,
    source_scan_id,
    source_job_id,
    parent_scene_id,
    parametric_storage_path,
    parametric_size_bytes,
    parametric_sha256,
    schema_version,
    validation_state,
    is_renderable,
    requires_user_confirmation,
    customer_id,
    provider_id,
    provider_org_id,
    metadata
  )
  VALUES (
    p_id,
    p_source_scan_id,
    p_source_job_id,
    v_effective_parent,
    p_parametric_storage_path,
    p_parametric_size_bytes,
    p_parametric_sha256,
    coalesce(p_schema_version, '1.0'),
    coalesce(p_validation_state, 'pending'),
    coalesce(p_is_renderable, false),
    coalesce(p_requires_user_confirmation, false),
    v_customer_id,
    v_provider_user_id,
    v_provider_org_id,
    coalesce(p_metadata, '{}'::jsonb)
      || CASE
           WHEN p_validation_report IS NOT NULL
             AND p_validation_report <> '{}'::jsonb
           THEN jsonb_build_object('validation_report', p_validation_report)
           ELSE '{}'::jsonb
         END
  )
  ON CONFLICT (source_scan_id) WHERE source_scan_id IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_scene;

  -- 12. ON CONFLICT recovery — re-read the winning scene.
  IF v_scene.id IS NULL THEN
    SELECT * INTO v_scene
      FROM public.spatial_scenes
      WHERE source_scan_id = p_source_scan_id;
  END IF;

  -- 13. Atomically link the new scene back to the rescan_request (D2 · B7).
  IF p_rescan_request_id IS NOT NULL AND v_scene.id IS NOT NULL THEN
    UPDATE public.spatial_rescan_requests
       SET resulting_scene_id = v_scene.id,
           updated_at         = now()
     WHERE id = p_rescan_request_id;
  END IF;

  RETURN v_scene;
END;
$$;

COMMENT ON FUNCTION public.spatial_create_scene(
  uuid, text, text, integer, uuid, uuid, text, text, jsonb, boolean, boolean, jsonb, uuid, uuid
) IS
  'Spatial Canonical B1+B7 (CAD Lane V1.5.1 patch): scene-INSERT path (AD-2). '
  'SECURITY DEFINER RPC bypassing spatial_scenes_insert WITH CHECK (false). '
  'Ownership-guarded (spatial_can_convert_scan for scan-origin; job '
  'customer / provider-org for job-origin; customer-of-parent for rescan-'
  'request linkage). Idempotent per source_scan_id AND per rescan_request_id. '
  'V1.5.1: when the source scan is owner_type=customer and no project/job '
  'carries an owner, customer_id falls back to scans.captured_by (Customer '
  'Self-Scan). When p_rescan_request_id is set, the new scene id is written '
  'onto resulting_scene_id atomically.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- Restore the pre-V1.5.1 body by re-applying 20260522120054. Permissions are
-- unaffected (signature stable).
