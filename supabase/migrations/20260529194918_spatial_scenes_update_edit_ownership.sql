-- Cluster D · Edit-ownership guard for spatial_scenes UPDATE.
--
-- Applied to prod via Supabase MCP apply_migration (version 20260529194918);
-- this file mirrors it for repo traceability.
--
-- Prior state (bug): spatial_scenes_update WITH CHECK gated on
-- spatial_can_view_scene(), which returns TRUE for a customer VIEWING a
-- craftsman scene shared with them (scans.shared_with_customer + jobs.customer
-- match). A customer could therefore overwrite the craftsman's authoritative
-- parametric.json. We add a dedicated edit-ownership predicate and tighten the
-- WITH CHECK to it. USING stays on view (a row must be visible to be updated).

CREATE OR REPLACE FUNCTION public.spatial_can_edit_scene(p_scene_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.role() = 'service_role'
    OR public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1 FROM public.spatial_scenes s
      WHERE s.id = p_scene_id
        AND (
          -- The provider who owns the scene record may edit it.
          s.provider_id = p_uid
          -- A customer self-scan: the source scan is customer-owned AND was
          -- captured by this caller. A craftsman scene shared with the customer
          -- has owner_type='craftsman' (or a different captured_by) and is thus
          -- NOT editable by the customer — read-only, comment via pins only.
          OR (
            s.source_scan_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.scans sc
              WHERE sc.id = s.source_scan_id
                AND sc.owner_type = 'customer'
                AND sc.captured_by = p_uid
            )
          )
        )
    );
$$;

REVOKE ALL ON FUNCTION public.spatial_can_edit_scene(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.spatial_can_edit_scene(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS spatial_scenes_update ON public.spatial_scenes;
CREATE POLICY spatial_scenes_update ON public.spatial_scenes
  FOR UPDATE TO authenticated
  USING (public.spatial_can_view_scene(id, (SELECT auth.uid())))
  WITH CHECK (public.spatial_can_edit_scene(id, (SELECT auth.uid())));

NOTIFY pgrst, 'reload schema';
