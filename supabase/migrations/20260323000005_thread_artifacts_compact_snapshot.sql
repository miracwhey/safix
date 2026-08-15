-- ============================================================================
-- Migration: thread_artifacts compact card snapshot hardening
-- ============================================================================
--
-- Adds snapshot columns for category, location, budget range, and timing
-- preference so the compact project card in the chat timeline can render
-- these fields immediately without waiting for project entity hydration.
--
-- Before this migration, these fields were only available via read-time
-- entity enrichment.  After this migration, they are persisted at write
-- time alongside the existing snapshotTitle / snapshotStatus / snapshotSummary.
--
-- ── New Columns ───────────────────────────────────────────────────────────

ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_category TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_location TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_budget   TEXT;
ALTER TABLE thread_artifacts ADD COLUMN IF NOT EXISTS snapshot_timing   TEXT;

-- ── Backfill: Populate from projects table ────────────────────────────────

UPDATE thread_artifacts ta
SET
  snapshot_category = p.category,
  snapshot_location = p.location,
  snapshot_budget   = p.requested_budget,
  snapshot_timing   = p.requested_timing
FROM projects p
WHERE ta.artifact_type = 'project'
  AND ta.project_id = p.id
  AND ta.snapshot_category IS NULL;
