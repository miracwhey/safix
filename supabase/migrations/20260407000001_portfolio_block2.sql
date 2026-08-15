-- ---------------------------------------------------------------------------
-- Block 2: Portfolio System
--
-- Fixes the broken UNIQUE INDEX on (provider_id, kind) that prevented
-- multiple portfolio items per provider, then extends provider_media with
-- the rich metadata fields required for the portfolio flow.
--
-- Context:
--   provider_media previously had a global UNIQUE INDEX (provider_id, kind).
--   This works for 'avatar' and 'cover' (one per provider), but breaks
--   'portfolio' (which must allow many items per provider).
--
-- Changes:
--   1. Drop the global unique index.
--   2. Recreate it as a PARTIAL index that excludes 'portfolio'.
--   3. Add a non-unique index for portfolio queries (provider + kind + sort).
--   4. Add new columns for Block 2 portfolio metadata.
-- ---------------------------------------------------------------------------

-- Step 1: Drop the broken global unique index
DROP INDEX IF EXISTS idx_provider_media_provider_kind;

-- Step 2: Partial unique index — applies only to non-portfolio kinds
--         (avatar and cover stay unique per provider; portfolio must not)
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_media_provider_kind_singular
  ON public.provider_media (provider_id, kind)
  WHERE kind != 'portfolio';

-- Step 3: Non-unique index for portfolio reads (provider + kind + sort_order)
CREATE INDEX IF NOT EXISTS idx_provider_media_portfolio
  ON public.provider_media (provider_id, kind, sort_order)
  WHERE kind = 'portfolio';

-- Step 4: New columns for portfolio items
--
-- media_type: 'image' | 'video'
-- title: short display title (separate from caption)
-- description: longer public description for portfolio context
-- trade_tags: gewerke explicitly chosen by the owner for this item
-- published: false hides the item from public profile
-- show_price: whether to show amount_snapshot publicly
-- show_duration: whether to show duration_snapshot publicly
-- source_job_id: back-reference to originating job (jobs.id is text, no FK)
-- *_snapshot: immutable captures from job context at creation time
ALTER TABLE public.provider_media
  ADD COLUMN IF NOT EXISTS media_type               text     NOT NULL DEFAULT 'image',
  ADD COLUMN IF NOT EXISTS title                    text,
  ADD COLUMN IF NOT EXISTS description              text,
  ADD COLUMN IF NOT EXISTS trade_tags               text[]   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS published                boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS show_price               boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_duration            boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_job_id            text,
  ADD COLUMN IF NOT EXISTS project_title_snapshot   text,
  ADD COLUMN IF NOT EXISTS location_snapshot        text,
  ADD COLUMN IF NOT EXISTS duration_snapshot        text,
  ADD COLUMN IF NOT EXISTS amount_snapshot          text,
  ADD COLUMN IF NOT EXISTS trade_tags_snapshot      text[]   NOT NULL DEFAULT '{}';

-- Note: RLS policies from 20260317000014_provider_media.sql remain in effect:
--   SELECT: all authenticated users (public portfolio is readable)
--   INSERT/UPDATE/DELETE: only owning provider (via providers.profile_id = auth.uid())
-- No new policies needed.
