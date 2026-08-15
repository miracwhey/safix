-- =============================================================================
-- Migration: Block 5 – thread_artifacts optimistic concurrency version column
-- =============================================================================
-- Adds a `version` column to support Compare-And-Swap (CAS) updates in
-- SupabaseThreadArtifactRepository. The version is incremented on every
-- successful UPDATE. If two concurrent writes target the same version, the
-- second write affects 0 rows — the repository treats this as a ConflictError
-- and surfaces it to the workflow layer so the user sees a meaningful error.
--
-- DEFAULT 0: existing rows are initialized with version 0 so the first CAS
-- update succeeds (expectedVersion=0 → writes version=1).
-- =============================================================================

ALTER TABLE public.thread_artifacts
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0;
