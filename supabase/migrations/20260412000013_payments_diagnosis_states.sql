-- =============================================================================
-- Migration: Add diagnosis payment states to payments.status CHECK constraint
-- =============================================================================
--
-- Diagnosis instant-payment introduces two new PaymentState values:
--   diagnosis_payment_pending   — diagnosis fee awaiting customer payment
--   diagnosis_payment_completed — diagnosis fee successfully charged
--
-- These states follow a separate path from the standard escrow corridor:
--   diagnosis_payment_pending → diagnosis_payment_completed (or refunded)
--
-- The existing CHECK constraint from migration 20260412000001 must be widened.
-- Using DROP + ADD to replace the constraint cleanly.
--
-- Applied: 2026-04-12 (Paket 4d — Diagnosis instant-payment path)
-- =============================================================================

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_status_check
    CHECK (status IN (
      -- Standard escrow corridor
      'none',
      'deposit_required', 'deposit_paid', 'in_escrow',
      'work_in_progress', 'release_pending', 'released',
      'disputed', 'refunded',
      -- Legacy Stripe-phase states (retained for backward compat)
      'pending', 'requires_payment_method', 'requires_confirmation',
      'processing', 'authorized', 'escrowed', 'captured',
      'partially_refunded', 'failed', 'cancelled',
      -- Diagnosis instant-payment path (Paket 4d)
      'diagnosis_payment_pending',
      'diagnosis_payment_completed'
    ));
