-- Spatial Lane 3 Hotfix Round 2 · scans_select inline USING
--
-- Round 1 (20260526000001 VOLATILE) hat NICHT gegriffen: PG-RLS bei
-- INSERT…RETURNING evaluiert die SELECT-USING-Policy mit einem
-- "command-local snapshot" der die neu eingefügte Row sieht — ABER nur für
-- direkte Spalten-Refs (NEW.field). Sobald die USING-Expression eine
-- SECURITY DEFINER-Function ist die intern
--   SELECT … FROM public.scans WHERE id = p_scan_id
-- macht, läuft jener Sub-SELECT mit dem normalen Transaktions-Snapshot der
-- die uncommitted INSERT-Row NICHT sieht → Function returnt false → 42501.
--
-- Fix: scans_select USING-Expression komplett inline auf NEW-row-Spalten
-- umschreiben. Spalten wie scans.owner_type, scans.captured_by, scans.job_id
-- werden direkt aus der NEW row gelesen und sind im command-local Snapshot
-- sichtbar. Cross-row-Lookups (projects/jobs/job_assignments/presales)
-- bleiben als EXISTS-Subqueries — die referenzieren ANDERE Tabellen, kein
-- Self-Lookup auf scans.
--
-- spatial_can_view_scan bleibt erhalten weil scenes-Policy via
-- spatial_can_view_scene → scans-Subquery sie noch braucht; dort gibt es
-- keinen RETURNING-Snapshot-Issue weil die scans-row vor der scene-Operation
-- existiert.

DROP POLICY IF EXISTS scans_select ON public.scans;
CREATE POLICY scans_select ON public.scans
  FOR SELECT TO authenticated
  USING (
    public.spatial_is_operator((SELECT auth.uid()))
    OR (scans.owner_type = 'customer' AND scans.captured_by = (SELECT auth.uid()))
    OR (scans.captured_by = (SELECT auth.uid()) AND scans.status IN ('draft', 'capturing'))
    OR scans.shared_with_provider_id = (SELECT auth.uid())
    OR (
      scans.project_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.projects pr
        WHERE pr.id = scans.project_id
          AND pr.customer_user_id = (SELECT auth.uid())
      )
    )
    OR (
      scans.job_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = scans.job_id
          AND (
            j.craftsman_user_id = ((SELECT auth.uid())::text)
            OR j.customer_user_id = (SELECT auth.uid())
          )
      )
    )
    OR (
      scans.shared_with_customer = true
      AND scans.job_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = scans.job_id
          AND j.customer_user_id = (SELECT auth.uid())
      )
    )
    OR (
      scans.job_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.job_assignments ja
        JOIN public.team_members tm ON tm.id = ja.team_member_id
        WHERE ja.job_id     = scans.job_id
          AND tm.profile_id = (SELECT auth.uid())
          AND tm.is_active  = true
          AND ja.status     IN ('assigned', 'accepted', 'active', 'in_progress', 'completed')
      )
    )
    OR (
      scans.presales_project_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.provider_presales_projects pp
        WHERE pp.id = scans.presales_project_id
          AND pp.provider_org_id = public.spatial_user_provider_org((SELECT auth.uid()))
      )
    )
  );

COMMENT ON POLICY scans_select ON public.scans IS
  'Spatial Lane 3 Hotfix 20260526: Inline-USING (kein Function-Indirektion) damit INSERT…RETURNING die NEW row sieht. Snapshot-Problem mit spatial_can_view_scan(SECDEF) maskierte sich als 42501 WITH-CHECK-Violation. Function bleibt erhalten für scenes-Subquery, da dort kein RETURNING-Pfad triggert.';
