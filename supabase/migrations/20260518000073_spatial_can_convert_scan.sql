-- Spatial Core · Post-Review P0 — convert permission helper
--
-- The convert pipeline (`spatial-enqueue-convert` edge function) was gated by
-- `spatial_can_edit_scan`, which only grants captured_by access during the
-- `draft|capturing` window. Once the FSM advanced to `captured` (the very
-- moment the user wants to convert), the captured craftsman lost edit-rights
-- and the convert request fell to 403. Symptom: the "Webansicht erzeugen"
-- button reported success in the UI (toast on enqueue ack) but the worker
-- never received a request. This helper widens the surface to all non-
-- archived states for the project-customer + captured_by; operator stays
-- universal. Edit-helper is untouched.

CREATE OR REPLACE FUNCTION public.spatial_can_convert_scan(p_scan_id uuid, p_uid uuid)
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
      WHERE s.id = p_scan_id
        AND s.status <> 'archived'
        AND s.status <> 'locked_for_dispute'
        AND (
          p.customer_user_id = p_uid
          OR s.captured_by   = p_uid
        )
    );
$$;

REVOKE EXECUTE ON FUNCTION public.spatial_can_convert_scan(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.spatial_can_convert_scan(uuid, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.spatial_can_convert_scan(uuid, uuid) TO authenticated;
GRANT  EXECUTE ON FUNCTION public.spatial_can_convert_scan(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.spatial_can_convert_scan IS
  'P0 review fix — convert-permission helper. Wider than spatial_can_edit_scan: captured_by retains convert-trigger access through captured/quality_checked/etc, but loses it on archived + locked_for_dispute.';
