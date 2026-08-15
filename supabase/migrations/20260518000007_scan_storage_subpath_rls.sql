-- Spatial Core · Block A.1 · Storage Sub-Path RLS
--
-- Adds Spatial-domain sub-path RLS on the `project-scans` storage bucket so
-- asset uploads/reads/lifecycle can be gated per-scan + per-kind instead of
-- per-project. Existing `project_scans_*` policies (path `{userId}/{projectId}/scan.usdz`)
-- stay live for the legacy RoomPlan-M0 plugin upload path — Block B migrates
-- those callers to the new Spatial paths.
--
-- New path schema:
--   {userId}/{scanId}/{kind}/{filename.ext}
--
-- Where:
--   * userId  = auth.uid()                          — owner of the upload
--   * scanId  = public.scans.id                     — caller must be viewer
--   * kind    = one of public.scan_asset_kind enum  — partitions for lifecycle
--   * ext     = enforced per kind (usdz/glb/json/png/svg)
--
-- Hardening over the minimal "sub-path RLS":
--   * Path-traversal block: `..` segments rejected (Supabase normalizes at
--     upload, but the policy is the last line of defense).
--   * Kind allowlist: `(storage.foldername(name))[3]` IN the 6 known asset
--     kinds — typos like `usdzs/` are rejected.
--   * Extension allowlist per kind: stops a `.exe` rename masquerading as
--     `.usdz` upload (the bucket's MIME check is a separate layer).
--   * Viewer/editor gate: `spatial_can_view_scan` (read) and
--     `spatial_can_edit_scan` (write) — RLS-equivalent of the table policies.
--   * Operator delete kept on parity with the scan_events RLS pattern.
--
-- The two layers coexist without conflict: Postgres Storage policies are OR'd
-- per operation, so a path that matches the legacy `project_scans_*` schema
-- continues to work via that policy, and a path that matches the new
-- `spatial_scan_assets_*` schema works via this one.

-- ── Helper: kind-extension allowlist as a stable, indexable expression ──────
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
  -- Path-traversal: any '..' segment is illegal.
  IF position('..' in p_name) <> 0 THEN
    RETURN false;
  END IF;

  v_parts := storage.foldername(p_name);
  -- Expect at least 3 folder levels: user / scan / kind.
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
    WHEN 'thumbnail'     THEN v_lower LIKE '%.png' OR v_lower LIKE '%.jpg' OR v_lower LIKE '%.jpeg'
    WHEN 'floorplan_svg' THEN v_lower LIKE '%.svg'
    ELSE false
  END;
END;
$$;

COMMENT ON FUNCTION public.spatial_scan_storage_path_ok(text)
  IS 'Spatial Core: validates a project-scans Storage object name matches schema {user}/{scan}/{kind}/file.ext with kind/ext allowlist and no path-traversal.';

REVOKE EXECUTE ON FUNCTION public.spatial_scan_storage_path_ok(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_scan_storage_path_ok(text) TO authenticated;

-- ── INSERT: editor of the scan, owner-folder, valid path ─────────────────────
DROP POLICY IF EXISTS spatial_scan_assets_insert ON storage.objects;
CREATE POLICY spatial_scan_assets_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-scans'
    AND public.spatial_scan_storage_path_ok(name)
    AND ((storage.foldername(name))[1])::uuid = (SELECT auth.uid())
    AND public.spatial_can_edit_scan(
          ((storage.foldername(name))[2])::uuid,
          (SELECT auth.uid())
        )
  );

-- ── UPDATE: editor of the scan, owner-folder, valid path ─────────────────────
DROP POLICY IF EXISTS spatial_scan_assets_update ON storage.objects;
CREATE POLICY spatial_scan_assets_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND public.spatial_scan_storage_path_ok(name)
    AND ((storage.foldername(name))[1])::uuid = (SELECT auth.uid())
    AND public.spatial_can_edit_scan(
          ((storage.foldername(name))[2])::uuid,
          (SELECT auth.uid())
        )
  )
  WITH CHECK (
    bucket_id = 'project-scans'
    AND public.spatial_scan_storage_path_ok(name)
    AND ((storage.foldername(name))[1])::uuid = (SELECT auth.uid())
    AND public.spatial_can_edit_scan(
          ((storage.foldername(name))[2])::uuid,
          (SELECT auth.uid())
        )
  );

-- ── SELECT: viewer of the scan, valid path ───────────────────────────────────
-- Read does NOT require owner-folder match: a craftsman viewing a customer's
-- scan needs read on the customer-uploader's path, which is naturally a
-- different uuid than the craftsman's own. spatial_can_view_scan is the
-- authoritative gate; the owner-folder check on writes is for upload-attribution
-- integrity.
DROP POLICY IF EXISTS spatial_scan_assets_select ON storage.objects;
CREATE POLICY spatial_scan_assets_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND public.spatial_scan_storage_path_ok(name)
    AND public.spatial_can_view_scan(
          ((storage.foldername(name))[2])::uuid,
          (SELECT auth.uid())
        )
  );

-- ── DELETE: owner-uploader; operator override ────────────────────────────────
DROP POLICY IF EXISTS spatial_scan_assets_delete_owner ON storage.objects;
CREATE POLICY spatial_scan_assets_delete_owner ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND public.spatial_scan_storage_path_ok(name)
    AND ((storage.foldername(name))[1])::uuid = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS spatial_scan_assets_delete_operator ON storage.objects;
CREATE POLICY spatial_scan_assets_delete_operator ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-scans'
    AND public.spatial_scan_storage_path_ok(name)
    AND public.spatial_is_operator((SELECT auth.uid()))
  );

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS spatial_scan_assets_insert          ON storage.objects;
-- DROP POLICY IF EXISTS spatial_scan_assets_update          ON storage.objects;
-- DROP POLICY IF EXISTS spatial_scan_assets_select          ON storage.objects;
-- DROP POLICY IF EXISTS spatial_scan_assets_delete_owner    ON storage.objects;
-- DROP POLICY IF EXISTS spatial_scan_assets_delete_operator ON storage.objects;
-- DROP FUNCTION         IF EXISTS public.spatial_scan_storage_path_ok(text);
