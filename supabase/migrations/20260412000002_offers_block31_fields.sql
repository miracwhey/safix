-- =============================================================================
-- Block 3.1 — Offer commercial substance fields
--
-- craftsman_name_snapshot: frozen craftsman identity at send time.
--   Required for the offer to be self-contained as a standalone document.
--
-- vat_included: whether the stated price/grossTotal is brutto (VAT included).
--   true (default) = brutto price; false = netto price (VAT added on top).
--   NULL treated as true at application layer.
--
-- evidence_media_ids: JSON array of media IDs used as context for this offer.
--   Stored as TEXT (JSON array) to avoid JSONB column proliferation.
-- =============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS craftsman_name_snapshot TEXT;

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS vat_included BOOLEAN;

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS evidence_media_ids TEXT;
