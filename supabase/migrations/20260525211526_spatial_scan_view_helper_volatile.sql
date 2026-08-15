-- Spatial Lane 3 Hotfix · spatial_can_view_scan + spatial_can_edit_scan VOLATILE
--
-- Symptom (prod): Customer-Self-Scan
--   INSERT INTO scans (...) RETURNING *
-- failt mit
--   "new row violates row-level security policy for table 'scans'" (42501).
--
-- Root cause: spatial_can_view_scan / spatial_can_edit_scan sind
-- STABLE SECURITY DEFINER. Beim INSERT … RETURNING prüft Postgres die
-- SELECT-USING-Policy gegen die frisch eingefügte Row. Die STABLE-Function
-- läuft mit Statement-Snapshot vor dem INSERT — der EXISTS-Subquery findet
-- die neue Row nicht → returnt false → SELECT-Policy fängt RETURNING ab.
-- PG gibt bei RETURNING-RLS-Fehlschlag denselben Fehlertext wie bei
-- WITH-CHECK-Verstoß, was den eigentlichen Bug verschleiert.
--
-- WITH CHECK auf scans_insert ist erfüllt: captured_by = auth.uid() ✓ und
-- owner_type = 'customer' ✓. Der Fehlschlag passiert ausschliesslich im
-- RETURNING-Pfad über die SELECT-USING-Helper-Function.
--
-- Fix: VOLATILE (statt STABLE). Postgres garantiert einer VOLATILE-Function
-- bei jedem Aufruf einen frischen Snapshot, der die im selben Statement
-- inserted Row sieht. Performance-Auswirkung ist gering: Helper ist ohnehin
-- per-Row-RLS-Check, der innerhalb eines Statements neu evaluiert wird.
--
-- Belt-and-suspenders: spatial_can_edit_scan ebenfalls VOLATILE, sonst trifft
-- der gleiche Snapshot-Quirk UPDATE … RETURNING (Move-to-Project, Pin-Save,
-- Wall-Edit). Bisher unentdeckt, weil die meisten Edits ohne RETURNING
-- laufen, aber das Bug-Pattern ist identisch.

CREATE OR REPLACE FUNCTION public.spatial_can_view_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE SECURITY DEFINER
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
          OR s.shared_with_provider_id = p_uid
        )
    );
$f$;

COMMENT ON FUNCTION public.spatial_can_view_scan(uuid, uuid) IS
  'Spatial Core RLS helper: union view-access. VOLATILE seit 20260526 Hotfix damit INSERT…RETURNING (Customer Self-Scan) den fresh-snapshot der eingefügten Row sieht. Vorher STABLE → SELECT-USING returnte false auf neue Row → 42501 maskiert als WITH-CHECK-Violation.';

CREATE OR REPLACE FUNCTION public.spatial_can_edit_scan(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
VOLATILE SECURITY DEFINER
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
  'Spatial Core RLS helper: full edit-access. VOLATILE seit 20260526 Hotfix, gleiche Begründung wie spatial_can_view_scan (UPDATE…RETURNING wäre vom gleichen Snapshot-Quirk betroffen).';
