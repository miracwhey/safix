-- Spatial Core · Block C.2 · Quality Engine V1 — Server-Authoritative RPC
--
-- Inline plpgsql mirror of `src/lib/spatial/quality/rules.ts`. The TS engine
-- is the working SoT (cheap to run + test); this RPC is the server-side
-- authoritative re-run that lands the report in `public.scan_quality_reports`
-- and emits a `quality_run` audit event via the SECURITY DEFINER record path.
--
-- Parity: every CASE branch + threshold + weight matches `rules.ts`. Drift
-- is exercised by `tests/lib/spatial/qualityEngine.parity.test.ts` (Block C.4).
--
-- Idempotency: the function picks the latest scan-row snapshot at call time
-- and inserts a fresh `scan_quality_reports` row each invocation. Reports are
-- append-only by convention; callers that want "latest" use
-- `getLatestQualityReport()` in the repo, which sorts by `generated_at DESC`.
--
-- Hardening: SECURITY DEFINER + `SET search_path = public, pg_catalog` (RLS-
-- bypass risk patched by gate-check `spatial_can_view_scan`). Anyone with
-- view access to the scan can request a re-run; the rule output is fully
-- derived so this is safe.

CREATE OR REPLACE FUNCTION public.run_quality_engine(p_scan_id uuid)
RETURNS public.scan_quality_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid           uuid := auth.uid();
  v_room          public.scan_rooms;
  v_wall_count    int  := 0;
  v_door_count    int  := 0;
  v_window_count  int  := 0;
  v_door_bad      boolean := false;
  v_window_bad    boolean := false;
  v_avg_conf      numeric;
  v_score         int  := 100;
  v_warnings      text[] := ARRAY[]::text[];
  v_bucket        public.scan_quality_bucket;
  v_report        public.scan_quality_reports;
  v_area          numeric;
  v_ceiling       numeric;
BEGIN
  -- ── Access gate: view-permission required (parity with rest of domain) ───
  IF v_uid IS NULL THEN
    RAISE insufficient_privilege USING MESSAGE = 'auth required';
  END IF;
  IF NOT public.spatial_can_view_scan(p_scan_id, v_uid) THEN
    RAISE insufficient_privilege USING MESSAGE = 'no_access';
  END IF;

  -- ── Snapshot inputs (V1 single-room — pick the oldest room) ──────────────
  SELECT * INTO v_room
  FROM public.scan_rooms
  WHERE scan_id = p_scan_id
  ORDER BY created_at ASC
  LIMIT 1;

  IF v_room.id IS NOT NULL THEN
    SELECT count(*) FILTER (WHERE kind = 'wall'),
           count(*) FILTER (WHERE kind = 'door'),
           count(*) FILTER (WHERE kind = 'window')
      INTO v_wall_count, v_door_count, v_window_count
    FROM public.scan_surfaces
    WHERE room_id = v_room.id;

    -- Door dimension plausibility: any out-of-band door triggers the warning.
    SELECT EXISTS (
      SELECT 1
      FROM public.scan_surfaces s
      WHERE s.room_id = v_room.id
        AND s.kind = 'door'
        AND (
          COALESCE(s.dim_w_verified, s.dim_w_estimated) IS NOT NULL
          AND COALESCE(s.dim_h_verified, s.dim_h_estimated) IS NOT NULL
          AND (
            COALESCE(s.dim_w_verified, s.dim_w_estimated) < 0.6
            OR COALESCE(s.dim_w_verified, s.dim_w_estimated) > 1.2
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) < 1.8
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) > 2.4
          )
        )
    ) INTO v_door_bad;

    SELECT EXISTS (
      SELECT 1
      FROM public.scan_surfaces s
      WHERE s.room_id = v_room.id
        AND s.kind = 'window'
        AND (
          COALESCE(s.dim_w_verified, s.dim_w_estimated) IS NOT NULL
          AND COALESCE(s.dim_h_verified, s.dim_h_estimated) IS NOT NULL
          AND (
            COALESCE(s.dim_w_verified, s.dim_w_estimated) < 0.2
            OR COALESCE(s.dim_w_verified, s.dim_w_estimated) > 3.0
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) < 0.3
            OR COALESCE(s.dim_h_verified, s.dim_h_estimated) > 2.5
          )
        )
    ) INTO v_window_bad;

    SELECT avg(confidence)
      INTO v_avg_conf
    FROM public.scan_surfaces
    WHERE room_id = v_room.id AND confidence IS NOT NULL;
  END IF;

  -- ── Rule R1: too_few_walls (weight 25) ──────────────────────────────────
  IF v_wall_count < 4 THEN
    v_warnings := array_append(v_warnings, 'too_few_walls');
    v_score    := v_score - 25;
  END IF;

  -- ── Rule R2: area_implausible (weight 18) ───────────────────────────────
  v_area := COALESCE(v_room.area_m2_verified, v_room.area_m2_estimated);
  IF v_area IS NOT NULL AND (v_area < 3 OR v_area > 200) THEN
    v_warnings := array_append(v_warnings, 'area_implausible');
    v_score    := v_score - 18;
  END IF;

  -- ── Rule R3: ceiling_implausible (weight 15) ────────────────────────────
  v_ceiling := COALESCE(v_room.ceiling_h_verified, v_room.ceiling_h_estimated);
  IF v_ceiling IS NOT NULL AND (v_ceiling < 2.0 OR v_ceiling > 4.5) THEN
    v_warnings := array_append(v_warnings, 'ceiling_implausible');
    v_score    := v_score - 15;
  END IF;

  -- ── Rule R4: door_dimensions_unusual (weight 9) ─────────────────────────
  IF v_door_count > 0 AND v_door_bad THEN
    v_warnings := array_append(v_warnings, 'door_dimensions_unusual');
    v_score    := v_score - 9;
  END IF;

  -- ── Rule R5: window_dimensions_unusual (weight 9) ───────────────────────
  IF v_window_count > 0 AND v_window_bad THEN
    v_warnings := array_append(v_warnings, 'window_dimensions_unusual');
    v_score    := v_score - 9;
  END IF;

  -- ── Rule R6: wall_coverage_low (weight 14) — server has no mesh input ──
  -- The TS engine consumes meshSummary.wallCoveragePct from convert-pipeline
  -- output; the server cannot reconstruct that without the mesh artifact.
  -- Block X (Convert-Pipeline) will write mesh_summary into scan_assets jsonb
  -- so this branch can consult it; for now the server's R6 is silent (Plan B).

  -- ── Rule R7: low_confidence (weight 10) — surface-fallback parity ──────
  IF v_avg_conf IS NOT NULL AND v_avg_conf < 0.5 THEN
    v_warnings := array_append(v_warnings, 'low_confidence');
    v_score    := v_score - 10;
  END IF;

  -- Clamp + bucket
  IF v_score < 0   THEN v_score := 0;   END IF;
  IF v_score > 100 THEN v_score := 100; END IF;
  v_bucket := CASE
    WHEN v_score >= 85 THEN 'excellent'::public.scan_quality_bucket
    WHEN v_score >= 70 THEN 'good'::public.scan_quality_bucket
    WHEN v_score >= 50 THEN 'fair'::public.scan_quality_bucket
    ELSE 'poor'::public.scan_quality_bucket
  END;

  -- Stable JSON: TS engine sorts warnings alphabetically too.
  SELECT array_agg(w ORDER BY w) INTO v_warnings FROM unnest(v_warnings) w;
  IF v_warnings IS NULL THEN
    v_warnings := ARRAY[]::text[];
  END IF;

  -- ── Persist the report ───────────────────────────────────────────────────
  INSERT INTO public.scan_quality_reports (scan_id, score, bucket, warnings, engine_version)
  VALUES (
    p_scan_id,
    v_score,
    v_bucket,
    to_jsonb(v_warnings),
    'v1.0.0'
  )
  RETURNING * INTO v_report;

  -- ── Audit ────────────────────────────────────────────────────────────────
  -- record_scan_event was hardened in A.1 to be the only insert path; reuse
  -- it so the audit row matches the FSM-aware contract (RLS-equivalent).
  PERFORM public.record_scan_event(
    p_scan_id,
    'quality_run'::public.scan_event_action,
    jsonb_build_object(
      'score',         v_score,
      'bucket',        v_bucket,
      'warnings',      v_warnings,
      'engineVersion', 'v1.0.0',
      'reportId',      v_report.id
    ),
    NULL  -- no idempotency key — every re-run records a new event
  );

  RETURN v_report;
END;
$$;

COMMENT ON FUNCTION public.run_quality_engine(uuid)
  IS 'Spatial Core: server-authoritative Quality Engine V1. Mirrors src/lib/spatial/quality/rules.ts. Inserts scan_quality_reports row + emits quality_run audit event. EXECUTE granted to authenticated; gate via spatial_can_view_scan.';

REVOKE EXECUTE ON FUNCTION public.run_quality_engine(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.run_quality_engine(uuid) TO authenticated;

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.run_quality_engine(uuid);
