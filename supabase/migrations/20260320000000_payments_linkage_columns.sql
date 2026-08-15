-- =============================================================================
-- Migration: Payments linkage metadata
-- =============================================================================
-- Adds relational context columns to `public.payments` so each payment can be
-- tied back to the originating job, project, customer, craftsman, and offer.
-- Columns are nullable to remain backwards compatible with existing rows.
-- =============================================================================

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS project_id text,
  ADD COLUMN IF NOT EXISTS customer_user_id text,
  ADD COLUMN IF NOT EXISTS craftsman_user_id text,
  ADD COLUMN IF NOT EXISTS offer_id text;

-- Index to quickly fetch payments for a customer user across jobs/projects.
CREATE INDEX IF NOT EXISTS idx_payments_customer_user_id
  ON public.payments (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

-- Index to quickly fetch payments for a craftsman user.
CREATE INDEX IF NOT EXISTS idx_payments_craftsman_user_id
  ON public.payments (craftsman_user_id)
  WHERE craftsman_user_id IS NOT NULL;

