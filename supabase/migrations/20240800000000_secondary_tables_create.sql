-- =============================================================================
-- Migration: BLOCK 15 – Secondary Tables Real Persistence
-- =============================================================================
-- Creates the 7 secondary tables that are referenced by live Supabase
-- repositories but had no CREATE TABLE statement in the migration history.
--
-- Tables created:
--   calendar_entries      → SupabaseCalendarRepository    (src/lib/calendar)
--   schedules             → SupabaseScheduleRepository    (src/lib/operations)
--   media_artifacts       → SupabaseMediaRepository       (src/lib/media)
--   timeline_signals      → SupabaseTimelineRepository    (src/lib/timeline)
--   notification_signals  → SupabaseNotificationRepository (src/lib/notifications)
--   invoices              → SupabaseInvoiceRepository     (src/lib/invoices)
--   job_feedback          → SupabaseFeedbackRepository    (src/lib/feedback)
--
-- All created_at / updated_at columns store Unix epoch milliseconds (bigint)
-- to match the existing Row interface conventions in the Supabase repositories.
--
-- RLS policies were defined conditionally in migration 20240600000000.
-- Creating the tables here causes those DO blocks to activate automatically
-- on next application.  Additional direct policies are added below to ensure
-- the tables are protected even on a fresh database that skips 20240600000000.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. calendar_entries
--    Owner: craftsman (via job_id → jobs.craftsman_user_id)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.calendar_entries (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  title               text        NOT NULL DEFAULT '',
  customer_name       text        NOT NULL DEFAULT '',
  location            text        NOT NULL DEFAULT '',
  date_label          text        NOT NULL DEFAULT '',
  date_key            text        NOT NULL DEFAULT '',
  starts_at_label     text        NOT NULL DEFAULT '',
  ends_at_label       text        NOT NULL DEFAULT '',
  assigned_member_ids text[]      NOT NULL DEFAULT '{}',
  status              text        NOT NULL DEFAULT 'scheduled',
  created_at          bigint      NOT NULL DEFAULT 0,
  updated_at          bigint      NOT NULL DEFAULT 0
);

ALTER TABLE public.calendar_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_entries_select_own ON public.calendar_entries;
CREATE POLICY calendar_entries_select_own ON public.calendar_entries
  FOR SELECT USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS calendar_entries_insert_own ON public.calendar_entries;
CREATE POLICY calendar_entries_insert_own ON public.calendar_entries
  FOR INSERT WITH CHECK (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS calendar_entries_update_own ON public.calendar_entries;
CREATE POLICY calendar_entries_update_own ON public.calendar_entries
  FOR UPDATE USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

-- ---------------------------------------------------------------------------
-- 2. schedules
--    Owner: craftsman (via job_id → jobs.craftsman_user_id)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.schedules (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  scheduled_start     bigint      NOT NULL DEFAULT 0,
  scheduled_end       bigint      NOT NULL DEFAULT 0,
  execution_window    bigint      NOT NULL DEFAULT 0,
  scheduling_status   text        NOT NULL DEFAULT 'pending',
  created_at          bigint      NOT NULL DEFAULT 0,
  updated_at          bigint      NOT NULL DEFAULT 0
);

ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS schedules_select_own ON public.schedules;
CREATE POLICY schedules_select_own ON public.schedules
  FOR SELECT USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS schedules_insert_own ON public.schedules;
CREATE POLICY schedules_insert_own ON public.schedules
  FOR INSERT WITH CHECK (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS schedules_update_own ON public.schedules;
CREATE POLICY schedules_update_own ON public.schedules
  FOR UPDATE USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

-- ---------------------------------------------------------------------------
-- 3. media_artifacts
--    Owner: craftsman (via job_id → jobs.craftsman_user_id)
--    dispute_id and timeline_event_id are optional supplementary links.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.media_artifacts (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  kind                text        NOT NULL DEFAULT '',
  label               text        NOT NULL DEFAULT '',
  filename            text        NOT NULL DEFAULT '',
  mime_type           text        NOT NULL DEFAULT '',
  uploaded_at         bigint      NOT NULL DEFAULT 0,
  uploaded_by         text        NOT NULL DEFAULT '',
  notes               text,
  dispute_id          text,
  timeline_event_id   text
);

ALTER TABLE public.media_artifacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_artifacts_select_own ON public.media_artifacts;
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

DROP POLICY IF EXISTS media_artifacts_insert_own ON public.media_artifacts;
CREATE POLICY media_artifacts_insert_own ON public.media_artifacts
  FOR INSERT WITH CHECK (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

-- ---------------------------------------------------------------------------
-- 4. timeline_signals
--    Owner: craftsman (via job_id → jobs.craftsman_user_id)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.timeline_signals (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  type                text        NOT NULL DEFAULT '',
  occurred_at         bigint      NOT NULL DEFAULT 0
);

ALTER TABLE public.timeline_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timeline_signals_select_own ON public.timeline_signals;
CREATE POLICY timeline_signals_select_own ON public.timeline_signals
  FOR SELECT USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS timeline_signals_insert_own ON public.timeline_signals;
CREATE POLICY timeline_signals_insert_own ON public.timeline_signals
  FOR INSERT WITH CHECK (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

-- ---------------------------------------------------------------------------
-- 5. notification_signals
--    Owner: craftsman (via job_id → jobs.craftsman_user_id)
--    UPDATE required for markRead() / markAllRead() operations.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notification_signals (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  type                text        NOT NULL DEFAULT '',
  priority            text        NOT NULL DEFAULT 'low',
  read                boolean     NOT NULL DEFAULT false,
  occurred_at         bigint      NOT NULL DEFAULT 0
);

ALTER TABLE public.notification_signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_signals_select_own ON public.notification_signals;
CREATE POLICY notification_signals_select_own ON public.notification_signals
  FOR SELECT USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS notification_signals_insert_own ON public.notification_signals;
CREATE POLICY notification_signals_insert_own ON public.notification_signals
  FOR INSERT WITH CHECK (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS notification_signals_update_own ON public.notification_signals;
CREATE POLICY notification_signals_update_own ON public.notification_signals
  FOR UPDATE USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

-- ---------------------------------------------------------------------------
-- 6. invoices
--    Owner: craftsman (via job_id → jobs.craftsman_user_id)
--    parties / line_items / amounts are stored as JSONB blobs matching the
--    InvoiceParties, InvoiceLineItem[], and InvoiceAmounts domain types.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.invoices (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  invoice_number      text        NOT NULL DEFAULT '',
  status              text        NOT NULL DEFAULT 'draft',
  parties             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  line_items          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  amounts             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  issued_at_label     text        NOT NULL DEFAULT '',
  due_at_label        text        NOT NULL DEFAULT '',
  created_at          bigint      NOT NULL DEFAULT 0,
  updated_at          bigint      NOT NULL DEFAULT 0
);

ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS invoices_select_own ON public.invoices;
CREATE POLICY invoices_select_own ON public.invoices
  FOR SELECT USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS invoices_insert_own ON public.invoices;
CREATE POLICY invoices_insert_own ON public.invoices
  FOR INSERT WITH CHECK (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

DROP POLICY IF EXISTS invoices_update_own ON public.invoices;
CREATE POLICY invoices_update_own ON public.invoices
  FOR UPDATE USING (
    job_id IN (SELECT id FROM public.jobs WHERE craftsman_user_id = auth.uid()::text)
  );

-- ---------------------------------------------------------------------------
-- 7. job_feedback
--    Owner: customer-written trust signal (publicly readable).
--    job_id is UNIQUE because the Supabase repository uses an upsert with
--    onConflict: 'job_id' — one feedback record per job.
--
--    REMAINING GAP: INSERT/UPDATE are gated on auth.role() = 'authenticated'
--    because the jobs table carries no customer_user_id column.  Tighten
--    once a customer_user_id column is added to jobs.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.job_feedback (
  id                  text        PRIMARY KEY,
  job_id              text        NOT NULL UNIQUE REFERENCES public.jobs(id) ON DELETE CASCADE,
  craftsman_user_id   text        NOT NULL DEFAULT '',
  would_hire_again    boolean     NOT NULL DEFAULT false,
  note                text,
  created_at          bigint      NOT NULL DEFAULT 0
);

ALTER TABLE public.job_feedback ENABLE ROW LEVEL SECURITY;

-- Trust signals are publicly readable (anon + authenticated).
DROP POLICY IF EXISTS job_feedback_select_public ON public.job_feedback;
CREATE POLICY job_feedback_select_public ON public.job_feedback
  FOR SELECT USING (true);

-- INSERT: stopgap – any authenticated user can insert feedback.
-- REMAINING GAP: tighten once customer_user_id is available on jobs.
DROP POLICY IF EXISTS job_feedback_insert_authenticated ON public.job_feedback;
CREATE POLICY job_feedback_insert_authenticated ON public.job_feedback
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- UPDATE (upsert path): same stopgap as INSERT.
-- REMAINING GAP: tighten once customer_user_id is available on jobs.
DROP POLICY IF EXISTS job_feedback_update_authenticated ON public.job_feedback;
CREATE POLICY job_feedback_update_authenticated ON public.job_feedback
  FOR UPDATE USING (auth.role() = 'authenticated');

-- =============================================================================
-- BLOCK 15 COMPLETION SUMMARY
-- =============================================================================
-- All 7 secondary tables now have real CREATE TABLE statements.
-- The conditional RLS blocks in migration 20240600000000 become effective
-- on any database that has not yet applied 20240600000000, but the direct
-- policies above ensure protection on a fresh schema too.
--
-- REMAINING GAPS:
--   • job_feedback INSERT/UPDATE uses auth.role() = 'authenticated' as a
--     stopgap because feedback is customer-written but the jobs table has no
--     customer_user_id column.  Tighten once that column is added.
--   • media_artifacts.dispute_id is an unvalidated text reference (no FK)
--     because dispute_id is optional and disputes may outlive media rows.
-- =============================================================================
