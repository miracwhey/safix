-- =============================================================================
-- Migration: Block 2 — State Machine Hardening
-- =============================================================================
-- Hardens status columns with CHECK constraints across the core domain objects.
--
-- Context:
--   - acceptances and change_orders tables were created in the same block
--     with CHECK constraints inline — no changes needed here for those.
--   - offers.status was already correct on remote (baseline included 7 values).
--   - jobs.status baseline had legacy values (draft/open/quoted/disputed) that
--     don't match the TypeScript JobStatus type — replaced here.
--   - payments.status baseline was missing 'none' and 'refunded' — added here.
--
-- Applied: 2026-04-12
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. jobs.status — replace legacy baseline CHECK with TypeScript JobStatus values
--    Baseline had: draft, open, quoted, booked, in_progress, completed, cancelled, disputed
--    TypeScript:   new, booked, scheduled, in_progress, waiting_payment, completed, cancelled
--    Live data at migration time: only booked, in_progress (safe to replace)
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_status_check
    CHECK (status IN (
      'new', 'booked', 'scheduled', 'in_progress',
      'waiting_payment', 'completed', 'cancelled'
    ));

-- ---------------------------------------------------------------------------
-- 2. payments.status — extend to include 'none' and 'refunded'
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_status_check
    CHECK (status IN (
      'none',
      'deposit_required', 'deposit_paid', 'in_escrow',
      'work_in_progress', 'release_pending', 'released',
      'disputed', 'refunded',
      'pending', 'requires_payment_method', 'requires_confirmation',
      'processing', 'authorized', 'escrowed', 'captured',
      'partially_refunded', 'failed', 'cancelled'
    ));
