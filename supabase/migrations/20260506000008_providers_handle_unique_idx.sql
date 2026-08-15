-- 20260506000008_providers_handle_unique_idx.sql
--
-- Add unique index on providers.handle so that:
--   1. Handle-based routing (/explore/@:handle) resolves to exactly one profile.
--   2. updateProviderProfile's 23505 catch is backed by an actual DB constraint.
--
-- Partial index: only rows WHERE handle IS NOT NULL AND handle <> '' are
-- covered, matching the existing CHECK constraint (providers_handle_not_blank_check).
-- NULL handles are excluded (NULL <> NULL in SQL uniqueness).
--
-- Pre-check: all 4 prod providers have unique, non-empty handles.
-- If this migration fails on a future deployment it means a duplicate slipped
-- in — resolve by appending a suffix to one of the colliding rows first.
--
-- Idempotent: IF NOT EXISTS guard prevents double-creation on re-apply.

CREATE UNIQUE INDEX IF NOT EXISTS providers_handle_unique_idx
  ON public.providers (lower(handle))
  WHERE handle IS NOT NULL AND handle <> '';
