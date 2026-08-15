-- =============================================================================
-- Migration: Calendar Entries — Company Scope & Worker Assignment Visibility
-- =============================================================================
-- Purpose:
--   CalendarEntry is the internal operational assignment shell.  Until now it
--   had no direct provider_id column — company scope was transitive via
--   job_id → jobs.craftsman_user_id, and workers could not read any
--   calendar_entries rows at all (no worker-facing SELECT policy existed).
--
-- This migration establishes durable company scope on calendar_entries and
-- opens the two required visibility paths:
--
--   Owner  → sees ALL entries that belong to their company/provider
--   Worker → sees ONLY entries that belong to their company AND are assigned to them
--
-- Column types (actual production schema):
--   calendar_entries.id            uuid
--   calendar_entries.job_id        uuid
--   calendar_entries.assigned_member_ids  text[]
--   jobs.id                        uuid
--   jobs.provider_id               uuid
--   providers.id                   uuid
--   providers.profile_id           uuid
--   team_members.id                uuid
--   team_members.profile_id        uuid
--   team_members.provider_id       uuid
--
-- Transition approach:
--   - provider_id is nullable to avoid breaking rows that predate this migration.
--   - Existing rows are backfilled via job_id → jobs.provider_id.
--   - Old policies (owner via craftsman_user_id) are replaced; a NULL-fallback
--     clause preserves visibility for the small residue of un-backfilled rows.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add provider_id column as uuid (consistent with all other provider_id
--    columns in the schema).  Drop text version if it was added previously.
-- ---------------------------------------------------------------------------

ALTER TABLE public.calendar_entries
  DROP COLUMN IF EXISTS provider_id;

ALTER TABLE public.calendar_entries
  ADD COLUMN IF NOT EXISTS provider_id uuid;

-- ---------------------------------------------------------------------------
-- 2. Backfill from job linkage
-- ---------------------------------------------------------------------------

UPDATE public.calendar_entries ce
SET    provider_id = j.provider_id
FROM   public.jobs j
WHERE  ce.job_id      = j.id
  AND  j.provider_id  IS NOT NULL
  AND  ce.provider_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Drop old owner-only policies (craftsman_user_id based)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS calendar_entries_select_own ON public.calendar_entries;
DROP POLICY IF EXISTS calendar_entries_insert_own ON public.calendar_entries;
DROP POLICY IF EXISTS calendar_entries_update_own ON public.calendar_entries;

-- ---------------------------------------------------------------------------
-- 4. Owner SELECT — direct provider scope + fallback for legacy NULL rows
-- ---------------------------------------------------------------------------
--    providers.id        uuid
--    providers.profile_id uuid
--    auth.uid()          uuid  → no cast needed
--    jobs.craftsman_user_id text → auth.uid()::text needed for fallback
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'calendar_entries'
      AND policyname = 'calendar_entries_owner_select'
  ) THEN
    CREATE POLICY calendar_entries_owner_select ON public.calendar_entries
      FOR SELECT USING (
        (
          provider_id IS NOT NULL
          AND provider_id IN (
            SELECT id FROM public.providers
            WHERE profile_id = auth.uid()
          )
        )
        OR (
          provider_id IS NULL
          AND job_id IN (
            SELECT id FROM public.jobs
            WHERE craftsman_user_id = auth.uid()::text
          )
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Worker SELECT — assignment-scoped within their company
-- ---------------------------------------------------------------------------
--    team_members.profile_id uuid → auth.uid() (uuid) direct compare ✓
--    team_members.provider_id uuid → calendar_entries.provider_id uuid ✓
--    team_members.id uuid → assigned_member_ids text[] → need ::text cast
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'calendar_entries'
      AND policyname = 'calendar_entries_worker_select'
  ) THEN
    CREATE POLICY calendar_entries_worker_select ON public.calendar_entries
      FOR SELECT USING (
        EXISTS (
          SELECT 1
          FROM   public.team_members tm
          WHERE  tm.profile_id  = auth.uid()
            AND  tm.provider_id = calendar_entries.provider_id
            AND  calendar_entries.assigned_member_ids @> ARRAY[tm.id::text]
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Owner INSERT
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'calendar_entries'
      AND policyname = 'calendar_entries_owner_insert'
  ) THEN
    CREATE POLICY calendar_entries_owner_insert ON public.calendar_entries
      FOR INSERT WITH CHECK (
        (
          provider_id IS NOT NULL
          AND provider_id IN (
            SELECT id FROM public.providers
            WHERE profile_id = auth.uid()
          )
        )
        OR (
          provider_id IS NULL
          AND job_id IN (
            SELECT id FROM public.jobs
            WHERE craftsman_user_id = auth.uid()::text
          )
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Owner UPDATE
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'calendar_entries'
      AND policyname = 'calendar_entries_owner_update'
  ) THEN
    CREATE POLICY calendar_entries_owner_update ON public.calendar_entries
      FOR UPDATE USING (
        (
          provider_id IS NOT NULL
          AND provider_id IN (
            SELECT id FROM public.providers
            WHERE profile_id = auth.uid()
          )
        )
        OR (
          provider_id IS NULL
          AND job_id IN (
            SELECT id FROM public.jobs
            WHERE craftsman_user_id = auth.uid()::text
          )
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Worker UPDATE — status changes on assigned entries
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'calendar_entries'
      AND policyname = 'calendar_entries_worker_update'
  ) THEN
    CREATE POLICY calendar_entries_worker_update ON public.calendar_entries
      FOR UPDATE USING (
        EXISTS (
          SELECT 1
          FROM   public.team_members tm
          WHERE  tm.profile_id  = auth.uid()
            AND  tm.provider_id = calendar_entries.provider_id
            AND  calendar_entries.assigned_member_ids @> ARRAY[tm.id::text]
        )
      );
  END IF;
END $$;
