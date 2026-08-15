-- =============================================================================
-- Migration: Calendar Entries — Add description column for custom entries
-- =============================================================================
-- Custom calendar entries (kind: 'custom') support an optional notes field
-- visible in the entry detail. Job-derived entries always store '' (empty).
-- The column is text NOT NULL with empty-string default so existing rows and
-- all job-derived inserts need no special handling.
-- =============================================================================

ALTER TABLE public.calendar_entries
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
