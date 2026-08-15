-- =============================================================================
-- Migration: Calendar Entries — Allow job_id NULL for custom entries
-- =============================================================================
-- Root cause of production error 23502:
--   calendar_entries.job_id is NOT NULL, but custom calendar entries
--   (kind: 'custom', e.g. "Baumarkt", "Besprechung") have no job_id.
--   The repository correctly sends job_id: null for custom entries;
--   the NOT NULL constraint rejects every such INSERT.
--
-- Fix:
--   1. Drop the NOT NULL constraint on job_id.
--      The FK (REFERENCES jobs ON DELETE CASCADE) is preserved: a non-null
--      job_id still enforces referential integrity; a null job_id simply
--      means no FK reference (standard PostgreSQL FK behaviour).
--
--   2. Add a CHECK constraint that enforces the new scope invariant:
--      every row must be anchored to at least one scope:
--        - provider_id IS NOT NULL   →  custom or job entry with company scope
--        - job_id IS NOT NULL        →  legacy/backfill job entry (provider_id may still be null)
--      Both being non-null is also valid (job entry after provider backfill).
--      Both being null is rejected.
--
-- RLS:
--   No changes required. The existing calendar_entries_owner_insert policy
--   already allows INSERT when (provider_id IS NOT NULL AND owner), which
--   covers custom entries whose provider_id is injected by the repository.
--
-- Safety:
--   - DROP NOT NULL is idempotent: safe to re-run on an already-nullable column.
--   - ADD CONSTRAINT uses a DO block to guard against duplicate constraint names.
--   - All existing rows satisfy (job_id IS NOT NULL) so the new CHECK passes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Allow job_id to be NULL (drop NOT NULL constraint)
-- ---------------------------------------------------------------------------

ALTER TABLE public.calendar_entries
  ALTER COLUMN job_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Enforce scope invariant: every row must have at least one of
--    (provider_id, job_id) set — prevents orphaned rows with neither.
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_entries_requires_scope'
      AND conrelid = 'public.calendar_entries'::regclass
  ) THEN
    ALTER TABLE public.calendar_entries
      ADD CONSTRAINT calendar_entries_requires_scope
      CHECK (job_id IS NOT NULL OR provider_id IS NOT NULL);
  END IF;
END $$;
