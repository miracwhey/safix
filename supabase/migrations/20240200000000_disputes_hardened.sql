-- =============================================================================
-- Migration: Disputes – hardened schema for end-to-end payment consistency
-- =============================================================================
-- Creates the public.disputes table (if not already present) and adds all
-- columns required by SupabaseDisputeRepository, including the new fields
-- introduced in the hardening pass:
--   payment_id, raised_by, decision, split_ratio, resolved_split status.
--
-- Also creates public.dispute_status_history for full audit trail.
--
-- All statements use IF NOT EXISTS / DO blocks so the migration is idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. DISPUTES TABLE
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.disputes (
  -- Primary identifier (app-generated, e.g. "dispute_job-123_1700000000000")
  id                text        PRIMARY KEY,

  -- Foreign key to the job this dispute is about
  job_id            text        NOT NULL,

  -- Foreign key to the payment record at the time the dispute was opened.
  -- Nullable for backwards compatibility with disputes opened before this column.
  payment_id        text,

  -- Supabase auth.users UUID (or equivalent) of the party who raised the dispute.
  raised_by         text,

  -- Dispute lifecycle status.
  -- Allowed values: open | awaiting_evidence | under_review |
  --                 resolved_release | resolved_refund | resolved_split | rejected
  status            text        NOT NULL DEFAULT 'open',

  -- Final decision recorded when the dispute is resolved.
  -- Allowed values: release | refund | split | reject
  decision          text,

  -- For split decisions: the fraction [0.0–1.0] of the total escrow released
  -- to the craftsman.  E.g. 0.7 → 70 % craftsman, 30 % customer refund.
  split_ratio       numeric(5, 4),

  -- Reason category for the dispute.
  -- Allowed: work_quality | scope_conflict | delay | payment_conflict | other
  reason            text        NOT NULL DEFAULT 'other',

  -- Short summary displayed in dispute lists
  title             text        NOT NULL DEFAULT '',

  -- Full human-readable description of the dispute
  description       text        NOT NULL DEFAULT '',

  -- Unix timestamps in milliseconds (bigint, not timestamptz)
  created_at        bigint      NOT NULL,
  updated_at        bigint      NOT NULL,
  resolved_at       bigint,

  -- JSONB array of DisputeEvidence objects (embedded for simplicity)
  -- { id, disputeId, jobId, type, description, url?, submittedAt, submittedBy }
  evidence          jsonb
);

-- ---------------------------------------------------------------------------
-- 2. DISPUTES – add columns that may not exist in pre-hardening deployments
-- ---------------------------------------------------------------------------

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS payment_id  text,
  ADD COLUMN IF NOT EXISTS raised_by   text,
  ADD COLUMN IF NOT EXISTS decision    text,
  ADD COLUMN IF NOT EXISTS split_ratio numeric(5, 4);

-- ---------------------------------------------------------------------------
-- 3. DISPUTES – indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_disputes_job_id
  ON public.disputes (job_id);

CREATE INDEX IF NOT EXISTS idx_disputes_status
  ON public.disputes (status);

CREATE INDEX IF NOT EXISTS idx_disputes_payment_id
  ON public.disputes (payment_id)
  WHERE payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. DISPUTES – Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- Craftsmen and customers can read disputes for their own jobs.
-- Platform admins (service_role key) bypass RLS entirely.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'disputes'
      AND policyname = 'disputes_select_own'
  ) THEN
    CREATE POLICY disputes_select_own
      ON public.disputes
      FOR SELECT
      USING (
        -- Allow the row's raised_by user, or any authenticated user for now.
        -- Tighten this to job-ownership once auth.users → jobs linkage is stable.
        auth.role() = 'authenticated'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'disputes'
      AND policyname = 'disputes_insert_own'
  ) THEN
    CREATE POLICY disputes_insert_own
      ON public.disputes
      FOR INSERT
      WITH CHECK (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'disputes'
      AND policyname = 'disputes_update_own'
  ) THEN
    CREATE POLICY disputes_update_own
      ON public.disputes
      FOR UPDATE
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. DISPUTE STATUS HISTORY TABLE – audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.dispute_status_history (
  -- Auto-generated surrogate key
  id            bigserial   PRIMARY KEY,

  -- The dispute this history entry belongs to
  dispute_id    text        NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,

  -- Job ID (denormalised for query convenience)
  job_id        text        NOT NULL,

  -- Status the dispute transitioned FROM
  from_status   text        NOT NULL,

  -- Status the dispute transitioned TO
  to_status     text        NOT NULL,

  -- The user who triggered the transition (auth.uid() or system)
  changed_by    text,

  -- Optional free-text note (e.g. admin reason for rejection)
  note          text,

  -- Unix timestamp in milliseconds of when the transition occurred
  occurred_at   bigint      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dispute_status_history_dispute_id
  ON public.dispute_status_history (dispute_id);

CREATE INDEX IF NOT EXISTS idx_dispute_status_history_job_id
  ON public.dispute_status_history (job_id);

-- ---------------------------------------------------------------------------
-- 6. DISPUTE STATUS HISTORY – Row Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE public.dispute_status_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'dispute_status_history'
      AND policyname = 'dispute_history_select'
  ) THEN
    CREATE POLICY dispute_history_select
      ON public.dispute_status_history
      FOR SELECT
      USING (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'dispute_status_history'
      AND policyname = 'dispute_history_insert'
  ) THEN
    CREATE POLICY dispute_history_insert
      ON public.dispute_status_history
      FOR INSERT
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. JOBS TABLE – add dispute_status column
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS dispute_status text;

COMMENT ON COLUMN public.jobs.dispute_status IS
  'Current dispute lifecycle status for this job. '
  'Allowed: open | under_review | resolved_refund | resolved_release | '
  'resolved_split | rejected. NULL when no dispute has been opened.';
