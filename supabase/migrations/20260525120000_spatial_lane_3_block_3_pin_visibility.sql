-- Spatial Lane 3 · Block 3 · Pin Visibility
-- Adds HW-toggled `customer_visible` to scan_annotations + RLS-level filter so
-- customer-viewers (HW-shared scan + Self-Scan owners) only see public pins.
-- HW + workers + operators continue to see every pin.
--
-- Defaults by kind (matches the AnnotationEditorSheet UX defaults):
--   damage / photo / measurement_ref → customer_visible = true
--   note / gewerk_marker            → customer_visible = false (internal HW info)

ALTER TABLE public.scan_annotations
  ADD COLUMN IF NOT EXISTS customer_visible boolean NOT NULL DEFAULT true;

-- Kind-specific backfill for pre-existing rows
UPDATE public.scan_annotations
   SET customer_visible = false
 WHERE kind IN ('note', 'gewerk_marker')
   AND customer_visible = true;

CREATE INDEX IF NOT EXISTS scan_annotations_customer_visible_idx
  ON public.scan_annotations (scan_id, customer_visible)
  WHERE customer_visible = true;

COMMENT ON COLUMN public.scan_annotations.customer_visible IS
  'Lane 3 V1.6 Block 3: HW-toggled visibility per pin. true = customer sees this pin in shared scans. Default true except for note/gewerk_marker kinds (internal HW info). HW + workers + operators always see every pin; customer-viewers (HW-shared scan job customers, Self-Scan owners) only see customer_visible=true.';

-- Helper: is the viewer a pure-customer for this scan? (HW + Operator return false)
CREATE OR REPLACE FUNCTION public.spatial_is_customer_viewer(p_scan_id uuid, p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $f$
  SELECT
    NOT public.spatial_is_operator(p_uid)
    AND EXISTS (
      SELECT 1
      FROM public.scans s
      LEFT JOIN public.jobs j ON j.id = s.job_id
      WHERE s.id = p_scan_id
        AND COALESCE(j.craftsman_user_id, '') <> p_uid::text
        AND NOT EXISTS (
          SELECT 1
          FROM public.job_assignments ja
          JOIN public.team_members    tm ON tm.id = ja.team_member_id
          WHERE ja.job_id     = s.job_id
            AND tm.profile_id = p_uid
            AND tm.is_active  = true
            AND ja.status IN ('assigned','accepted','active','in_progress','completed')
        )
        AND (
          (s.shared_with_customer = true AND s.job_id IS NOT NULL AND j.customer_user_id = p_uid)
          OR (s.owner_type = 'customer' AND s.captured_by = p_uid)
        )
    );
$f$;

COMMENT ON FUNCTION public.spatial_is_customer_viewer(uuid, uuid) IS
  'Lane 3 V1.6 Block 3: returns true only when the viewer is a pure customer (HW-shared scan customer or Self-Scan owner) — never for HW owners, workers, or operators. Used by scan_annotations_select to enforce customer_visible filter.';

REVOKE EXECUTE ON FUNCTION public.spatial_is_customer_viewer(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.spatial_is_customer_viewer(uuid, uuid) TO authenticated;

-- scan_annotations SELECT policy extended for per-pin visibility
DROP POLICY IF EXISTS scan_annotations_select ON public.scan_annotations;
CREATE POLICY scan_annotations_select ON public.scan_annotations
  FOR SELECT TO authenticated
  USING (
    public.spatial_can_view_scan(scan_id, (SELECT auth.uid()))
    AND (
      NOT public.spatial_is_customer_viewer(scan_id, (SELECT auth.uid()))
      OR customer_visible = true
    )
  );

COMMENT ON POLICY scan_annotations_select ON public.scan_annotations IS
  'Lane 3 V1.6 Block 3: scan-level view-gate + per-pin customer_visible filter for customer viewers. HW/Operator/Worker see all pins on accessible scans.';
