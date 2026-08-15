-- =============================================================================
-- Migration: Providers RLS + Projects craftsman_user_id owner column (follow-up)
-- =============================================================================
-- Closes two remaining gaps left by migration 20240400000000:
--
--   Priority 1 – providers table
--     The providers table had no RLS at all.  Discovery/Explore must remain
--     publicly readable (is_public = true rows, no auth required).  The owner
--     must be able to read and write their own row via profile_id = auth.uid().
--
--   Priority 2 – projects table
--     Projects had a soft INSERT policy gated only on auth.role() = 'authenticated'
--     because no direct owner column existed.  This migration adds a
--     craftsman_user_id TEXT column to close the gap for craftsman-linked projects
--     and replaces the old weak policies.
--
-- All CREATE POLICY statements use IF NOT EXISTS guards and all DROP POLICY
-- statements use IF EXISTS, so the migration is safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. PROVIDERS – Row Level Security
-- ---------------------------------------------------------------------------
-- Two separate SELECT policies are needed:
--   a) Public: any user (including anon via the anon key) can read providers
--      with is_public = true.  This keeps Discovery / Explore working without
--      requiring the visitor to be signed in.
--   b) Own: authenticated owner can always read their own row via profile_id,
--      even when is_public = false (e.g. during onboarding before going public).
--
-- A single INSERT + UPDATE policy enforces that writes are only possible when
-- the row's profile_id matches the caller's auth UID.
-- ---------------------------------------------------------------------------

ALTER TABLE public.providers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- a) Public providers are readable by anyone (anon or authenticated).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'providers'
      AND policyname = 'providers_select_public'
  ) THEN
    CREATE POLICY providers_select_public ON public.providers
      FOR SELECT USING (is_public = true);
  END IF;

  -- b) Owner can always read their own row regardless of is_public.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'providers'
      AND policyname = 'providers_select_own'
  ) THEN
    CREATE POLICY providers_select_own ON public.providers
      FOR SELECT USING (profile_id = auth.uid()::text);
  END IF;

  -- c) Authenticated user can only insert a row for themselves.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'providers'
      AND policyname = 'providers_insert_own'
  ) THEN
    CREATE POLICY providers_insert_own ON public.providers
      FOR INSERT WITH CHECK (profile_id = auth.uid()::text);
  END IF;

  -- d) Authenticated user can only update their own row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'providers'
      AND policyname = 'providers_update_own'
  ) THEN
    CREATE POLICY providers_update_own ON public.providers
      FOR UPDATE USING (profile_id = auth.uid()::text);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. PROJECTS – add craftsman_user_id direct ownership column
-- ---------------------------------------------------------------------------
-- The previous migration left the projects INSERT policy as
-- auth.role() = 'authenticated' because the projects table had no direct
-- owner column.  This migration adds craftsman_user_id (TEXT, nullable) to
-- carry the craftsman's auth UID once a project is linked to a job.
--
-- Builder-origin projects (created by customers before any craftsman is
-- assigned, source_job_id = '') will still have NULL craftsman_user_id at
-- creation time.  Their INSERT/SELECT policy remains gated on authentication
-- only as a documented gap until a customer_user_id column is added in a
-- future migration.
-- ---------------------------------------------------------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS craftsman_user_id text;

CREATE INDEX IF NOT EXISTS idx_projects_craftsman_user_id
  ON public.projects (craftsman_user_id)
  WHERE craftsman_user_id IS NOT NULL;

-- Back-fill craftsman_user_id from the linked job for rows that already have
-- a source_job_id.  Safe to re-run: the WHERE clause skips already-populated
-- rows and rows with no job link.
UPDATE public.projects p
SET    craftsman_user_id = j.craftsman_user_id
FROM   public.jobs j
WHERE  p.source_job_id  = j.id
  AND  p.source_job_id <> ''
  AND  p.craftsman_user_id IS NULL
  AND  j.craftsman_user_id IS NOT NULL;

-- Drop the old projects policies created in migration 20240400000000 so we
-- can replace them with craftsman_user_id-aware versions.
DROP POLICY IF EXISTS projects_select_own ON public.projects;
DROP POLICY IF EXISTS projects_insert_own ON public.projects;
DROP POLICY IF EXISTS projects_update_own ON public.projects;

DO $$
BEGIN
  -- SELECT: craftsman can read projects they own directly (craftsman_user_id)
  --         or indirectly via the source_job_id → owned job chain.
  --         Builder-origin projects with NULL craftsman_user_id and empty
  --         source_job_id are not visible to craftsmen by design (they are
  --         customer-owned until a craftsman accepts).
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
      AND policyname = 'projects_select_own'
  ) THEN
    CREATE POLICY projects_select_own ON public.projects
      FOR SELECT USING (
        craftsman_user_id = auth.uid()::text
        OR (
          source_job_id <> ''
          AND source_job_id IN (
            SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text
          )
        )
      );
  END IF;

  -- INSERT: craftsman-linked projects must carry the caller's auth UID.
  --         Builder-origin projects (customer-created, craftsman_user_id IS NULL)
  --         are still gated only on authentication as a documented remaining gap
  --         until a customer_user_id column is added.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
      AND policyname = 'projects_insert_own'
  ) THEN
    CREATE POLICY projects_insert_own ON public.projects
      FOR INSERT WITH CHECK (
        -- Craftsman-linked projects: caller must own the row
        craftsman_user_id = auth.uid()::text
        -- Builder-origin projects have no craftsman yet; require authentication
        -- as a stopgap.
        -- REMAINING GAP: no customer_user_id column yet. Any authenticated user
        -- could technically insert a builder-origin project row. Tracked for the
        -- next migration which will add customer_user_id.
        OR (craftsman_user_id IS NULL AND auth.role() = 'authenticated')
      );
  END IF;

  -- UPDATE: same ownership logic as SELECT.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
      AND policyname = 'projects_update_own'
  ) THEN
    CREATE POLICY projects_update_own ON public.projects
      FOR UPDATE USING (
        craftsman_user_id = auth.uid()::text
        OR (
          source_job_id <> ''
          AND source_job_id IN (
            SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text
          )
        )
      );
  END IF;
END $$;

-- =============================================================================
-- SECONDARY TABLES RISK SUMMARY (not hardened in this migration)
-- =============================================================================
-- The following tables still have no RLS or only structural indexes.
-- Risk classification and reasoning:
--
-- calendar_entries
--   Risk: MEDIUM – contains scheduled job dates per provider/team member.
--   Blocker: no direct user-id column; ownership must be inferred via job_id
--   or provider_id FK.  Safe to add once those FK columns are confirmed.
--
-- schedules
--   Risk: MEDIUM – operational schedule windows per provider.
--   Blocker: similar to calendar_entries; provider_id FK needs verification.
--
-- media_artifacts
--   Risk: MEDIUM – photos/videos attached to jobs.
--   Blocker: ownership inferred via job_id → craftsman_user_id subquery.
--   Can be added without schema changes; deferred to next pass.
--
-- timeline_signals
--   Risk: LOW-MEDIUM – audit/event signals per job.
--   Blocker: ownership via job_id → craftsman_user_id subquery. Low risk
--   because signals are write-only from the app; no sensitive read paths.
--
-- notification_signals
--   Risk: LOW-MEDIUM – internal attention signals per job.
--   Blocker: same as timeline_signals; low read sensitivity.
--
-- job_feedback
--   Risk: LOW – publicly visible trust signals.
--   Blocker: craftsman_user_id column exists on job_feedback; can be scoped
--   to the job's craftsman.  Deferred because public read is the intended
--   behaviour anyway (trust signals on discovery profiles).
--
-- invoices
--   Risk: MEDIUM – financial documents.
--   Blocker: ownership via job_id → craftsman_user_id subquery.
--   Recommended next after media_artifacts.
-- =============================================================================
