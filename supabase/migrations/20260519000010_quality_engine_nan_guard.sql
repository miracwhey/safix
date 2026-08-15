-- Spatial Core · Phase 2 · Quality Engine — NaN guard for mesh-summary jsonb
--
-- The 2-arg overload `public.run_quality_engine(uuid, jsonb)` cast
-- `p_mesh_summary->>'wallCoveragePct'` and `'averageConfidence'` to numeric.
-- jsonb_array_to_text + ::numeric will happily produce a Postgres `NaN`
-- value when the JSON contains the string `"NaN"`. Both R6 and R7 then
-- compare with `< 0.7` / `< 0.5` — but every comparison involving NaN
-- returns `false`, so the rules silently miss. Same hazard for `'Infinity'`.
--
-- TS callers never emit `"NaN"` (JSON.stringify(NaN) → null) but a future
-- server-stitched payload or a manual psql caller can. Patch both rule
-- evaluations to reject NaN/Infinity via `IS DISTINCT FROM 'NaN'::numeric`
-- before the comparison.
--
-- Plus: refine the audit-payload `meshSummaryUsed` flag so it only fires
-- when the jsonb ACTUALLY contained one of the fields the rules consume —
-- an empty object `{}` no longer reports `meshSummaryUsed=true`.
--
-- Parity sweep: `src/lib/spatial/quality/rules.ts` is unaffected; JS NaN
-- comparisons also evaluate `false` consistently. The InMemory mirror
-- adds `meshSummaryUsed` to its audit payload via TS — see
-- `InMemorySpatialRepository.ts` companion change in the same commit.

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
  v_mesh_used       boolean := false;
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

  -- ── Phase 2: pull mesh-derived numbers when caller supplied the aggregate.
  --   Keys are camelCase by convention (TS callers emit camelCase via
  --   supabase-js); snake_case payloads will silently skip the rule.
  IF p_mesh_summary IS NOT NULL THEN
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
  -- Reject NaN/Infinity explicitly: `NaN < 0.7` returns false, which would
  -- silently miss the rule. `IS DISTINCT FROM 'NaN'::numeric` filters both
  -- positive and negative NaN encodings. Infinity passes the < check
  -- normally so no extra guard needed there for R6 (huge wallCoverage = OK).
  IF v_mesh_wall_cov IS NOT NULL
     AND v_mesh_wall_cov IS DISTINCT FROM 'NaN'::numeric
     AND v_mesh_wall_cov < 0.7 THEN
    v_warnings := array_append(v_warnings, 'wall_coverage_low');
    v_score    := v_score - 14;
  END IF;

  -- ── Rule R7: low_confidence (weight 10) ─────────────────────────────────
  -- Mesh-branch wins over surface-fallback ONLY when meshSummary supplied a
  -- non-NaN value. Otherwise we fall through to the surface average, same
  -- as the 1-arg legacy behaviour.
  IF v_mesh_avg_conf IS NOT NULL
     AND v_mesh_avg_conf IS DISTINCT FROM 'NaN'::numeric THEN
    IF v_mesh_avg_conf < 0.5 THEN
      v_warnings := array_append(v_warnings, 'low_confidence');
      v_score    := v_score - 10;
    END IF;
  ELSIF v_avg_conf IS NOT NULL AND v_avg_conf < 0.5 THEN
    v_warnings := array_append(v_warnings, 'low_confidence');
    v_score    := v_score - 10;
  END IF;

  -- meshSummaryUsed: only true when the jsonb actually carried at least one
  -- field consumed by R6 or R7 (after NaN filter). An empty object `{}` no
  -- longer reports as "used" — the audit row stays semantically accurate.
  v_mesh_used := (v_mesh_wall_cov IS NOT NULL AND v_mesh_wall_cov IS DISTINCT FROM 'NaN'::numeric)
              OR (v_mesh_avg_conf IS NOT NULL AND v_mesh_avg_conf IS DISTINCT FROM 'NaN'::numeric);

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
  PERFORM public.record_scan_event(
    p_scan_id,
    'quality_run'::public.scan_event_action,
    jsonb_build_object(
      'score',           v_score,
      'bucket',          v_bucket,
      'warnings',        v_warnings,
      'engineVersion',   'v1.0.0',
      'reportId',        v_report.id,
      'meshSummaryUsed', v_mesh_used
    ),
    NULL
  );

  RETURN v_report;
END;
$$;

COMMENT ON FUNCTION public.run_quality_engine(uuid, jsonb)
  IS 'Spatial Core · Phase 2 + NaN-hardening · Server-authoritative Quality Engine V1 with mesh-aware R6/R7. Mirrors src/lib/spatial/quality/rules.ts. NaN/string-encoded-NaN inputs explicitly rejected before R6/R7 comparisons. meshSummaryUsed audit flag fires only when a non-NaN consumed field was present. EXECUTE granted to authenticated; gate via spatial_can_view_scan.';

-- ── Rollback ──────────────────────────────────────────────────────────────────
-- The previous body lives in 20260519000000_quality_engine_mesh_summary.sql;
-- re-apply that file to revert the NaN guard. The 1-arg overload sibling is
-- unchanged by this migration.
