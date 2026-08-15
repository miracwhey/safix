-- =============================================================================
-- Migration: RLS Ownership Hardening
-- =============================================================================
-- Enables Row Level Security on core tables and replaces the existing
-- auth.role()-only policies on disputes with real ownership-based policies.
--
-- Ownership model:
--   jobs           → craftsman_user_id = auth.uid()
--   payments       → job_id IN (owned jobs)
--   ledger_entries → job_id IN (owned jobs)
--   conversations  → craftsman_user_id = auth.uid()
--   messages       → conversation_id IN (owned conversations)
--   disputes       → raised_by = auth.uid() OR job_id IN (owned jobs)
--   dispute_status_history → job_id IN (owned jobs)
--   team_members   → user_id = auth.uid() OR provider_id IN (owned providers)
--   projects       → source_job_id IN (owned jobs)
--                    (builder-origin projects without a source_job_id currently
--                     have no direct owner column; they are inaccessible via
--                     SELECT until a craftsman_user_id column is added.
--                     INSERT remains open to authenticated users as a stopgap.)
--
-- All policies use DO blocks with IF NOT EXISTS guards so the migration is
-- safe to re-run.  Existing weak policies on disputes are dropped first.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: owned jobs subquery (reused across several policies)
-- Checks craftsman_user_id against the calling user's auth UID.
-- auth.uid() returns uuid; craftsman_user_id is text → explicit cast.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. JOBS
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='jobs' AND policyname='jobs_select_own') THEN
    CREATE POLICY jobs_select_own ON public.jobs
      FOR SELECT USING (craftsman_user_id = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='jobs' AND policyname='jobs_insert_own') THEN
    CREATE POLICY jobs_insert_own ON public.jobs
      FOR INSERT WITH CHECK (craftsman_user_id = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='jobs' AND policyname='jobs_update_own') THEN
    CREATE POLICY jobs_update_own ON public.jobs
      FOR UPDATE USING (craftsman_user_id = auth.uid()::text);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. PAYMENTS
-- ---------------------------------------------------------------------------

-- Guard: only act if the table exists. On a fresh DB the table is created by
-- migration 20240103000000_payments_ledger_tables.sql which, due to standard
-- lexicographic migration ordering (20240103 < 20240400), runs before this
-- migration.  The existence check also makes this block safe if migrations
-- are ever applied selectively or out of order.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payments'
  ) THEN
    ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payments' AND policyname='payments_select_own') THEN
      CREATE POLICY payments_select_own ON public.payments
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payments' AND policyname='payments_insert_own') THEN
      CREATE POLICY payments_insert_own ON public.payments
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payments' AND policyname='payments_update_own') THEN
      CREATE POLICY payments_update_own ON public.payments
        FOR UPDATE USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. LEDGER ENTRIES
-- ---------------------------------------------------------------------------

-- Guard: only act if the table exists (same rationale as payments above).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ledger_entries'
  ) THEN
    ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ledger_entries' AND policyname='ledger_select_own') THEN
      CREATE POLICY ledger_select_own ON public.ledger_entries
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ledger_entries' AND policyname='ledger_insert_own') THEN
      CREATE POLICY ledger_insert_own ON public.ledger_entries
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. DISPUTES – drop weak policies, create ownership-based replacements
-- ---------------------------------------------------------------------------

-- Drop the existing auth.role()-only policies from the previous migration.
DROP POLICY IF EXISTS disputes_select_own ON public.disputes;
DROP POLICY IF EXISTS disputes_insert_own ON public.disputes;
DROP POLICY IF EXISTS disputes_update_own ON public.disputes;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='disputes' AND policyname='disputes_select_own') THEN
    CREATE POLICY disputes_select_own ON public.disputes
      FOR SELECT USING (
        raised_by = auth.uid()::text
        OR job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='disputes' AND policyname='disputes_insert_own') THEN
    -- AND is intentional: the inserting user must both set themselves as the
    -- raiser (raised_by = auth.uid()) AND own the job.  Using OR here would
    -- allow inserting disputes with a spoofed raised_by on your own job, or
    -- with your raised_by on someone else's job.
    CREATE POLICY disputes_insert_own ON public.disputes
      FOR INSERT WITH CHECK (
        raised_by = auth.uid()::text
        AND job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='disputes' AND policyname='disputes_update_own') THEN
    CREATE POLICY disputes_update_own ON public.disputes
      FOR UPDATE USING (
        raised_by = auth.uid()::text
        OR job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. DISPUTE STATUS HISTORY – drop weak policies, create ownership-based ones
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS dispute_history_select ON public.dispute_status_history;
DROP POLICY IF EXISTS dispute_history_insert ON public.dispute_status_history;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dispute_status_history' AND policyname='dispute_history_select') THEN
    CREATE POLICY dispute_history_select ON public.dispute_status_history
      FOR SELECT USING (
        job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dispute_status_history' AND policyname='dispute_history_insert') THEN
    CREATE POLICY dispute_history_insert ON public.dispute_status_history
      FOR INSERT WITH CHECK (
        job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. CONVERSATIONS
-- ---------------------------------------------------------------------------

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_select_own') THEN
    CREATE POLICY conversations_select_own ON public.conversations
      FOR SELECT USING (craftsman_user_id = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_insert_own') THEN
    CREATE POLICY conversations_insert_own ON public.conversations
      FOR INSERT WITH CHECK (craftsman_user_id = auth.uid()::text);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='conversations' AND policyname='conversations_update_own') THEN
    CREATE POLICY conversations_update_own ON public.conversations
      FOR UPDATE USING (craftsman_user_id = auth.uid()::text);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. MESSAGES
-- ---------------------------------------------------------------------------

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='messages_select_own') THEN
    CREATE POLICY messages_select_own ON public.messages
      FOR SELECT USING (
        conversation_id IN (
          SELECT id FROM public.conversations WHERE craftsman_user_id = auth.uid()::text
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='messages' AND policyname='messages_insert_own') THEN
    CREATE POLICY messages_insert_own ON public.messages
      FOR INSERT WITH CHECK (
        conversation_id IN (
          SELECT id FROM public.conversations WHERE craftsman_user_id = auth.uid()::text
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. TEAM MEMBERS
-- ---------------------------------------------------------------------------

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='team_members' AND policyname='team_members_select_own') THEN
    CREATE POLICY team_members_select_own ON public.team_members
      FOR SELECT USING (
        user_id = auth.uid()::text
        OR provider_id IN (
          SELECT id FROM public.providers WHERE profile_id = auth.uid()::text
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='team_members' AND policyname='team_members_insert_own') THEN
    CREATE POLICY team_members_insert_own ON public.team_members
      FOR INSERT WITH CHECK (
        provider_id IN (
          SELECT id FROM public.providers WHERE profile_id = auth.uid()::text
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='team_members' AND policyname='team_members_update_own') THEN
    CREATE POLICY team_members_update_own ON public.team_members
      FOR UPDATE USING (
        user_id = auth.uid()::text
        OR provider_id IN (
          SELECT id FROM public.providers WHERE profile_id = auth.uid()::text
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 9. PROJECTS – ownership via source_job_id → owned jobs
-- ---------------------------------------------------------------------------

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='projects' AND policyname='projects_select_own') THEN
    CREATE POLICY projects_select_own ON public.projects
      FOR SELECT USING (
        -- Projects linked to an owned job
        (source_job_id <> '' AND source_job_id IN (
          SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text
        ))
        -- Builder-origin projects not yet linked to a job are a remaining gap:
        -- they currently have no direct owner column. New builder projects
        -- should set craftsman_user_id once that column is added.
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='projects' AND policyname='projects_insert_own') THEN
    -- NOTE: Projects do not yet have a direct owner column for builder-origin
    -- rows (source_job_id is empty on creation).  Until a craftsman_user_id
    -- column is added to the projects table, INSERT is gated only on
    -- authentication.  This is a known gap tracked for the next migration.
    CREATE POLICY projects_insert_own ON public.projects
      FOR INSERT WITH CHECK (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='projects' AND policyname='projects_update_own') THEN
    CREATE POLICY projects_update_own ON public.projects
      FOR UPDATE USING (
        source_job_id <> '' AND source_job_id IN (
          SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text
        )
      );
  END IF;
END $$;
