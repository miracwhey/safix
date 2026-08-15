-- Migration: payments – add refunded_amount column
--
-- Stores the actual EUR amount confirmed refunded by Stripe (from
-- charge.amount_refunded / 100).  NULL until the payment reaches
-- 'refunded' state.  Distinguishes partial from full refunds and
-- provides a single-row answer to "how much did Stripe actually refund?"
-- without requiring a ledger join.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(12, 2);
