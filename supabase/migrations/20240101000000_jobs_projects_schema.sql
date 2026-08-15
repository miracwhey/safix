-- =============================================================================
-- Migration: Jobs & Projects – full application schema
-- =============================================================================
-- The public.jobs table was seeded with a minimal set of relational columns:
--   id, customer_profile_id, provider_id, title, description, city, status,
--   budget_amount, scheduled_for, created_at, updated_at
--
-- This migration adds all application-specific columns required by
-- SupabaseJobRepository and creates the public.projects table required by
-- SupabaseProjectRepository.
--
-- All ADD COLUMN statements use IF NOT EXISTS so the migration is safe to run
-- multiple times (idempotent).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. JOBS TABLE – add application-specific columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs
  -- Link to a matching project record (empty string when no project exists yet)
  ADD COLUMN IF NOT EXISTS project_id           text        NOT NULL DEFAULT '',

  -- Denormalised customer display name (populated at job-creation time so the
  -- craftsman can read it without a JOIN in every query)
  ADD COLUMN IF NOT EXISTS customer             text        NOT NULL DEFAULT '',

  -- Human-readable location label, e.g. "Hannover-Linden".
  -- Back-filled from the existing `city` column where available.
  ADD COLUMN IF NOT EXISTS location             text        NOT NULL DEFAULT '',

  -- Formatted date/time label shown in the UI, e.g. "Heute, 14:00 Uhr"
  ADD COLUMN IF NOT EXISTS date_label           text        NOT NULL DEFAULT 'Termin offen',

  -- Formatted amount string agreed between customer and craftsman, e.g. "2.300 €"
  ADD COLUMN IF NOT EXISTS amount               text        NOT NULL DEFAULT '',

  -- Payment lifecycle state. Mirrors the PaymentState union in coreTypes.
  -- Allowed values: deposit_required | deposit_paid | in_escrow |
  --                 work_in_progress | release_pending | released |
  --                 disputed | refunded
  ADD COLUMN IF NOT EXISTS payment_state        text        NOT NULL DEFAULT 'deposit_required',

  -- Human-readable documentation summary, e.g. "2 Fotos vorhanden"
  ADD COLUMN IF NOT EXISTS documentation_status text        NOT NULL DEFAULT 'Noch keine Dokumentation',

  -- JSONB array of team-member ID strings, e.g. ["tm-1","tm-2"]
  ADD COLUMN IF NOT EXISTS assigned_member_ids  jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- JSONB array of plain-text note strings
  ADD COLUMN IF NOT EXISTS notes                jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Count of photos attached to this job
  ADD COLUMN IF NOT EXISTS photo_count          integer     NOT NULL DEFAULT 0,

  -- JSONB object capturing the intake origin and customer-provided context.
  -- Nullable – only present on jobs created from an inquiry flow.
  ADD COLUMN IF NOT EXISTS intake_context       jsonb,

  -- Optional timing note written by the craftsman during proposal preparation
  ADD COLUMN IF NOT EXISTS proposal_timing_note text,

  -- Unix timestamps (ms) for key lifecycle milestones
  ADD COLUMN IF NOT EXISTS proposal_sent_at     bigint,
  ADD COLUMN IF NOT EXISTS proposal_accepted_at bigint,
  ADD COLUMN IF NOT EXISTS work_completed_at    bigint,
  ADD COLUMN IF NOT EXISTS payment_released_at  bigint,

  -- Supabase auth.users UUID of the craftsman who owns this job.
  -- Derived from provider_id at creation; used for trust-layer counters.
  ADD COLUMN IF NOT EXISTS craftsman_user_id    text;

-- ---------------------------------------------------------------------------
-- 2. JOBS – backfill new columns from existing relational columns
--    Use a DO block so we can check whether source columns exist first.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Back-fill location from city where the new column is still empty
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'jobs'
      AND column_name  = 'city'
  ) THEN
    UPDATE public.jobs
    SET location = city
    WHERE (location = '' OR location IS NULL)
      AND city IS NOT NULL
      AND city <> '';
  END IF;

  -- Back-fill amount from budget_amount where the new column is still empty
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'jobs'
      AND column_name  = 'budget_amount'
  ) THEN
    UPDATE public.jobs
    SET amount = budget_amount::text || ' €'
    WHERE (amount = '' OR amount IS NULL)
      AND budget_amount IS NOT NULL;
  END IF;

  -- Back-fill craftsman_user_id from provider_id (cast UUID → text)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'jobs'
      AND column_name  = 'provider_id'
  ) THEN
    UPDATE public.jobs
    SET craftsman_user_id = provider_id::text
    WHERE craftsman_user_id IS NULL
      AND provider_id IS NOT NULL;
  END IF;

  -- Back-fill date_label from scheduled_for timestamp
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'jobs'
      AND column_name  = 'scheduled_for'
  ) THEN
    UPDATE public.jobs
    SET date_label = to_char(scheduled_for AT TIME ZONE 'Europe/Berlin', 'DD.MM.YYYY, HH24:MI Uhr')
    WHERE date_label = 'Termin offen'
      AND scheduled_for IS NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. JOBS – indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_jobs_status
  ON public.jobs (status);

CREATE INDEX IF NOT EXISTS idx_jobs_craftsman_user_id
  ON public.jobs (craftsman_user_id);

CREATE INDEX IF NOT EXISTS idx_jobs_project_id
  ON public.jobs (project_id);

-- ---------------------------------------------------------------------------
-- 4. PROJECTS TABLE
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.projects (
  -- Primary identifier (app-generated, prefixed e.g. "project_builder_...")
  id                 text        PRIMARY KEY,

  -- ID of the backing Job record once an inquiry converts to a job.
  -- Empty string when no job has been created yet (builder-origin projects).
  source_job_id      text        NOT NULL DEFAULT '',

  title              text        NOT NULL DEFAULT '',
  customer           text        NOT NULL DEFAULT '',

  -- Display name of the assigned craftsman; empty until a craftsman accepts
  craftsman          text        NOT NULL DEFAULT '',

  location           text        NOT NULL DEFAULT '',

  -- Formatted date/time label, e.g. "Termin offen" or "15.06.2024, 10:00 Uhr"
  date_label         text        NOT NULL DEFAULT 'Termin offen',

  -- Agreed price label, e.g. "2.300 €". Empty until a proposal is accepted.
  price              text        NOT NULL DEFAULT '',

  -- Project lifecycle status. Allowed values:
  --   request | accepted | scheduled | in_progress | review | completed
  status             text        NOT NULL DEFAULT 'request',

  -- Payment lifecycle state. Mirrors PaymentState union in coreTypes.
  payment_state      text        NOT NULL DEFAULT 'deposit_required',

  message_count      integer     NOT NULL DEFAULT 0,
  note_count         integer     NOT NULL DEFAULT 0,
  photo_count        integer     NOT NULL DEFAULT 0,

  -- Timestamps stored as timestamptz; the domain layer uses millisecond
  -- epoch numbers internally and the repository converts on read/write.
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Optional structured fields set by the builder / inquiry flows
  source             text,       -- 'builder' | 'inquiry' | 'direct'
  category           text,       -- e.g. 'Elektrik', 'Bad'
  description        text,
  requested_budget   text,       -- e.g. 'unter 2.000 €'
  requested_timing   text        -- e.g. 'Innerhalb 4 Wochen'
);

-- ---------------------------------------------------------------------------
-- 5. PROJECTS – indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_projects_status
  ON public.projects (status);

CREATE INDEX IF NOT EXISTS idx_projects_source_job_id
  ON public.projects (source_job_id);
