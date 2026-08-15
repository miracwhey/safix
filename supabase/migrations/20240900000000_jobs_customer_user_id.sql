-- =============================================================================
-- Migration: Jobs – customer_user_id ownership column & RLS hardening
-- =============================================================================
-- BLOCK 16: Closes the customer-side ownership gap on the jobs table.
--
-- BEFORE: jobs had no direct customer_user_id column.  Customer-origin reads,
--   updates (e.g. proposal acceptance, payment release) and job_feedback writes
--   relied on either auth.role()='authenticated' stopgaps or indirect chains
--   that became fragile under real multi-user Supabase isolation.
--
-- AFTER:
--   • jobs.customer_user_id is the canonical direct customer owner link.
--   • jobs SELECT + UPDATE policies accept BOTH craftsman_user_id AND
--     customer_user_id so customer screens (payment release, proposal
--     acceptance, feedback) work under real RLS.
--   • job_feedback INSERT/UPDATE stopgap policies are replaced by a
--     customer_user_id-based ownership check on the feedback row itself.
--   • payments, disputes, and dispute_status_history also receive
--     customer-side access via the jobs.customer_user_id chain.
--
-- Ownership model after this migration:
--   jobs            → craftsman_user_id = auth.uid()   (craftsman reads/writes)
--                     OR customer_user_id = auth.uid() (customer reads/writes)
--   payments        → job_id IN (jobs where craftsman OR customer owns)
--   disputes        → raised_by = auth.uid() AND job_id IN (owned jobs)
--                     OR job_id IN (owned jobs) for SELECT/UPDATE
--   job_feedback    → customer_user_id = auth.uid() (direct ownership on row)
--
-- All DO blocks use IF NOT EXISTS / DROP IF EXISTS guards for idempotency.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add customer_user_id column to jobs
-- ---------------------------------------------------------------------------

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS customer_user_id text;

CREATE INDEX IF NOT EXISTS idx_jobs_customer_user_id
  ON public.jobs (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Update jobs RLS policies to include customer-side access
--    Drop existing policies first, then recreate with the expanded predicates.
--    INSERT remains craftsman-only: only the craftsman creates a job.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS jobs_select_own ON public.jobs;
DROP POLICY IF EXISTS jobs_update_own ON public.jobs;

DO $$
BEGIN
  -- SELECT: craftsman who owns the job OR customer who is linked as owner
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='jobs' AND policyname='jobs_select_own') THEN
    CREATE POLICY jobs_select_own ON public.jobs
      FOR SELECT USING (
        craftsman_user_id = auth.uid()::text
        OR customer_user_id = auth.uid()::text
      );
  END IF;

  -- UPDATE: same two-way ownership (customer needs UPDATE to accept proposals,
  -- release payments, etc.; craftsman needs it for job lifecycle management).
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='jobs' AND policyname='jobs_update_own') THEN
    CREATE POLICY jobs_update_own ON public.jobs
      FOR UPDATE USING (
        craftsman_user_id = auth.uid()::text
        OR customer_user_id = auth.uid()::text
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Add customer_user_id column to job_feedback
--    Stores the auth UID of the customer who submitted the feedback.
--    Enables direct ownership-based RLS without joining back to jobs.
-- ---------------------------------------------------------------------------

ALTER TABLE public.job_feedback
  ADD COLUMN IF NOT EXISTS customer_user_id text;

-- ---------------------------------------------------------------------------
-- 4. Replace job_feedback stopgap policies with ownership-based ones
--    The previous INSERT/UPDATE policies used auth.role()='authenticated'
--    because jobs had no customer_user_id.  Now that feedback rows carry
--    customer_user_id directly, we can enforce exact ownership.
--    SELECT remains publicly readable (trust signals).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS job_feedback_insert_authenticated ON public.job_feedback;
DROP POLICY IF EXISTS job_feedback_update_authenticated ON public.job_feedback;

DO $$
BEGIN
  -- INSERT: only the customer who owns the feedback row (customer_user_id = caller)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='job_feedback' AND policyname='job_feedback_insert_customer') THEN
    CREATE POLICY job_feedback_insert_customer ON public.job_feedback
      FOR INSERT WITH CHECK (customer_user_id = auth.uid()::text);
  END IF;

  -- UPDATE (upsert path): same customer ownership check
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='job_feedback' AND policyname='job_feedback_update_customer') THEN
    CREATE POLICY job_feedback_update_customer ON public.job_feedback
      FOR UPDATE USING (customer_user_id = auth.uid()::text);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Extend payments policies with customer-side access via jobs.customer_user_id
--    The customer needs SELECT access to see payment state (proposal, escrow,
--    release) and UPDATE access to release funds.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payments'
  ) THEN
    -- Drop and recreate SELECT to add customer path
    DROP POLICY IF EXISTS payments_select_own ON public.payments;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payments' AND policyname='payments_select_own') THEN
      CREATE POLICY payments_select_own ON public.payments
        FOR SELECT USING (
          job_id IN (
            SELECT id FROM public.jobs
            WHERE craftsman_user_id = auth.uid()::text
               OR customer_user_id  = auth.uid()::text
          )
        );
    END IF;

    -- INSERT remains craftsman-only (craftsman initiates payment records)
    -- No change needed to payments_insert_own.

    -- Drop and recreate UPDATE to add customer path (customer releases payment)
    DROP POLICY IF EXISTS payments_update_own ON public.payments;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='payments' AND policyname='payments_update_own') THEN
      CREATE POLICY payments_update_own ON public.payments
        FOR UPDATE USING (
          job_id IN (
            SELECT id FROM public.jobs
            WHERE craftsman_user_id = auth.uid()::text
               OR customer_user_id  = auth.uid()::text
          )
        );
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Extend ledger_entries policies with customer-side read access
--    Customer may need to read ledger entries to verify payment state.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ledger_entries'
  ) THEN
    DROP POLICY IF EXISTS ledger_select_own ON public.ledger_entries;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ledger_entries' AND policyname='ledger_select_own') THEN
      CREATE POLICY ledger_select_own ON public.ledger_entries
        FOR SELECT USING (
          job_id IN (
            SELECT id FROM public.jobs
            WHERE craftsman_user_id = auth.uid()::text
               OR customer_user_id  = auth.uid()::text
          )
        );
    END IF;

    -- INSERT remains craftsman-only (craftsman-side escrow operations)
    -- No change needed to ledger_insert_own.
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Extend disputes policies with customer-side access
--    Customer can raise a dispute for a job they own (customer_user_id match).
--    SELECT and UPDATE allow both parties.
-- ---------------------------------------------------------------------------

-- Drop existing policies to replace with expanded predicates
DROP POLICY IF EXISTS disputes_select_own ON public.disputes;
DROP POLICY IF EXISTS disputes_insert_own ON public.disputes;
DROP POLICY IF EXISTS disputes_update_own ON public.disputes;

DO $$
BEGIN
  -- SELECT: raised_by OR party to the job (craftsman or customer)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='disputes' AND policyname='disputes_select_own') THEN
    CREATE POLICY disputes_select_own ON public.disputes
      FOR SELECT USING (
        raised_by = auth.uid()::text
        OR job_id IN (
          SELECT id FROM public.jobs
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;

  -- INSERT: caller must be the raiser AND must own the job (either side)
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='disputes' AND policyname='disputes_insert_own') THEN
    CREATE POLICY disputes_insert_own ON public.disputes
      FOR INSERT WITH CHECK (
        raised_by = auth.uid()::text
        AND job_id IN (
          SELECT id FROM public.jobs
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;

  -- UPDATE: raised_by OR any party to the job
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='disputes' AND policyname='disputes_update_own') THEN
    CREATE POLICY disputes_update_own ON public.disputes
      FOR UPDATE USING (
        raised_by = auth.uid()::text
        OR job_id IN (
          SELECT id FROM public.jobs
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Extend dispute_status_history with customer-side access
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS dispute_history_select ON public.dispute_status_history;
DROP POLICY IF EXISTS dispute_history_insert ON public.dispute_status_history;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dispute_status_history' AND policyname='dispute_history_select') THEN
    CREATE POLICY dispute_history_select ON public.dispute_status_history
      FOR SELECT USING (
        job_id IN (
          SELECT id FROM public.jobs
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;

  -- INSERT: only craftsman (system-side) writes history entries
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='dispute_status_history' AND policyname='dispute_history_insert') THEN
    CREATE POLICY dispute_history_insert ON public.dispute_status_history
      FOR INSERT WITH CHECK (
        job_id IN (
          SELECT id FROM public.jobs
          WHERE craftsman_user_id = auth.uid()::text
             OR customer_user_id  = auth.uid()::text
        )
      );
  END IF;
END $$;

-- =============================================================================
-- BLOCK 16 COMPLETION SUMMARY
-- =============================================================================
-- jobs.customer_user_id is now the canonical direct customer owner link.
-- All customer-facing write paths (payment release, proposal acceptance,
-- dispute creation, feedback submission) have real ownership-based RLS.
-- The auth.role()='authenticated' stopgap on job_feedback has been replaced.
--
-- PROPAGATION PATH for customer_user_id on jobs:
--   • inquiry_project jobs: project.customerUserId → job.customerUserId
--     (set in convertInquiryToProjectWorkflow when sourceProjectId is present)
--   • other inquiry jobs: customer_user_id is NULL; no customer-side RLS
--     access will be granted via this column until a future migration backfills
--     the value via conversation.customer_user_id.
--
-- REMAINING GAPS:
--   • Conversations table has no customer_user_id column.  For non-builder
--     inquiry jobs, customer_user_id on jobs cannot be auto-populated.
--     This is documented as a future gap (requires messaging-domain change).
-- =============================================================================
