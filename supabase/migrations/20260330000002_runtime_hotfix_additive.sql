-- =============================================================================
-- Runtime hotfix: minimal additive catch-up for live testing
-- =============================================================================
-- Purpose:
--   Add only the confirmed live blocker columns needed to continue real runtime
--   testing safely, without rewriting existing table models or status semantics.
--
-- Confirmed blockers addressed here:
--   1. public.projects.customer_user_id
--   2. public.projects.payment_state
--   3. public.payments.deposit_amount
--
-- Safety:
--   - additive only
--   - no renames
--   - no type changes
--   - no destructive changes
--   - idempotent via IF NOT EXISTS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROJECTS
-- ---------------------------------------------------------------------------
-- customer_user_id:
--   Current code/repository direction expects customer_user_id on projects.
-- payment_state:
--   Written directly by server-side webhook and reconciliation paths.
--   Missing this column causes downstream project payment mirror writes to fail.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS customer_user_id uuid,
  ADD COLUMN IF NOT EXISTS payment_state text NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS idx_projects_customer_user_id
  ON public.projects (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_payment_state
  ON public.projects (payment_state);

-- ---------------------------------------------------------------------------
-- PAYMENTS
-- ---------------------------------------------------------------------------
-- deposit_amount:
--   Confirmed live runtime blocker during accept/payment-init path.
--   Added as numeric to match the code/domain expectation without changing any
--   existing payment status semantics.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS deposit_amount numeric;

CREATE INDEX IF NOT EXISTS idx_payments_deposit_amount
  ON public.payments (deposit_amount);

-- =============================================================================
-- End runtime hotfix
-- =============================================================================
