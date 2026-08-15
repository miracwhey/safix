-- ============================================================================
-- Migration: thread_artifacts — Add invoice artifact type
-- ============================================================================
--
-- Expands the thread_artifacts CHECK constraint to include 'invoice' as a
-- valid artifact_type.  Each Invoice (Rechnung) that is sent to the customer
-- produces an append-only artifact record in the thread, similar to how
-- change_order and project cards work (multiple per conversation, keyed to the
-- invoice id, no uniqueness constraint).
--
-- Also adds an invoice_id column so the artifact record carries its canonical
-- Invoice identifier directly — the client selector needs this to load the live
-- Invoice entity and render the Rechnung card.
--
-- Participant scoping (customer_user_id / craftsman_user_id) and RLS are
-- artifact_type-agnostic (base migration 20260323000002), so no policy change
-- is required for the new type.
--
-- ── Expand CHECK constraint ───────────────────────────────────────────────

DO $$
BEGIN
  ALTER TABLE thread_artifacts DROP CONSTRAINT IF EXISTS thread_artifacts_artifact_type_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$$;

ALTER TABLE thread_artifacts
  ADD CONSTRAINT thread_artifacts_artifact_type_check
  CHECK (artifact_type IN ('project', 'offer', 'payment_phase', 'funding_step', 'change_order', 'invoice'));

-- ── Add invoice_id column ─────────────────────────────────────────────────
-- Nullable FK to invoices.id.  Only set for artifactType='invoice'.
-- ON DELETE CASCADE: if the Invoice is deleted (e.g. during rollback), the
-- artifact record is automatically removed.

ALTER TABLE thread_artifacts
  ADD COLUMN IF NOT EXISTS invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE;

-- ── Index for invoice lookups ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_thread_artifacts_invoice
  ON thread_artifacts(invoice_id)
  WHERE invoice_id IS NOT NULL;

-- ── PostgREST schema-cache reload ─────────────────────────────────────────

NOTIFY pgrst, 'reload schema';
