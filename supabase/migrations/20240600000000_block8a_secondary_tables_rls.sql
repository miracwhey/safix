-- =============================================================================
-- Migration: BLOCK 8A – Secondary Tables Ownership Hardening (Conditional)
-- =============================================================================
-- Follows up on the gap list documented at the end of migration
-- 20240500000000_providers_projects_rls_followup.sql.
--
-- VALIDATION RESULT
-- -----------------
-- All 7 secondary tables are referenced by live Supabase repositories:
--
--   calendar_entries      → SupabaseCalendarRepository    (src/lib/calendar)
--   schedules             → SupabaseScheduleRepository    (src/lib/operations)
--   media_artifacts       → SupabaseMediaRepository       (src/lib/media)
--   timeline_signals      → SupabaseTimelineRepository    (src/lib/timeline)
--   notification_signals  → SupabaseNotificationRepository (src/lib/notifications)
--   invoices              → SupabaseInvoiceRepository     (src/lib/invoices)
--   job_feedback          → SupabaseFeedbackRepository    (src/lib/feedback)
--
-- None of these tables has a CREATE TABLE statement in the migration history.
-- At validation time they do NOT exist in the public schema.
-- BLOCK 8A is therefore closed WITHOUT active DB hardening for absent tables.
--
-- Each DO block below checks table existence before touching ALTER TABLE or
-- CREATE POLICY.  If a table is absent the block silently does nothing.
-- When a future migration creates one of these tables, re-running this
-- migration (or applying the relevant policies manually) will harden it.
--
-- Ownership model (all job-linked tables):
--   Derived → job_id IN (SELECT id FROM public.jobs
--                         WHERE craftsman_user_id = auth.uid()::text)
--
-- job_feedback additionally has a direct craftsman_user_id column and
-- is intended to be publicly readable (trust signals on discovery profiles).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. calendar_entries
--    Columns: id, job_id, title, customer_name, location, date_label,
--             date_key, starts_at_label, ends_at_label, assigned_member_ids,
--             status, created_at, updated_at
--    Risk: MEDIUM – scheduled job dates per provider/team member.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'calendar_entries'
  ) THEN

    ALTER TABLE public.calendar_entries ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'calendar_entries'
        AND policyname = 'calendar_entries_select_own'
    ) THEN
      CREATE POLICY calendar_entries_select_own ON public.calendar_entries
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'calendar_entries'
        AND policyname = 'calendar_entries_insert_own'
    ) THEN
      CREATE POLICY calendar_entries_insert_own ON public.calendar_entries
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'calendar_entries'
        AND policyname = 'calendar_entries_update_own'
    ) THEN
      CREATE POLICY calendar_entries_update_own ON public.calendar_entries
        FOR UPDATE USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. schedules
--    Columns: id, job_id, scheduled_start, scheduled_end, execution_window,
--             scheduling_status, created_at, updated_at
--    Risk: MEDIUM – operational schedule windows per provider.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'schedules'
  ) THEN

    ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'schedules'
        AND policyname = 'schedules_select_own'
    ) THEN
      CREATE POLICY schedules_select_own ON public.schedules
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'schedules'
        AND policyname = 'schedules_insert_own'
    ) THEN
      CREATE POLICY schedules_insert_own ON public.schedules
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'schedules'
        AND policyname = 'schedules_update_own'
    ) THEN
      CREATE POLICY schedules_update_own ON public.schedules
        FOR UPDATE USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. media_artifacts
--    Columns: id, job_id, kind, label, filename, mime_type, uploaded_at,
--             uploaded_by, notes, dispute_id, timeline_event_id
--    Risk: MEDIUM – photos/videos attached to jobs and disputes.
--
--    Two ownership paths:
--      a) Direct job link: job_id → owned jobs
--      b) Dispute link:    dispute_id → owned disputes (already RLS-protected)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'media_artifacts'
  ) THEN

    ALTER TABLE public.media_artifacts ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'media_artifacts'
        AND policyname = 'media_artifacts_select_own'
    ) THEN
      CREATE POLICY media_artifacts_select_own ON public.media_artifacts
        FOR SELECT USING (
          -- Direct job ownership
          (job_id IS NOT NULL AND job_id IN (
            SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text
          ))
          -- Dispute-linked artifacts: accessible to the dispute participants
          OR (dispute_id IS NOT NULL AND dispute_id IN (
            SELECT id FROM public.disputes
            WHERE raised_by = auth.uid()::text
               OR job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
          ))
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'media_artifacts'
        AND policyname = 'media_artifacts_insert_own'
    ) THEN
      CREATE POLICY media_artifacts_insert_own ON public.media_artifacts
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. timeline_signals
--    Columns: id, job_id, type, occurred_at
--    Risk: LOW-MEDIUM – audit/event signals per job; write-only from the app.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'timeline_signals'
  ) THEN

    ALTER TABLE public.timeline_signals ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'timeline_signals'
        AND policyname = 'timeline_signals_select_own'
    ) THEN
      CREATE POLICY timeline_signals_select_own ON public.timeline_signals
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'timeline_signals'
        AND policyname = 'timeline_signals_insert_own'
    ) THEN
      CREATE POLICY timeline_signals_insert_own ON public.timeline_signals
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. notification_signals
--    Columns: id, job_id, type, priority, read, occurred_at
--    Risk: LOW-MEDIUM – internal attention signals per job.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'notification_signals'
  ) THEN

    ALTER TABLE public.notification_signals ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'notification_signals'
        AND policyname = 'notification_signals_select_own'
    ) THEN
      CREATE POLICY notification_signals_select_own ON public.notification_signals
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'notification_signals'
        AND policyname = 'notification_signals_insert_own'
    ) THEN
      CREATE POLICY notification_signals_insert_own ON public.notification_signals
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    -- markRead() / markAllRead() require UPDATE access.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'notification_signals'
        AND policyname = 'notification_signals_update_own'
    ) THEN
      CREATE POLICY notification_signals_update_own ON public.notification_signals
        FOR UPDATE USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. invoices
--    Columns: id, job_id, invoice_number, status, parties, line_items,
--             amounts, issued_at_label, due_at_label, created_at, updated_at
--    Risk: MEDIUM – financial documents.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'invoices'
  ) THEN

    ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'invoices'
        AND policyname = 'invoices_select_own'
    ) THEN
      CREATE POLICY invoices_select_own ON public.invoices
        FOR SELECT USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'invoices'
        AND policyname = 'invoices_insert_own'
    ) THEN
      CREATE POLICY invoices_insert_own ON public.invoices
        FOR INSERT WITH CHECK (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'invoices'
        AND policyname = 'invoices_update_own'
    ) THEN
      CREATE POLICY invoices_update_own ON public.invoices
        FOR UPDATE USING (
          job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
        );
    END IF;

  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. job_feedback
--    Columns: id, job_id, craftsman_user_id, would_hire_again, note, created_at
--    Risk: LOW – publicly visible trust signals for discovery profiles.
--
--    Two policies:
--      a) Public SELECT: any user (anon or authenticated) can read all
--         feedback rows.  This is intentional – feedback is a trust signal
--         that must be visible on unauthenticated discovery/explore pages.
--      b) Authenticated write stopgap: feedback is written by customers about
--         craftsmen, but no customer_user_id column exists on jobs yet.
--         INSERT/UPDATE are gated on auth.role() = 'authenticated' as a
--         stopgap – identical to the builder-origin project INSERT pattern
--         in migration 20240500000000.  Tighten once customer_user_id lands.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'job_feedback'
  ) THEN

    ALTER TABLE public.job_feedback ENABLE ROW LEVEL SECURITY;

    -- a) Trust signals are publicly readable (anon + authenticated).
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'job_feedback'
        AND policyname = 'job_feedback_select_public'
    ) THEN
      CREATE POLICY job_feedback_select_public ON public.job_feedback
        FOR SELECT USING (true);
    END IF;

    -- b) INSERT: feedback is written by customers about craftsmen, but the
    --    jobs table carries only craftsman_user_id with no customer_user_id.
    --    Until a customer_user_id column is added to jobs (or a separate
    --    customer identity is tracked), write access is gated on authentication
    --    only as a documented stopgap — identical to the builder-origin project
    --    INSERT gap in migration 20240500000000.
    --    REMAINING GAP: any authenticated user can currently insert a feedback
    --    row.  Add a customer_user_id column and tighten this policy once that
    --    column is available.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'job_feedback'
        AND policyname = 'job_feedback_insert_authenticated'
    ) THEN
      CREATE POLICY job_feedback_insert_authenticated ON public.job_feedback
        FOR INSERT WITH CHECK (auth.role() = 'authenticated');
    END IF;

    -- c) Same stopgap for UPDATE (upsert path in SupabaseFeedbackRepository).
    --    REMAINING GAP: tighten once customer_user_id is available.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'job_feedback'
        AND policyname = 'job_feedback_update_authenticated'
    ) THEN
      CREATE POLICY job_feedback_update_authenticated ON public.job_feedback
        FOR UPDATE USING (auth.role() = 'authenticated');
    END IF;

  END IF;
END $$;

-- =============================================================================
-- BLOCK 8A CLOSURE SUMMARY
-- =============================================================================
-- Validation performed against migration history and repository code.
--
-- FINDING: All 7 secondary tables (calendar_entries, schedules,
-- media_artifacts, timeline_signals, notification_signals, invoices,
-- job_feedback) are absent from the public schema at migration time.
-- No CREATE TABLE statement exists for any of them in the migration chain.
--
-- ACTION TAKEN: Conditional RLS + ownership policies are defined above.
-- Each block is guarded by an information_schema.tables existence check.
-- At current DB state every block is a safe no-op.
--
-- ACTIVE DB HARDENING: none (tables absent → not applicable).
--
-- REMAINING GAPS (to be addressed when tables are created):
--   • All 7 tables need CREATE TABLE migrations before the RLS blocks
--     above become effective.
--   • media_artifacts.dispute_id path assumes public.disputes is
--     RLS-protected (confirmed: migration 20240400000000).
--   • job_feedback INSERT/UPDATE uses auth.role() = 'authenticated' as a
--     stopgap because feedback is customer-written but the jobs table has no
--     customer_user_id column.  A customer_user_id column would allow
--     tighter customer-side scoping.
--   • projects builder-origin INSERT gap (craftsman_user_id IS NULL) is
--     tracked in migration 20240500000000 and is out of scope here.
-- =============================================================================
