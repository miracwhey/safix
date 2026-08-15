-- Spatial V1.6.1 · H1 audit-fix — optimistic-concurrency token for spatial_scenes.
--
-- Latent split-brain hole: spatial_scenes_update lets both the customer_corrections
-- and provider writers overwrite parametric_storage_path / sha / size with no
-- version token → last-write-wins clobber. The compare-and-set lives in the
-- repository (SupabaseSpatialSceneRepository.update(): bump + .eq('parametric_version',
-- expected); 0 rows → CanonicalError('CONFLICT')); this migration only adds the
-- column, mirroring the thread_artifacts.version template (20260420000009).
--
-- Clean window at authoring time (verified via prod SELECT 2026-06-01): 7 scenes,
-- all customer self-scans, 0 provider/job-anchored, 0 edit_history — so the
-- NOT NULL DEFAULT 0 back-fill is a no-op on live rows.
--
-- parametric_version is NOT listed in spatial_scenes_immutable_cols_guard, so
-- the per-update bump is permitted (no trigger conflict). No RLS change.

ALTER TABLE public.spatial_scenes
  ADD COLUMN IF NOT EXISTS parametric_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.spatial_scenes.parametric_version IS
  'H1 audit-fix · optimistic-concurrency token. Bumped on every repository update() '
  'via compare-and-set so a concurrent writer surfaces CONFLICT instead of clobbering '
  'the parametric blob pointer. The column-scoped verify-state RPC does not touch it.';

-- Refresh PostgREST''s schema cache so the new column is selectable immediately.
NOTIFY pgrst, 'reload schema';
