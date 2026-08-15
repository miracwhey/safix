-- Spatial Lane 3 · Block 1 · RLS Rewrite
-- Updates RLS helpers and policies for Customer-Spatial-Tab + Self-Scan.
-- All cross-row predicates fully alias-qualified (feedback_rls_subquery_unqualified_column).

-- Helper: spatial_can_view_scan extended for customer sharing
CREATE OR REPLACE FUNCTION public.spatial_can_view_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects    p  ON p.id  = s.project_id
      LEFT JOIN public.jobs        j  ON j.id  = s.job_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR j.craftsman_user_id = p_uid::text
          OR j.customer_user_id = p_uid
          OR EXISTS (
            SELECT 1
            FROM public.job_assignments ja
            JOIN public.team_members    tm ON tm.id = ja.team_member_id
            WHERE ja.job_id     = s.job_id
              AND tm.profile_id = p_uid
              AND tm.is_active  = true
              AND ja.status     IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
          )
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
          OR (
            s.shared_with_customer = true
            AND s.job_id IS NOT NULL
            AND j.customer_user_id = p_uid
          )
        )
    );
$f$;

COMMENT ON FUNCTION public.spatial_can_view_scan(uuid, uuid) IS
  'Spatial Core RLS helper: union view-access. Lane 3 V1.6 additions: customer-owned Self-Scan (owner_type=customer + captured_by=uid) + HW-shared scan (shared_with_customer=true + job.customer_user_id=uid).';

-- Helper: spatial_can_edit_scan extended for customer Self-Scan
CREATE OR REPLACE FUNCTION public.spatial_can_edit_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT
    public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.projects p ON p.id = s.project_id
      LEFT JOIN public.provider_presales_projects pp ON pp.id = s.presales_project_id
      WHERE s.id = p_scan_id
        AND (
          p.customer_user_id = p_uid
          OR (s.captured_by = p_uid AND s.status IN ('draft', 'capturing'))
          OR (
            pp.provider_org_id IS NOT NULL
            AND pp.provider_org_id = public.spatial_user_provider_org(p_uid)
          )
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
        )
    );
$f$;

COMMENT ON FUNCTION public.spatial_can_edit_scan(uuid, uuid) IS
  'Spatial Core RLS helper: full edit-access. Lane 3 V1.6: customer-owned Self-Scan (owner_type=customer + captured_by=uid) has permanent edit.';

-- scans INSERT policy — allow customer Self-Scan without job anchor
DROP POLICY IF EXISTS scans_insert ON public.scans;
CREATE POLICY scans_insert ON public.scans
  FOR INSERT TO authenticated
  WITH CHECK (
    captured_by = (SELECT auth.uid())
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR owner_type = 'customer'
      OR (
        project_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.projects pr
          WHERE pr.id = project_id
            AND pr.customer_user_id = (SELECT auth.uid())
        )
      )
      OR (
        job_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = job_id
            AND (
              j.craftsman_user_id = (SELECT auth.uid())::text
              OR j.customer_user_id = (SELECT auth.uid())
            )
        )
      )
      OR (
        presales_project_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.provider_presales_projects pp
          WHERE pp.id = presales_project_id
            AND pp.provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
        )
      )
    )
  );

-- scans UPDATE policy — restrict shared_with_customer changes to job-craftsman
DROP POLICY IF EXISTS scans_update ON public.scans;
CREATE POLICY scans_update ON public.scans
  FOR UPDATE TO authenticated
  USING (public.spatial_can_edit_scan(id, (SELECT auth.uid())))
  WITH CHECK (
    public.spatial_can_edit_scan(id, (SELECT auth.uid()))
    AND (
      public.spatial_is_operator((SELECT auth.uid()))
      OR captured_by = (SELECT s2.captured_by FROM public.scans s2 WHERE s2.id = scans.id)
    )
    AND (
      shared_with_customer = (SELECT s2.shared_with_customer FROM public.scans s2 WHERE s2.id = scans.id)
      OR public.spatial_is_operator((SELECT auth.uid()))
      OR (
        job_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.jobs j
          WHERE j.id = scans.job_id
            AND j.craftsman_user_id = (SELECT auth.uid())::text
        )
      )
    )
  );

-- Helper: spatial_can_view_scene extended for shared scan
CREATE OR REPLACE FUNCTION public.spatial_can_view_scene(p_scene_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT
    auth.role() = 'service_role'
    OR public.spatial_is_operator(p_uid)
    OR EXISTS (
      SELECT 1 FROM public.spatial_scenes s
      WHERE s.id = p_scene_id
        AND (
          s.customer_id = p_uid
          OR s.provider_id = p_uid
          OR (
            s.source_scan_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.scans sc
              JOIN public.jobs  j ON j.id = sc.job_id
              WHERE sc.id = s.source_scan_id
                AND sc.shared_with_customer = true
                AND j.customer_user_id = p_uid
            )
          )
          OR (
            s.customer_id IS NULL
            AND s.source_scan_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.scans sc
              WHERE sc.id = s.source_scan_id
                AND sc.owner_type = 'customer'
                AND sc.captured_by = p_uid
            )
          )
        )
    );
$f$;

COMMENT ON FUNCTION public.spatial_can_view_scene(uuid, uuid) IS
  'Spatial Canonical RLS helper: scene-actor check. Lane 3 V1.6 additions: HW-shared scene (source scan shared_with_customer=true + job.customer_user_id=uid) + customer-owned Self-Scan scene (source scan owner_type=customer + captured_by=uid).';

REVOKE EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_can_view_scene(uuid, uuid) TO authenticated;
