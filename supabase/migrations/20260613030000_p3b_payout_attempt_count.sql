-- =============================================================================
-- Migration: Block P · P3b — escrow_tranches.payout_attempt_count
-- =============================================================================
-- WHY
--   The P3b hourly reconcile-payout-corridor cron re-attempts payouts that hit
--   Stripe's `balance_insufficient` (destination-charge funds stay ~7 days
--   pending). Stripe CACHES the 4xx idempotency response for a given key, so a
--   re-attempt that reuses the stable key `tranche_payout_<trancheId>` would
--   just replay the cached failure and never pay. The cron therefore needs the
--   release-tranche payout key to VARY across attempts:
--       idempotencyKey = `tranche_payout_<trancheId>_<payout_attempt_count>`
--
--   This column is the money-SAFE varying component (vs a naive time-bucket
--   suffix). It is incremented ONLY by paths that know the prior attempt
--   DEFINITIVELY will not pay:
--       1. release-tranche.ts  — the `balance_insufficient` soft-fail branch
--          (provably NO payout was created → re-keying cannot double-pay).
--       2. stripe-webhook.ts   — the payout.failed corridor revert
--          (the created payout bank-FAILED and will never pay on its po id).
--   It is NEVER incremented on the success path. So on the RPC-write-failed
--   split-brain (payout CREATED on Stripe, then release_tranche_with_ledger
--   failed → tranche stuck at eligible_for_release, external_payout_ref NULL),
--   the counter is UNCHANGED → the next cron re-attempt replays the SAME
--   idempotency key → Stripe returns the existing payout, no second payout.
--   A time-bucket key would mint a fresh key here and DOUBLE-PAY — that split-
--   brain recovery is P5/out-of-scope, so the column is the correct choice.
--
-- WHAT
--   escrow_tranches.payout_attempt_count integer NOT NULL DEFAULT 0.
--
-- 0-row-safe: escrow tables are empty on prod (verified live 2026-06-13 in the
-- 20260613020000 header). Additive, idempotent (ADD COLUMN IF NOT EXISTS), no
-- behavioral effect on the transfer corridor (it never reads the counter).
--
-- DOES NOT touch prod. Gated — apply is a separate, explicitly-confirmed step.
-- =============================================================================

ALTER TABLE public.escrow_tranches
  ADD COLUMN IF NOT EXISTS payout_attempt_count integer NOT NULL DEFAULT 0;

-- Refresh PostgREST's schema cache so the new column is immediately selectable
-- by the service-role client (release-tranche SELECT projection / cron).
NOTIFY pgrst, 'reload schema';
