-- =============================================================================
-- Migration: offers.offer_mode — OfferMode field for binding/estimate distinction
-- =============================================================================
-- Adds the `offer_mode` column to the `offers` table.
--
-- Domain role:
--   OfferMode distinguishes between a non-binding estimate (Schätzung /
--   unverbindlicher Richtpreis) and a binding offer (verbindliches Angebot /
--   Kostenvoranschlag).
--
--   'binding'  — Verbindliches Angebot. Default for all existing and new offers.
--                Acceptance creates a Job and unlocks the payment corridor.
--   'estimate' — Unverbindliche Schätzung. Carries commercial context but does
--                not unlock escrow funding. Cannot be accepted to create a Job.
--
-- Backward compatibility:
--   The column is nullable; NULL is treated as 'binding' in the domain layer
--   (SupabaseOfferRepository.rowToOffer: null → 'binding').
--   Existing offers are unaffected.
-- =============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS offer_mode text;

COMMENT ON COLUMN public.offers.offer_mode IS
  '''binding'' (default, verbindliches Angebot) | ''estimate'' (unverbindliche Schätzung). '
  'NULL is treated as ''binding'' for backward compatibility. '
  'Only binding offers unlock the payment corridor on acceptance.';

-- Optional: backfill existing rows (safe no-op if already set)
UPDATE public.offers
  SET offer_mode = 'binding'
  WHERE offer_mode IS NULL;
