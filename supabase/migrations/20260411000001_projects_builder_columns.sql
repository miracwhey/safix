-- ---------------------------------------------------------------------------
-- Add builder-origin columns to the projects table.
--
-- These columns were defined in the initial schema migration but were never
-- applied to the live database.  Without them:
--   - INSERT payloads with source / category / description are silently
--     dropped by PostgREST (unknown columns are ignored, not rejected).
--   - SELECT returns NULL for all four fields.
--   - rowToProject conditional spreads skip them (undefined != null → false).
--   - SearchScreen filter `p.category?.trim()` returns falsy → builder
--     projects never appear in the "Aus Projekt" search picker.
-- ---------------------------------------------------------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS source            text,
  ADD COLUMN IF NOT EXISTS category          text,
  ADD COLUMN IF NOT EXISTS description       text,
  ADD COLUMN IF NOT EXISTS requested_budget  text,
  ADD COLUMN IF NOT EXISTS requested_timing  text;

COMMENT ON COLUMN public.projects.source           IS '''builder'' | ''inquiry'' | ''direct''';
COMMENT ON COLUMN public.projects.category         IS 'Trade category, e.g. ''Elektrik'', ''Bad''';
COMMENT ON COLUMN public.projects.description      IS 'Free-text description of the required work';
COMMENT ON COLUMN public.projects.requested_budget IS 'Customer budget expectation, e.g. ''unter 2.000 €''';
COMMENT ON COLUMN public.projects.requested_timing IS 'Customer timing preference, e.g. ''Innerhalb 4 Wochen''';
