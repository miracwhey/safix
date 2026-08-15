-- =============================================================================
-- Migration: Offer.sourceDiagnosisId — Paket 4d Diagnosis → Follow-up Offer
-- =============================================================================
--
-- Introduces source_diagnosis_id column to the `offers` table.
--
--   source_diagnosis_id — ID of the diagnosis offer this binding_offer was
--                         created from. NULL for all offers not created as
--                         follow-up to a diagnosis. Provides an explicit audit
--                         trail: "this offer originated from that diagnosis."
--
-- Semantics:
--   - Only set on binding_offer documents that follow a completed diagnosis
--   - Does NOT transfer diagnosis semantics or payment rules to the new offer
--   - The referenced diagnosis offer remains intact and is never mutated
--   - FK is soft (no hard FK constraint) — diagnosis offer may be archived
--
-- Backward compatibility:
--   - NULL for all existing rows (pre-Paket-4d)
--   - Domain layer treats NULL as "not a follow-up offer"
--   - No backfill required
--
-- Applied: 2026-04-12 (Paket 4d — Diagnosis → Follow-up Offer Transition)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add source_diagnosis_id column (nullable, no FK — soft reference)
-- ---------------------------------------------------------------------------
ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS source_diagnosis_id text;

COMMENT ON COLUMN public.offers.source_diagnosis_id IS
  'ID of the diagnosis offer this binding_offer was created from (Paket 4d). '
  'NULL for all offers not created as a follow-up to a diagnosis. '
  'Soft reference — no FK constraint. '
  'Provides audit trail: diagnosis → follow-up binding_offer.';

-- ---------------------------------------------------------------------------
-- 2. Add index for reverse lookup: "which follow-up offers came from this
--    diagnosis?" — used for traceability queries and display hints.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS offers_source_diagnosis_id_idx
  ON public.offers (source_diagnosis_id)
  WHERE source_diagnosis_id IS NOT NULL;
