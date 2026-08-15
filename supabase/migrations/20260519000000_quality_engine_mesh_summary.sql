-- Spatial Core · Phase 2 · Quality Engine — Mesh-Summary RPC Overload
--
-- Adds a 2-argument overload of `public.run_quality_engine` that accepts the
-- Phase 2 harvested mesh aggregate as a jsonb parameter, so the SECURITY
-- DEFINER RPC can evaluate Rule R6 (wall_coverage_low) and Rule R7
-- (mesh-preference branch of low_confidence) on real data instead of the
-- Plan B path documented in `20260518000020_quality_engine_rpc.sql`.
--
-- ## Why an overload instead of CREATE OR REPLACE
--
-- Postgres treats functions with different argument lists as separate
-- entities — `CREATE OR REPLACE FUNCTION run_quality_engine(uuid, jsonb)`
-- does NOT replace the 1-arg version, it creates a sibling overload.
-- Keeping both lets pre-Phase-2 callers keep working (defensive) while the
-- TS repository client moves to the 2-arg shape. The 1-arg signature is
-- marked deprecated via COMMENT; it will be dropped once the rollout has
-- been live for 7 days with zero invocations recorded.
--
-- ## Parity contract (TS ↔ SQL)
--
-- The TS engine reads `MeshSummary { wallCoveragePct?, averageConfidence?,
-- triangleCount? }` (see `src/lib/spatial/quality/rules.ts`). The SQL
-- overload reads:
--   * `p_mesh_summary->>'wallCoveragePct'`     → R6 (weight 14)
--   * `p_mesh_summary->>'averageConfidence'`   → R7 mesh-branch (weight 10)
--   * `triangleCount` is forensic-only; no rule reads it on either side.
-- Both engines apply the same QUALITY_THRESHOLDS constants (0.7 floor for
-- R6, 0.5 floor for R7). Drift is exercised by
-- `tests/lib/spatial/qualityEngine.parity.test.ts`.
--
-- ## Hardening
--
-- Same SECURITY DEFINER + spatial_can_view_scan gate as the 1-arg version.
-- `p_mesh_summary` is read-only (we never persist the jsonb beyond the
-- forensic `quality_run` audit payload), so no extra RLS surface.

CREATE OR REPLACE FUNCTION public.run_quality_engine(
  p_scan_id uuid,
  p_mesh_summary jsonb DEFAULT NULL
)
RETURNS public.scan_quality_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid             uuid := auth.uid();
  v_room            public.scan_rooms;
  v_wall_count      int  := 0;
  v_door_count      int  := 0;
  v_window_count    int  := 0;
  v_door_bad        boolean := false;
  v_window_bad      boolean := false;
  v_avg_conf        numeric;
  v_mesh_wall_cov   numeric;
  v_mesh_avg_conf   numeric;
  v_score           int  := 100;
  v_warnings        text[] := ARRAY[]::text[];
  v_bucket          public.scan_quality_bucket;
  v_report          public.scan_quality_reports;
  v_area            numeric;
  v_ceiling         numeric;
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

  -- ── Phase 2: pull mesh-derived numbers when caller supplied the aggregate
  IF p_mesh_summary IS NOT NULL THEN
    -- jsonb ->> returns text; safe-cast to numeric, NULL on missing / bad.
    BEGIN
      v_mesh_wall_cov := (p_mesh_summary ->> 'wallCoveragePct')::numeric;
    EXCEPTION WHEN others THEN
      v_mesh_wall_cov := NULL;
    END;
    BEGIN
      v_mesh_avg_conf := (p_mesh_summary ->> 'averageConfidence')::numeric;
    EXCEPTION WHEN others THEN
      v_mesh_avg_conf := NULL;
    END;
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

  -- ── Rule R6: wall_coverage_low (weight 14) — Phase 2 mesh-branch ────────
  -- TS parity: rules.ts ruleWallCoverageLow returns null when meshSummary or
  -- meshSummary.wallCoveragePct is undefined. Below the 0.7 floor → warning.
  IF v_mesh_wall_cov IS NOT NULL AND v_mesh_wall_cov < 0.7 THEN
    v_warnings := array_append(v_warnings, 'wall_coverage_low');
    v_score    := v_score - 14;
  END IF;

  -- ── Rule R7: low_confidence (weight 10) ─────────────────────────────────
  -- TS parity: rules.ts ruleLowConfidence prefers meshSummary.averageConfidence
  -- when present (mesh-branch), falls back to the surface-confidence average
  -- otherwise. Both branches share the same 0.5 floor.
  IF v_mesh_avg_conf IS NOT NULL THEN
    IF v_mesh_avg_conf < 0.5 THEN
      v_warnings := array_append(v_warnings, 'low_confidence');
      v_score    := v_score - 10;
    END IF;
  ELSIF v_avg_conf IS NOT NULL AND v_avg_conf < 0.5 THEN
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
  -- meshSummaryUsed surfaces in the audit payload so operators can tell at
  -- a glance whether R6/R7 evaluated against real data or fell through.
  PERFORM public.record_scan_event(
    p_scan_id,
    'quality_run'::public.scan_event_action,
    jsonb_build_object(
      'score',           v_score,
      'bucket',          v_bucket,
      'warnings',        v_warnings,
      'engineVersion',   'v1.0.0',
      'reportId',        v_report.id,
      'meshSummaryUsed', (p_mesh_summary IS NOT NULL)
    ),
    NULL
  );

  RETURN v_report;
END;
$$;

COMMENT ON FUNCTION public.run_quality_engine(uuid, jsonb)
  IS 'Spatial Core · Phase 2 · Server-authoritative Quality Engine V1 with mesh-aware R6/R7. Mirrors src/lib/spatial/quality/rules.ts. Inserts scan_quality_reports row + emits quality_run audit event. EXECUTE granted to authenticated; gate via spatial_can_view_scan. The 1-arg sibling (`run_quality_engine(uuid)`) stays for backwards-compat and is deprecated; drop scheduled once metrics confirm zero callers for 7 consecutive days.';

REVOKE EXECUTE ON FUNCTION public.run_quality_engine(uuid, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.run_quality_engine(uuid, jsonb) TO authenticated;

-- Mark the 1-arg overload deprecated so anyone touching it next sees the
-- migration story. We deliberately do NOT drop it here — that's a separate
-- migration after the 7-day rollout window passes.
COMMENT ON FUNCTION public.run_quality_engine(uuid)
  IS 'DEPRECATED 2026-05-18 (Phase 2): superseded by run_quality_engine(uuid, jsonb). Kept for backwards-compat during rollout. Scheduled for DROP in a follow-up migration once supabase metrics confirm zero callers for 7+ days.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.run_quality_engine(uuid, jsonb);
-- COMMENT ON FUNCTION public.run_quality_engine(uuid)
--   IS 'Spatial Core: server-authoritative Quality Engine V1. Mirrors src/lib/spatial/quality/rules.ts. Inserts scan_quality_reports row + emits quality_run audit event. EXECUTE granted to authenticated; gate via spatial_can_view_scan.';
