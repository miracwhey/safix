-- Spatial V1.6.1 · SECURITY FIX — NULL-poisoned recipient gate in
-- spatial_set_customer_verify_state (introduced by 20260601100200).
--
-- ── The bug (found by behavioral prod-repro 2026-06-01) ─────────────────────
-- The recipient gate was:
--     IF NOT (
--          spatial_is_operator(v_uid)
--       OR v_uid = v_customer_id                       -- ← THREE-VALUED-LOGIC TRAP
--       OR (HW-shared recipient …)
--       OR (customer self-scan capturer …)
--     ) THEN RAISE 42501; END IF;
--
-- For a customer SELF-SCAN scene, spatial_scenes.customer_id IS NULL. SQL
-- evaluates `v_uid = NULL` to NULL (not FALSE). When the caller is NOT a
-- legitimate recipient, every other branch is FALSE, so the OR chain collapses
-- to `FALSE OR NULL OR FALSE OR FALSE = NULL`, `NOT NULL = NULL`, and plpgsql
-- treats an `IF NULL` as not-taken → the RAISE is SKIPPED and the UPDATE
-- proceeds. Net effect: ANY authenticated user could set customer_verify_state
-- on ANY customer self-scan scene (all 7 prod scenes have customer_id = NULL).
--
-- A privileged path (MCP execute_sql) cannot catch this — auth.uid() never
-- fires there. It was confirmed with two real signed-in sessions: a
-- non-recipient's spatial_set_customer_verify_state call returned the updated
-- row instead of 42501.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- NULL-guard the equality so a NULL customer_id yields FALSE, not NULL:
--     OR (v_customer_id IS NOT NULL AND v_uid = v_customer_id)
-- The legitimate self-scan customer is still authorized via the dedicated
-- self-scan branch (customer_id IS NULL AND captured_by = v_uid). Body-only
-- CREATE OR REPLACE — signature + grants unchanged. No other branch is affected
-- (branches 3 & 4 are EXISTS/IS-NULL, never NULL-valued).

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
  -- of spatial_can_view_scene. The customer_id equality is NULL-guarded: a
  -- self-scan scene has customer_id IS NULL, and a bare `v_uid = NULL` would
  -- poison the whole OR chain to NULL and silently skip the RAISE.
  IF NOT (
    public.spatial_is_operator(v_uid)
    OR (v_customer_id IS NOT NULL AND v_uid = v_customer_id)
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
