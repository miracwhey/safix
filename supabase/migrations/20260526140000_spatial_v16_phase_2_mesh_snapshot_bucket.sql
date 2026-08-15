-- Spatial V1.6 · Phase 2 · LiDAR Customer-Capture · Mesh Snapshot Bucket + RLS
--
-- Bucket creation strategy:
--   This migration creates the bucket inline via INSERT INTO storage.buckets,
--   mirroring the prod-tested spatial-parametric pattern (20260521120049).
--   MCP apply_migration runs with supabase_storage_admin-elevated context, so
--   the INSERT works without separate Dashboard steps. Atomic apply: bucket +
--   policies in a single migration.
--
--   Bucket settings:
--     id:                 spatial-mesh-snapshots
--     public:             false
--     file_size_limit:    5242880   (5 MB — USDZ meshes from RoomPlan are ~500 KB;
--                                    5 MB headroom for edge-case large rooms)
--     allowed_mime_types: model/vnd.usdz+zip, model/obj
--
-- Path convention (locked):
--   {user_id}/{scan_id}.usdz
--   e.g.  a1b2c3d4-…/f5e6d7c8-….usdz
--
--   Rationale for flat two-segment path vs nested {user_id}/{scan_id}/mesh.usdz:
--     • RoomPlan exports a single USDZ per capture; no sibling files at the same
--       scan-level path. A directory-level nesting adds zero benefit and complicates
--       the foldername[2] segment parse (which would need filename stripped).
--     • {scan_id} is already globally unique (uuid), so collision risk = zero.
--     • Mirrors spatial-parametric pattern: {userId}/{sceneId}/parametric-{sha}.json.gz
--       where foldername[1]=userId. Here foldername[1]=userId, filename=scan_id.usdz
--       (no foldername[2]). Path helper reflects this.
--
-- Privacy (PRIV-D2 / B4-D10):
--   Mesh blobs are customer-owned spatial data of their own physical space.
--   Cascade-delete on bucket-trigger or Edge-Function is required when a scan is
--   deleted. This cleanup is NOT implemented in this migration — it belongs in the
--   Phase 2 build (createCustomerLidarScene.ts + Edge-Function cleanup on
--   scan DELETE event). Tracked in Phase-2 Acceptance-Criteria §4 item 9.
--
-- RLS posture (mirrors spatial-parametric with mesh-appropriate SELECT logic):
--   INSERT  — path-owner (foldername[1] = auth.uid()) only. Captures run client-side.
--   SELECT  — path-owner always; additionally HW (job craftsman) if the referenced
--             scan has shared_with_customer = true. Cross-actor read gated via
--             SECDEF helper spatial_can_view_mesh_snapshot (defined below).
--   UPDATE  — NONE. Mesh files are immutable. New scan = new path. Old blobs stay
--             until PRIV-D2 cleanup runs.
--   DELETE  — path-owner only (covers manual re-scan cleanup; automated cleanup
--             runs as service_role which bypasses RLS).
--
-- SECDEF helper spatial_can_view_mesh_snapshot:
--   Parses the object path to extract user_id (foldername[1]) and scan_id
--   (filename without extension), then checks:
--     (a) caller is the scan owner (path-owner)  ← same as INSERT
--     (b) caller is the craftsman on the job linked to the scan, AND
--         scans.shared_with_customer = true  ← HW can view shared mesh
--   Avoids the INSERT-RETURNING SECDEF-snapshot bug (feedback_rls_select_using_secdef_returning_snapshot)
--   by having INSERT policy use the inline foldername[1] check (no cross-table
--   lookup) while SELECT uses this function. INSERT never needs RETURNING for
--   the mesh blob; the workflow reads the signed URL separately.
--
-- Affected domains after apply:
--   src/lib/spatial/repository/SupabaseSpatialRepository.ts  (uploadMeshSnapshot method)
--   src/lib/spatial/workflow/createCustomerLidarScene.ts      (upload call + path construction)
--
-- Apply: No external step required (bucket created inline below).
--        No dependency on F1 quality_score — apply order F1→F2 recommended but
--        F2-alone is safe if F1 already applied.

-- ── Bucket ────────────────────────────────────────────────────────────────────
-- Mirrors spatial-parametric pattern (20260521120049). ON CONFLICT idempotent.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'spatial-mesh-snapshots',
  'spatial-mesh-snapshots',
  false,
  5242880, -- 5 MB — RoomPlan USDZ ~500 KB typical; 5 MB headroom for large rooms.
  ARRAY['model/vnd.usdz+zip','model/obj','application/octet-stream']
)
ON CONFLICT (id) DO NOTHING;

-- ── Path helpers ──────────────────────────────────────────────────────────────
-- Extract scan_id from path: {user_id}/{scan_id}.usdz → filename without extension.
-- Returns NULL on malformed input (guards cast failure in RLS context).

CREATE OR REPLACE FUNCTION public.spatial_mesh_snapshot_scan_id(p_object_name text)
RETURNS uuid
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, storage
AS $$
DECLARE
  v_filename text;
  v_scan_id  text;
BEGIN
  -- filename(name) returns the last segment including extension
  -- split_part on '.' strips the .usdz extension
  v_filename := storage.filename(p_object_name);
  v_scan_id  := split_part(v_filename, '.', 1);
  IF v_scan_id IS NULL OR v_scan_id = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_scan_id::uuid;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.spatial_mesh_snapshot_scan_id(text) IS
  'V1.6 Phase 2: extracts the scan_id segment of a spatial-mesh-snapshots object path as uuid.'
  ' Path convention: {user_id}/{scan_id}.usdz — filename without extension = scan_id.'
  ' Returns NULL on malformed input. Used by spatial_can_view_mesh_snapshot helper.';

-- ── SECDEF SELECT helper ──────────────────────────────────────────────────────
-- Cross-table access check: does p_uid have SELECT rights on this mesh blob?
-- Two branches:
--   (a) caller is the scan owner (customer who captured it)
--   (b) caller is the craftsman on the linked job AND scan is shared

CREATE OR REPLACE FUNCTION public.spatial_can_view_mesh_snapshot(
  p_object_name text,
  p_uid         uuid
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, storage
AS $f$
  SELECT
    -- (a) path-owner: foldername[1] = caller uid
    (storage.foldername(p_object_name))[1] = p_uid::text

    -- (b) craftsman on shared scan
    OR EXISTS (
      SELECT 1
      FROM public.scans sc
      JOIN  public.jobs  j  ON j.id = sc.job_id
      WHERE sc.id = public.spatial_mesh_snapshot_scan_id(p_object_name)
        AND sc.shared_with_customer = true
        AND j.craftsman_user_id = p_uid::text
    )

    -- (c) operator override
    OR public.spatial_is_operator(p_uid);
$f$;

COMMENT ON FUNCTION public.spatial_can_view_mesh_snapshot(text, uuid) IS
  'V1.6 Phase 2: RLS helper for spatial-mesh-snapshots SELECT.'
  ' (a) path-owner (customer who captured), (b) craftsman on linked job with shared_with_customer=true, (c) operator.'
  ' SECDEF bypasses scans/jobs RLS for the cross-table lookup.'
  ' Does NOT use INSERT-RETURNING path (INSERT policy uses inline foldername check to avoid SECDEF snapshot bug).';

REVOKE EXECUTE ON FUNCTION public.spatial_can_view_mesh_snapshot(text, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_can_view_mesh_snapshot(text, uuid) TO authenticated;

-- ── RLS policies on storage.objects ──────────────────────────────────────────
-- storage.objects already has RLS enabled (Supabase-managed).
-- Apply via apply_migration (not execute_sql) — storage.objects is owned by
-- supabase_storage_admin; MCP apply_migration silently elevates context.
-- See: feedback_supabase_storage_objects_policy_mcp_only

-- SELECT — owner or craftsman-on-shared-scan or operator.
-- Uses SECDEF helper to avoid inline self-recursion on scans table.
-- INSERT-RETURNING not needed for SELECT policy (read path, no NEW row).
DROP POLICY IF EXISTS spatial_mesh_snapshots_select ON storage.objects;
CREATE POLICY spatial_mesh_snapshots_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'spatial-mesh-snapshots'
    AND public.spatial_can_view_mesh_snapshot(name, (SELECT auth.uid()))
  );

-- INSERT — path-owner only.
-- Inline foldername[1] check: no cross-table lookup, no SECDEF-snapshot risk.
-- INSERT…RETURNING is safe because the USING check is a direct column compare,
-- not a SECDEF function with a sub-SELECT on the same table.
-- See: feedback_rls_select_using_secdef_returning_snapshot
DROP POLICY IF EXISTS spatial_mesh_snapshots_insert ON storage.objects;
CREATE POLICY spatial_mesh_snapshots_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'spatial-mesh-snapshots'
    AND auth.uid() IS NOT NULL
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- UPDATE — NONE (mesh files are immutable; new scan = new path).
-- No UPDATE policy created. Any attempted UPDATE from an authenticated user
-- will be denied by default-deny RLS. service_role bypasses RLS for
-- server-side operations if needed.

-- DELETE — path-owner only (manual cleanup; PRIV-D2 automated cleanup runs
-- as service_role and bypasses RLS).
DROP POLICY IF EXISTS spatial_mesh_snapshots_delete ON storage.objects;
CREATE POLICY spatial_mesh_snapshots_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'spatial-mesh-snapshots'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- ── Schema cache reload ───────────────────────────────────────────────────────
-- New RPC functions added to public schema — PostgREST must re-introspect.
-- See: feedback_postgrest_schema_cache_reload

NOTIFY pgrst, 'reload schema';

-- ── Rollback (run manually — NOT part of apply) ───────────────────────────────
-- DROP POLICY IF EXISTS spatial_mesh_snapshots_delete ON storage.objects;
-- DROP POLICY IF EXISTS spatial_mesh_snapshots_insert ON storage.objects;
-- DROP POLICY IF EXISTS spatial_mesh_snapshots_select ON storage.objects;
-- DROP FUNCTION IF EXISTS public.spatial_can_view_mesh_snapshot(text, uuid);
-- DROP FUNCTION IF EXISTS public.spatial_mesh_snapshot_scan_id(text);
-- DELETE FROM storage.buckets WHERE id = 'spatial-mesh-snapshots';
-- NOTIFY pgrst, 'reload schema';
