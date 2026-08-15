-- =============================================================================
-- Migration: Add 'cost_estimate' to offers.document_type CHECK constraint
-- =============================================================================
--
-- Paket 1+ introduced 'cost_estimate' (Kostenvoranschlag) as a fourth
-- commercial document type alongside estimate, binding_offer, and diagnosis.
--
-- The existing CHECK constraint from migration 20260412000004 must be widened.
-- Using DROP + ADD to replace the constraint cleanly.
--
-- Applied: 2026-04-12 (Paket 1+ — cost_estimate document type)
-- =============================================================================

ALTER TABLE public.offers
  DROP CONSTRAINT IF EXISTS offers_document_type_check;

ALTER TABLE public.offers
  ADD CONSTRAINT offers_document_type_check
    CHECK (document_type IS NULL OR document_type IN (
      'estimate',
      'cost_estimate',
      'binding_offer',
      'diagnosis'
    ));

COMMENT ON COLUMN public.offers.document_type IS
  'Leading commercial document type (Paket 1+). '
  '''binding_offer'' (verbindliches Angebot, standard escrow) | '
  '''estimate'' (unverbindliche Schätzung, no payment) | '
  '''cost_estimate'' (Kostenvoranschlag, no payment) | '
  '''diagnosis'' (Diagnose-Einsatz, own instant-payment path). '
  'NULL rows are resolved to ''binding_offer'' by the domain layer for backward compatibility.';
