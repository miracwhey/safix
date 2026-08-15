-- =============================================================================
-- Migration: Projects – customer_user_id ownership column
-- =============================================================================
-- Closes the documented remaining gap in migration 20240500000000:
--   "REMAINING GAP: no customer_user_id column yet. Any authenticated user
--    could technically insert a builder-origin project row. Tracked for the
--    next migration which will add customer_user_id."
--
-- This migration adds a customer_user_id TEXT column to the projects table
-- so that builder-origin projects (source_job_id = '', created by a customer
-- before any craftsman is assigned) carry the creating customer's auth UID.
--
-- Ownership model after this migration:
--   customer-origin projects  → customer_user_id = auth.uid()
--   craftsman-linked projects → craftsman_user_id = auth.uid()
--                               OR source_job_id IN (owned jobs)
--   fully linked projects     → both columns are set; either path grants access
--
-- All CREATE POLICY statements use IF NOT EXISTS guards and all DROP POLICY
-- statements use IF EXISTS, so the migration is safe to re-run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add customer_user_id column
-- ---------------------------------------------------------------------------

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS customer_user_id text;

CREATE INDEX IF NOT EXISTS idx_projects_customer_user_id
  ON public.projects (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Replace projects RLS policies
--    Drop the weak policies from migrations 20240400000000 and 20240500000000,
--    then install customer_user_id-aware replacements.
-- ---------------------------------------------------------------------------

-- Drop old policies (from migration 20240400000000 / 20240500000000).
-- Using IF EXISTS so re-runs and fresh installs are both safe.
DROP POLICY IF EXISTS projects_select_own  ON public.projects;
DROP POLICY IF EXISTS projects_insert_own  ON public.projects;
DROP POLICY IF EXISTS projects_update_own  ON public.projects;

DO $$
BEGIN

  -- SELECT ----------------------------------------------------------------
  -- A user may read a project if they are:
  --   a) The customer who created it (customer_user_id match), OR
  --   b) The assigned craftsman (craftsman_user_id match), OR
  --   c) The craftsman who owns the backing job (source_job_id chain).
  --
  -- Case (c) is a belt-and-braces fallback for rows that existed before the
  -- craftsman_user_id back-fill in migration 20240500000000 and for the brief
  -- window between job creation and the project update that stamps
  -- craftsman_user_id.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
      AND policyname = 'projects_select_own'
  ) THEN
    CREATE POLICY projects_select_own ON public.projects
      FOR SELECT USING (
        customer_user_id = auth.uid()::text
        OR craftsman_user_id = auth.uid()::text
        OR (
          source_job_id <> ''
          AND source_job_id IN (
            SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text
          )
        )
      );
  END IF;

  -- INSERT ----------------------------------------------------------------
  -- Customer-origin projects: caller must supply their own auth UID as
  --   customer_user_id.
  -- Craftsman-linked projects: caller must supply their own auth UID as
  --   craftsman_user_id.
  -- Both fields present: caller must own at least one.
  --
  -- This replaces the previous `auth.role() = 'authenticated'` stopgap for
  -- builder-origin rows.  Going forward every new project row must carry a
  -- direct owner column.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
      AND policyname = 'projects_insert_own'
  ) THEN
    CREATE POLICY projects_insert_own ON public.projects
      FOR INSERT WITH CHECK (
        customer_user_id = auth.uid()::text
        OR craftsman_user_id = auth.uid()::text
      );
  END IF;

  -- UPDATE ----------------------------------------------------------------
  -- Same three-way ownership check as SELECT so that updates to either owner
  -- field are blocked for non-owners.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'projects'
      AND policyname = 'projects_update_own'
  ) THEN
    CREATE POLICY projects_update_own ON public.projects
      FOR UPDATE USING (
        customer_user_id = auth.uid()::text
        OR craftsman_user_id = auth.uid()::text
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
-- CLOSURE SUMMARY
-- =============================================================================
-- After this migration the projects ownership model is complete:
--
--   customer_user_id  – set at project creation time by the customer's session.
--                       Covers builder-origin projects (source_job_id = '').
--   craftsman_user_id – set when a project is linked to a job via
--                       convertInquiryToProjectWorkflow (or back-filled from
--                       the source job in migration 20240500000000).
--   source_job_id     – belt-and-braces fallback for the narrow window between
--                       job creation and the craftsman_user_id stamp, and for
--                       legacy rows that predate this column.
--
-- REMAINING GAPS (outside scope of this migration):
--   • job_feedback INSERT/UPDATE still uses auth.role() = 'authenticated'
--     because feedback is customer-written but the jobs table has no
--     customer_user_id.  The same column could be added to jobs in a future
--     migration to close that gap.
-- =============================================================================
