-- Spatial V1.6 · Phase 2 · LiDAR Customer-Capture · Quality-Score Columns
--
-- Adds two nullable columns to public.scans for computed scan quality:
--   quality_score  smallint NULL  0-100 integer score
--   quality_label  text     NULL  denormalised label tier ('high'/'medium'/'low')
--
-- Design:
--   • NULL = score not yet computed (e.g. Manual-Preset scans, pre-Phase-2 rows).
--     The UI renders a "—" / hidden pill for NULL rows.  No backfill needed.
--   • Score is computed in scanQualityScore.ts (client-side, from RoomScanResult)
--     and written at scan-INSERT time for LiDAR captures.
--   • quality_label is denormalised from quality_score to allow cheap indexed
--     filters ("show only high-quality scans") without recomputing thresholds in
--     SQL.  Label thresholds are locked in scanQualityScore.ts:
--       ≥ 80 → 'high'  /  50-79 → 'medium'  /  < 50 → 'low'
--   • RLS: UNCHANGED.  scans_select policy (Block 1 + Block 1 RLS rewrite) gates
--     on spatial_can_view_scan — quality_score/quality_label are plain readable
--     columns on any scan the caller already has SELECT access to.  No extra
--     column-level policy needed.
--   • REPLICA IDENTITY FULL was set on scans in Block 1 migration
--     (20260525062334_spatial_lane_3_block_1_schema.sql).  NOT re-applied here.
--
-- Affected domains after apply:
--   src/lib/spatial/quality/scanQualityScore.ts
--   src/lib/spatial/repository/SupabaseSpatialRepository.ts  (+ quality_score/label in INSERT payload)
--   src/components/spatial/customer/ScanQualityPill.tsx
--
-- Apply: isolated OK (no dependency on F2 mesh-snapshot bucket).
--        Run F1 before any Phase 2 build work begins.

-- ── quality_score column ───────────────────────────────────────────────────────

ALTER TABLE public.scans
  ADD COLUMN IF NOT EXISTS quality_score smallint NULL;

ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_quality_score_chk;

ALTER TABLE public.scans
  ADD CONSTRAINT scans_quality_score_chk
  CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100);

COMMENT ON COLUMN public.scans.quality_score IS
  'V1.6 Phase 2: computed scan quality on a 0-100 integer scale.'
  ' NULL = not computed (Manual-Preset captures, legacy rows).'
  ' Written at INSERT time for LiDAR captures; never recomputed in-place (new scan = new row per B4-D7).'
  ' Thresholds: ≥80 high / 50-79 medium / <50 low — canonical in scanQualityScore.ts.';

-- ── quality_label column ──────────────────────────────────────────────────────

ALTER TABLE public.scans
  ADD COLUMN IF NOT EXISTS quality_label text NULL;

ALTER TABLE public.scans
  DROP CONSTRAINT IF EXISTS scans_quality_label_chk;

ALTER TABLE public.scans
  ADD CONSTRAINT scans_quality_label_chk
  CHECK (quality_label IS NULL OR quality_label IN ('high', 'medium', 'low'));

COMMENT ON COLUMN public.scans.quality_label IS
  'V1.6 Phase 2: denormalised quality label derived from quality_score.'
  ' NULL when quality_score IS NULL.'
  ' Values: high (≥80) / medium (50-79) / low (<50).'
  ' Kept in sync by application layer at INSERT time — never updated independently.';

-- ── Partial index (conservative) ──────────────────────────────────────────────
-- Guards the "show only high-quality scans" filter query that already exists in
-- the Phase 2 spec (Scan-Picker Dropdown sorted by Quality, Quality-Pill filter).
-- WHERE clause excludes NULL rows (pre-Phase-2 scans) keeping index small.
-- If this filter is never used after Phase 2 ships, drop via rollback below.

CREATE INDEX IF NOT EXISTS scans_quality_label_idx
  ON public.scans (job_id, quality_label)
  WHERE quality_label IS NOT NULL;

-- ── RLS: no change ────────────────────────────────────────────────────────────
-- scans_select USING → spatial_can_view_scan (Block 1 RLS, 20260525062412).
-- scans_insert WITH CHECK → captured_by = auth.uid() + owner/job/presales branch.
-- scans_update  USING+CHECK → spatial_can_edit_scan.
-- All three policies apply transparently to the two new columns; no policy DDL
-- required here.

-- ── Schema cache reload ───────────────────────────────────────────────────────
-- Required: two new columns added to scans — PostgREST must re-introspect.
-- See: feedback_postgrest_schema_cache_reload

NOTIFY pgrst, 'reload schema';

-- ── Rollback (run manually — NOT part of apply) ───────────────────────────────
-- DROP INDEX  IF EXISTS public.scans_quality_label_idx;
-- ALTER TABLE public.scans DROP CONSTRAINT IF EXISTS scans_quality_label_chk;
-- ALTER TABLE public.scans DROP CONSTRAINT IF EXISTS scans_quality_score_chk;
-- ALTER TABLE public.scans DROP COLUMN IF EXISTS quality_label;
-- ALTER TABLE public.scans DROP COLUMN IF EXISTS quality_score;
-- NOTIFY pgrst, 'reload schema';
