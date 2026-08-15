-- =============================================================================
-- Migration: disputes.context_snapshot — persist dispute open-time snapshot
-- =============================================================================
-- Adds the context_snapshot JSONB column to the disputes table.
--
-- This column is written by SupabaseDisputeRepository.disputeToRow() and read
-- by rowToDispute() as a DisputeContextSnapshot object.  Without this column
-- the snapshot is silently dropped on every reload (write-only persistence).
--
-- The column is nullable for backward compatibility — disputes opened before
-- this migration have NULL and will have contextSnapshot === undefined in domain
-- objects (the existing backward-compat comment in types.ts covers this).
-- =============================================================================

ALTER TABLE public.disputes
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb;

COMMENT ON COLUMN public.disputes.context_snapshot IS
  'Snapshot of job and payment context captured at dispute open time. '
  'Contains: jobTitle, jobDescription, craftsmanUserId, customerUserId, '
  'sourceConversationId, sourceOfferId, paymentStateAtOpen, paymentTotalAmount, '
  'snapshotAt. NULL for disputes opened before Block 7 hardening.';
