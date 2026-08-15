-- =============================================================================
-- Migration: Ledger Entries – DB-level deduplication constraint
-- =============================================================================
-- Adds a partial unique index on public.ledger_entries (payment_id, type) for
-- all non-repeating entry types.
--
-- Background: The application already enforces deduplication via the
-- NON_REPEATING_TYPES guard in src/lib/payments/ledger/ledgerService.ts,
-- which checks for an existing entry before inserting. However, under concurrent
-- webhook delivery or network-level retries the in-memory guard can be raced,
-- allowing two simultaneous inserts of the same (payment_id, type) pair to
-- land in Supabase before either read confirms the other.
--
-- This partial unique index provides the DB-level guarantee that closes the
-- race window. It covers exactly the same nine types listed in NON_REPEATING_TYPES
-- so that the constraint and the app guard remain in sync.
--
-- Non-repeating types (one entry per payment):
--   escrow_created          – emitted when escrow is opened
--   deposit_paid            – emitted when the 25 % deposit is captured
--   final_paid              – emitted when the 75 % final payment is captured
--   platform_fee            – 12 % platform cut on release
--   payout                  – 88 % payout to the craftsman
--   refund                  – full refund to customer
--   dispute_hold            – escrow freeze when a dispute is opened
--   dispute_resolved_release – craftsman share after a split resolution
--   dispute_resolved_refund  – customer share after a split resolution
--
-- Using a PARTIAL index (WHERE type IN (...)) rather than a full unique index
-- preserves the ability to add repeatable entry types (e.g. adjustment entries)
-- in the future without altering this constraint.
--
-- The index is created with IF NOT EXISTS so this migration is idempotent.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_payment_type_nonrepeating
  ON public.ledger_entries (payment_id, type)
  WHERE type IN (
    'escrow_created',
    'deposit_paid',
    'final_paid',
    'platform_fee',
    'payout',
    'refund',
    'dispute_hold',
    'dispute_resolved_release',
    'dispute_resolved_refund'
  );
