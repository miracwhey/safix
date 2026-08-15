-- Spatial V1.6.1 · L4.b — column-scoped customer-verify-state RPC.
--
-- THE Stage-5 blocker: persistVerifyState writes customer_verify_state via a
-- bare spatial_scenes UPDATE, whose WITH CHECK is spatial_can_edit_scene. That
-- is FALSE for a customer on a craftsman-owned (HW-shared) scene — correct for
-- the parametric blob (migration 20260529194918 fixed the blob-clobber), but it
-- also blocks the customer's own verify-state tracking columns, so the verify
-- confirm silently fails (swallowed best-effort) and never persists 'approved'.
--
-- Fix: a SECURITY DEFINER RPC that bypasses the can-edit WITH CHECK but
--   (a) re-imposes a CUSTOMER-RECIPIENT gate (operator OR scene customer OR
--       HW-shared recipient OR customer self-scan capturer — deliberately NOT
--       the provider; verify is the customer's act), and
--   (b) writes ONLY the three customer_verify_* tracking columns, NEVER the
--       parametric blob pointer — so the blob-clobber protection is preserved.
--
-- The recipient gate mirrors the customer branches of spatial_can_view_scene
-- (20260525062412) minus the provider branch. The FSM trigger
-- (spatial_scenes_customer_verify_fsm) + dispute-lock guard still fire on the
-- UPDATE (triggers are not RLS), so transition legality + dispute locks remain
-- authoritative; an illegal transition raises 45SPF (rewrapped client-side as
-- SpatialFsmViolation, identical to the bare update() path).
--
-- p_state / p_stage are NULL-safe: a stage-only "touch" passes p_state=NULL and
-- COALESCE leaves the FSM column unchanged (no transition → trigger no-ops).
-- The server stamps customer_verify_last_active_at = now() on every call.

CREATE OR REPLACE FUNCTION public.spatial_set_customer_verify_state(
  p_scene_id uuid,
  p_state    text DEFAULT NULL::text,
  p_stage    integer DEFAULT NULL::integer
)
 RETURNS public.spatial_scenes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid            uuid;
  v_customer_id    uuid;
  v_source_scan_id uuid;
  v_scene          public.spatial_scenes;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: authentication required'
      USING ERRCODE = '28000';
  END IF;

  IF p_state IS NOT NULL
     AND p_state NOT IN ('not_started','in_progress','approved','rejected','expired')
  THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: invalid state %', p_state
      USING ERRCODE = '22023';
  END IF;
  IF p_stage IS NOT NULL AND (p_stage < 1 OR p_stage > 5) THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: invalid stage % (must be 1-5)', p_stage
      USING ERRCODE = '22023';
  END IF;

  SELECT customer_id, source_scan_id
    INTO v_customer_id, v_source_scan_id
    FROM public.spatial_scenes
    WHERE id = p_scene_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spatial_set_customer_verify_state: scene % not found', p_scene_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Customer-recipient gate (NOT the provider). Mirrors the customer branches
  -- of spatial_can_view_scene.
  IF NOT (
    public.spatial_is_operator(v_uid)
    OR v_uid = v_customer_id
    OR (
      v_source_scan_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.scans sc
        JOIN public.jobs  j ON j.id = sc.job_id
        WHERE sc.id = v_source_scan_id
          AND sc.shared_with_customer = true
          AND j.customer_user_id = v_uid
      )
    )
    OR (
      v_customer_id IS NULL
      AND v_source_scan_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.scans sc
        WHERE sc.id = v_source_scan_id
          AND sc.owner_type = 'customer'
          AND sc.captured_by = v_uid
      )
    )
  ) THEN
    RAISE EXCEPTION
      'spatial_set_customer_verify_state: caller is not the scene customer (scene=%)', p_scene_id
      USING ERRCODE = '42501';
  END IF;

  -- Column-scoped write — ONLY the verify tracking columns, NEVER the blob.
  -- COALESCE keeps a column unchanged when the caller passes NULL.
  UPDATE public.spatial_scenes
     SET customer_verify_state         = COALESCE(p_state, customer_verify_state),
         customer_verify_last_stage     = COALESCE(p_stage, customer_verify_last_stage),
         customer_verify_last_active_at = now()
   WHERE id = p_scene_id
  RETURNING * INTO v_scene;

  RETURN v_scene;
END;
$function$;

REVOKE ALL ON FUNCTION public.spatial_set_customer_verify_state(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.spatial_set_customer_verify_state(uuid, text, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
